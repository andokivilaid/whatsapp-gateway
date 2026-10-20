import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * One person, two addresses.
 *
 * WhatsApp's privacy addressing reports a 1:1 contact as `<n>@lid`, while a
 * send to their number goes out as `<phone>@s.whatsapp.net`. Stored as-is, a
 * single conversation splits into two chats: our sends under the phone JID,
 * their replies under the LID. Everything the gateway persists is therefore
 * keyed by the phone JID whenever the pairing is known; the LID is kept only as
 * an alias in `whatsapp_jid_aliases`.
 *
 * Pairings are learned from every place WhatsApp reveals them: the alternate
 * addressing on message keys (`remoteJidAlt`, `participantAlt`), history-sync
 * conversations (`pnJid`/`lidJid`), contacts (`lid`/`phoneNumber`), call
 * offers (`callerPn`), `lid-mapping.update` and, as a last resort, Baileys'
 * own LID store.
 */

export type LidPair = { lid: string; pn: string };
export type LidLookup = (lid: string) => Promise<string | null | undefined>;

type Db = Pick<PrismaClient, '$transaction' | 'whatsAppJidAlias'>;
type Tx = Prisma.TransactionClient;

export function isLidJid(jid: string | null | undefined): jid is string {
  return !!jid && jid.endsWith('@lid');
}

export function isPhoneJid(jid: string | null | undefined): jid is string {
  return !!jid && jid.endsWith('@s.whatsapp.net');
}

/** `1234:5@lid` → `1234@lid`. Device suffixes never identify a person. */
export function userJid(jid: string): string {
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  return `${jid.slice(0, at).split(':')[0]}${jid.slice(at)}`;
}

/** Accepts a bare number, `+372…`, or a JID; returns a user-level phone JID or null. */
export function phoneJidFrom(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.includes('@')) {
    const jid = userJid(value);
    return isPhoneJid(jid) ? jid : null;
  }
  const digits = value.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
}

/** The pairing two addresses form, if one is a LID and the other a phone JID. */
export function pairOf(a: string | null | undefined, b: string | null | undefined): LidPair | null {
  if (!a || !b) return null;
  const normalize = (value: string) => (value.includes('@') ? userJid(value) : phoneJidFrom(value));
  const x = normalize(a);
  const y = normalize(b);
  if (isLidJid(x) && isPhoneJid(y)) return { lid: x, pn: y };
  if (isLidJid(y) && isPhoneJid(x)) return { lid: y, pn: x };
  return null;
}

type KeyLike = {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
};

/** Every LID↔phone pairing a message key reveals (chat and, in groups, sender). */
export function pairsFromKey(key: KeyLike | null | undefined): LidPair[] {
  if (!key) return [];
  return [pairOf(key.remoteJid, key.remoteJidAlt), pairOf(key.participant, key.participantAlt)]
    .filter((pair): pair is LidPair => pair !== null);
}

/**
 * Re-key everything stored under `lid` onto `pn` and record the alias. Runs in
 * one transaction so a reader never sees a conversation half-moved. Safe to
 * repeat: a second run finds nothing under the LID and only touches the alias.
 */
export async function mergeLidIntoPhone(tx: Tx, accountId: string, pair: LidPair, source: string): Promise<void> {
  const { lid, pn } = pair;
  await tx.whatsAppJidAlias.upsert({
    where: { accountId_lid: { accountId, lid } },
    create: { accountId, lid, pnJid: pn, source },
    update: { pnJid: pn, source },
  });

  await tx.whatsAppMessage.updateMany({ where: { accountId, chatJid: lid }, data: { chatJid: pn } });
  await tx.whatsAppMessage.updateMany({ where: { accountId, senderJid: lid }, data: { senderJid: pn } });

  const lidChat = await tx.whatsAppChat.findUnique({ where: { accountId_jid: { accountId, jid: lid } } });
  if (lidChat) {
    const pnChat = await tx.whatsAppChat.findUnique({ where: { accountId_jid: { accountId, jid: pn } } });
    if (pnChat) {
      await tx.whatsAppChat.update({
        where: { accountId_jid: { accountId, jid: pn } },
        data: {
          name: pnChat.name ?? lidChat.name,
          unreadCount: pnChat.unreadCount + lidChat.unreadCount,
          metadata: mergeMetadata(lidChat.metadata, pnChat.metadata, lid),
        },
      });
    } else {
      await tx.whatsAppChat.create({
        data: {
          accountId,
          jid: pn,
          name: lidChat.name,
          unreadCount: lidChat.unreadCount,
          archived: lidChat.archived,
          metadata: mergeMetadata(lidChat.metadata, {}, lid),
          createdAt: lidChat.createdAt,
        },
      });
    }
    await tx.whatsAppChat.delete({ where: { accountId_jid: { accountId, jid: lid } } });
  }

  const lidContact = await tx.whatsAppContact.findUnique({ where: { accountId_jid: { accountId, jid: lid } } });
  const phoneNumber = pn.split('@')[0] ?? null;
  if (lidContact) {
    const pnContact = await tx.whatsAppContact.findUnique({ where: { accountId_jid: { accountId, jid: pn } } });
    if (pnContact) {
      await tx.whatsAppContact.update({
        where: { accountId_jid: { accountId, jid: pn } },
        data: {
          name: pnContact.name ?? lidContact.name,
          notify: pnContact.notify ?? lidContact.notify,
          phoneNumber,
          metadata: mergeMetadata(lidContact.metadata, pnContact.metadata, lid),
        },
      });
    } else {
      await tx.whatsAppContact.create({
        data: {
          accountId,
          jid: pn,
          name: lidContact.name,
          notify: lidContact.notify,
          phoneNumber,
          metadata: mergeMetadata(lidContact.metadata, {}, lid),
          createdAt: lidContact.createdAt,
        },
      });
    }
    await tx.whatsAppContact.delete({ where: { accountId_jid: { accountId, jid: lid } } });
  }
}

function mergeMetadata(older: Prisma.JsonValue, newer: Prisma.JsonValue, lid: string): Prisma.InputJsonValue {
  const a = older && typeof older === 'object' && !Array.isArray(older) ? older : {};
  const b = newer && typeof newer === 'object' && !Array.isArray(newer) ? newer : {};
  return { ...a, ...b, lid } as Prisma.InputJsonValue;
}

/**
 * Per-account resolver. Answers "which JID do we store this under" and absorbs
 * new pairings as WhatsApp reveals them. Holds a small in-memory cache; the
 * alias table is the source of truth, so every worker that may own the account
 * converges on the same mapping.
 */
export class JidIdentity {
  private readonly known = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly accountId: string,
    private readonly lookup?: LidLookup,
  ) {}

  /** The JID to store and emit for `jid`: phone JID when known, else unchanged (minus device suffix for users). */
  async canonical(jid: string | null | undefined): Promise<string | null> {
    if (!jid) return null;
    if (!isLidJid(jid) && !isPhoneJid(jid)) return jid;
    const user = userJid(jid);
    if (!isLidJid(user)) return user;

    const cached = this.known.get(user);
    if (cached) return cached;

    const alias = await this.db.whatsAppJidAlias.findUnique({
      where: { accountId_lid: { accountId: this.accountId, lid: user } },
      select: { pnJid: true },
    });
    if (alias) {
      this.known.set(user, alias.pnJid);
      return alias.pnJid;
    }

    if (this.lookup) {
      const found = phoneJidFrom(await this.lookup(user).catch(() => null));
      if (found) {
        await this.learn({ lid: user, pn: found }, 'lid-store');
        return found;
      }
    }
    return user;
  }

  /** Record a pairing. Returns true when it changed anything (new or re-pointed alias). */
  async learn(pair: LidPair | null, source: string): Promise<boolean> {
    if (!pair) return false;
    const lid = userJid(pair.lid);
    const pn = phoneJidFrom(pair.pn);
    if (!isLidJid(lid) || !pn) return false;
    if (this.known.get(lid) === pn) return false;

    const existing = await this.db.whatsAppJidAlias.findUnique({
      where: { accountId_lid: { accountId: this.accountId, lid } },
      select: { pnJid: true },
    });
    if (existing?.pnJid === pn) {
      this.known.set(lid, pn);
      return false;
    }
    await this.db.$transaction((tx) => mergeLidIntoPhone(tx, this.accountId, { lid, pn }, source));
    this.known.set(lid, pn);
    return true;
  }

  async learnAll(pairs: LidPair[], source: string): Promise<number> {
    let changed = 0;
    for (const pair of pairs) if (await this.learn(pair, source)) changed += 1;
    return changed;
  }
}

/** Resolve a JID from an API caller without a live socket (alias table only). */
export async function canonicalJidFor(
  db: Pick<PrismaClient, 'whatsAppJidAlias'>,
  accountId: string,
  jid: string,
): Promise<string> {
  if (!isLidJid(jid) && !isPhoneJid(jid)) return jid;
  const user = userJid(jid);
  if (!isLidJid(user)) return user;
  const alias = await db.whatsAppJidAlias.findUnique({
    where: { accountId_lid: { accountId, lid: user } },
    select: { pnJid: true },
  });
  return alias?.pnJid ?? user;
}
