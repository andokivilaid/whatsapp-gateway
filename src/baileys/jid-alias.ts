/**
 * One person, one chat.
 *
 * WhatsApp now addresses the same direct chat with two JIDs: the phone JID
 * (`<digits>@s.whatsapp.net`) and a LID (`<digits>@lid`). Sends we place to a
 * phone number are stored under the phone JID. Replies often arrive with
 * `key.remoteJid` set to the LID and `key.remoteJidAlt` set to the phone JID.
 * Treating those as different threads splits the conversation.
 *
 * The canonical chat JID is the phone JID when we know the pair, otherwise the
 * bare LID. Device suffixes (`123:4@s.whatsapp.net`) are stripped for direct
 * chats so a linked device is not a second thread. Groups, broadcasts, and
 * newsletters are never rewritten.
 */

export type JidKind = 'pn' | 'lid' | 'group' | 'other';

export type LidPnPair = { lid: string; pn: string };

export type JidMaps = {
  lidToPn: ReadonlyMap<string, string>;
  pnToLid?: ReadonlyMap<string, string>;
};

export type CanonicalJid = { jid: string; alternateJid: string | null };

const PN_DOMAINS = new Set(['s.whatsapp.net', 'c.us', 'hosted']);
const LID_DOMAINS = new Set(['lid', 'hosted.lid']);

/** WhatsApp group JIDs end in `@g.us`; everything else is not a group chat. */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

/** Drop a linked-device suffix: `1234:5@s.whatsapp.net` → `1234@s.whatsapp.net`. */
export function bareUserJid(jid: string): string {
  const at = jid.lastIndexOf('@');
  if (at <= 0) return jid;
  const user = jid.slice(0, at).split(':')[0] ?? '';
  const domain = jid.slice(at + 1);
  return `${user}@${domain}`;
}

export function jidKind(jid: string): JidKind {
  if (isGroupJid(jid)) return 'group';
  const at = jid.lastIndexOf('@');
  const domain = at >= 0 ? jid.slice(at + 1) : '';
  if (LID_DOMAINS.has(domain)) return 'lid';
  if (PN_DOMAINS.has(domain)) return 'pn';
  return 'other';
}

/** A LID/phone pair, or null when the two JIDs are not one of each. */
export function pairFromJids(left: string | null | undefined, right: string | null | undefined): LidPnPair | null {
  if (!left || !right) return null;
  const a = bareUserJid(left.trim());
  const b = bareUserJid(right.trim());
  const aKind = jidKind(a);
  const bKind = jidKind(b);
  if (aKind === 'lid' && bKind === 'pn') return { lid: a, pn: b };
  if (aKind === 'pn' && bKind === 'lid') return { lid: b, pn: a };
  return null;
}

export function normalizeLidPnPair(pair: { lid: string; pn: string } | null | undefined): LidPnPair | null {
  if (!pair?.lid || !pair.pn) return null;
  return pairFromJids(pair.lid, pair.pn);
}

export function dedupeLidPnPairs(pairs: Array<LidPnPair | null | undefined>): LidPnPair[] {
  const seen = new Set<string>();
  const result: LidPnPair[] = [];
  for (const pair of pairs) {
    const normalized = pair ? normalizeLidPnPair(pair) : null;
    if (!normalized) continue;
    const key = `${normalized.lid}\0${normalized.pn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function canonicalJid(jid: string, maps: JidMaps): CanonicalJid {
  const bare = bareUserJid(jid);
  const kind = jidKind(bare);
  switch (kind) {
    case 'lid': {
      const pn = maps.lidToPn.get(bare);
      return pn ? { jid: pn, alternateJid: bare } : { jid: bare, alternateJid: null };
    }
    case 'pn':
      return { jid: bare, alternateJid: maps.pnToLid?.get(bare) ?? null };
    case 'group':
    case 'other':
      return { jid, alternateJid: null };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Digits-only phone fields are accepted only beside a real LID, and never when
 * they are just that LID's user part. Stored contacts used to copy the LID
 * user into `phoneNumber`, which is not a phone.
 */
function loosePhoneJid(value: unknown, lidUser: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('@')) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null;
  if (lidUser && digits === lidUser) return null;
  return `${digits}@s.whatsapp.net`;
}

function pushPair(pairs: Array<LidPnPair | null>, left: string | null | undefined, right: string | null | undefined) {
  pairs.push(pairFromJids(left, right));
}

/**
 * Pairs that are explicitly alternate identifiers of one user. Quoted messages
 * and other nested JIDs are ignored so a reply does not glue two people together.
 */
export function lidPnPairsFromMessagePayload(payload: unknown): LidPnPair[] {
  const key = asRecord(asRecord(payload)?.key);
  if (!key) return [];
  const pairs: Array<LidPnPair | null> = [];
  pushPair(pairs, stringField(key, 'remoteJid'), stringField(key, 'remoteJidAlt'));
  pushPair(pairs, stringField(key, 'participant'), stringField(key, 'participantAlt'));
  pushPair(pairs, stringField(key, 'remoteJid'), stringField(key, 'senderPn'));
  pushPair(pairs, stringField(key, 'participant'), stringField(key, 'senderPn'));
  pushPair(pairs, stringField(key, 'senderLid'), stringField(key, 'senderPn'));
  return dedupeLidPnPairs(pairs);
}

export function lidPnPairsFromContact(contact: {
  id?: string | null;
  jid?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
}): LidPnPair[] {
  const id = contact.id ?? contact.jid ?? null;
  const pairs: Array<LidPnPair | null> = [];
  pushPair(pairs, id, contact.lid);
  pushPair(pairs, id, contact.phoneNumber);
  pushPair(pairs, contact.lid, contact.phoneNumber);
  const resolved = dedupeLidPnPairs(pairs);
  if (resolved.length > 0) return resolved;
  const lid = [id, contact.lid ?? null]
    .filter((value): value is string => Boolean(value?.includes('@')))
    .map((value) => bareUserJid(value))
    .find((value) => jidKind(value) === 'lid');
  if (!lid) return [];
  const pn = loosePhoneJid(contact.phoneNumber, lid.split('@')[0] ?? null);
  return pn ? [{ lid, pn }] : [];
}

export function lidPnPairsFromContactRecord(contact: {
  jid: string;
  phoneNumber?: string | null;
  metadata?: unknown;
}): LidPnPair[] {
  const meta = asRecord(contact.metadata);
  const jidIsLid = jidKind(bareUserJid(contact.jid)) === 'lid';
  return lidPnPairsFromContact({
    id: stringField(meta, 'id') ?? contact.jid,
    jid: contact.jid,
    lid: stringField(meta, 'lid') ?? (jidIsLid ? contact.jid : null),
    phoneNumber: stringField(meta, 'phoneNumber') ?? contact.phoneNumber ?? null,
  });
}

export function lidPnPairsFromChat(chat: {
  id?: string | null;
  pnJid?: string | null;
  lidJid?: string | null;
}): LidPnPair[] {
  const pairs: Array<LidPnPair | null> = [];
  pushPair(pairs, chat.id, chat.pnJid);
  pushPair(pairs, chat.id, chat.lidJid);
  pushPair(pairs, chat.lidJid, chat.pnJid);
  return dedupeLidPnPairs(pairs);
}

export function lidPnPairsFromChatMetadata(metadata: unknown): LidPnPair[] {
  const record = asRecord(metadata);
  if (!record) return [];
  return lidPnPairsFromChat({
    id: stringField(record, 'id'),
    pnJid: stringField(record, 'pnJid'),
    lidJid: stringField(record, 'lidJid'),
  });
}

export type BackfillMessage = {
  id: string;
  accountId: string;
  chatJid: string;
  senderJid: string | null;
  alternateChatJid: string | null;
};

export type BackfillChat = {
  accountId: string;
  jid: string;
  name: string | null;
  unreadCount: number;
  archived: boolean;
  alternateJid: string | null;
  metadata?: unknown;
};

export type BackfillContact = {
  accountId: string;
  jid: string;
  name: string | null;
  notify: string | null;
  phoneNumber: string | null;
  alternateJid: string | null;
  metadata?: unknown;
};

export type StoredAlias = { jid: string; canonicalJid: string };

export type JidBackfillPlan = {
  aliases: { accountId: string; jid: string; canonicalJid: string }[];
  conflicts: { lid: string; pn: string; keptPn: string }[];
  messages: { id: string; chatJid: string; senderJid: string | null; alternateChatJid: string | null }[];
  chats: BackfillChat[];
  chatDeletes: { accountId: string; jid: string }[];
  contacts: BackfillContact[];
  contactDeletes: { accountId: string; jid: string }[];
};

function firstText(values: Array<string | null | undefined>): string | null {
  for (const value of values) if (value) return value;
  return null;
}

function storageJid(jid: string, maps: JidMaps): string {
  const kind = jidKind(bareUserJid(jid));
  switch (kind) {
    case 'pn':
    case 'lid':
      return canonicalJid(jid, maps).jid;
    case 'group':
    case 'other':
      return jid;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * Replay LID/phone pairs onto the current rows.
 *
 * Existing aliases win over a newly discovered pair that disagrees. Re-running
 * the plan on the rows it would write yields no further changes.
 */
export function planJidBackfill(input: {
  accountId: string;
  pairs: LidPnPair[];
  aliases?: StoredAlias[];
  messages: BackfillMessage[];
  chats: BackfillChat[];
  contacts: BackfillContact[];
}): JidBackfillPlan {
  const accountId = input.accountId;
  const lidToPn = new Map<string, string>();
  const seeded = new Set<string>();
  for (const alias of input.aliases ?? []) {
    const normalized = normalizeLidPnPair({ lid: alias.jid, pn: alias.canonicalJid });
    if (!normalized || seeded.has(normalized.lid)) continue;
    lidToPn.set(normalized.lid, normalized.pn);
    seeded.add(normalized.lid);
  }
  const conflicts: JidBackfillPlan['conflicts'] = [];
  for (const pair of input.pairs) {
    const normalized = normalizeLidPnPair(pair);
    if (!normalized) continue;
    const kept = lidToPn.get(normalized.lid);
    if (!kept) lidToPn.set(normalized.lid, normalized.pn);
    else if (kept !== normalized.pn) conflicts.push({ lid: normalized.lid, pn: normalized.pn, keptPn: kept });
  }

  const pnToLid = new Map<string, string>();
  for (const lid of [...lidToPn.keys()].sort()) {
    const pn = lidToPn.get(lid);
    if (pn && !pnToLid.has(pn)) pnToLid.set(pn, lid);
  }
  const maps: JidMaps = { lidToPn, pnToLid };
  const aliases = [...lidToPn.entries()]
    .filter(([lid]) => !seeded.has(lid))
    .map(([jid, canonicalJid]) => ({ accountId, jid, canonicalJid }));

  const messages: JidBackfillPlan['messages'] = [];
  for (const message of input.messages) {
    if (message.accountId !== accountId) continue;
    const remoteKind = jidKind(bareUserJid(message.chatJid));
    let chatJid = message.chatJid;
    let alternateChatJid = message.alternateChatJid;
    if (remoteKind === 'pn' || remoteKind === 'lid') {
      const identity = canonicalJid(message.chatJid, maps);
      chatJid = identity.jid;
      if (identity.alternateJid) alternateChatJid = identity.alternateJid;
    }
    let senderJid = message.senderJid;
    if (senderJid) {
      const senderKind = jidKind(bareUserJid(senderJid));
      if (senderKind === 'pn' || senderKind === 'lid') senderJid = canonicalJid(senderJid, maps).jid;
    }
    if (
      chatJid !== message.chatJid
      || senderJid !== message.senderJid
      || alternateChatJid !== message.alternateChatJid
    ) {
      messages.push({ id: message.id, chatJid, senderJid, alternateChatJid });
    }
  }

  const chats: BackfillChat[] = [];
  const chatDeletes: JidBackfillPlan['chatDeletes'] = [];
  const chatsByTarget = new Map<string, BackfillChat[]>();
  for (const chat of input.chats) {
    if (chat.accountId !== accountId) continue;
    const target = storageJid(chat.jid, maps);
    const group = chatsByTarget.get(target) ?? [];
    group.push(chat);
    chatsByTarget.set(target, group);
  }
  for (const [target, group] of chatsByTarget) {
    const canonicalRow = group.find((chat) => chat.jid === target);
    const alternateJid = jidKind(target) === 'pn' ? (pnToLid.get(target) ?? canonicalRow?.alternateJid ?? null) : (canonicalRow?.alternateJid ?? null);
    const folded: BackfillChat = {
      accountId,
      jid: target,
      name: firstText([canonicalRow?.name, ...group.map((chat) => chat.name)]),
      unreadCount: group.reduce((sum, chat) => sum + chat.unreadCount, 0),
      archived: canonicalRow ? canonicalRow.archived : group.some((chat) => chat.archived),
      alternateJid,
      metadata: canonicalRow?.metadata ?? group.find((chat) => chat.metadata != null)?.metadata ?? {},
    };
    const changed = !canonicalRow
      || canonicalRow.name !== folded.name
      || canonicalRow.unreadCount !== folded.unreadCount
      || canonicalRow.archived !== folded.archived
      || canonicalRow.alternateJid !== folded.alternateJid;
    if (changed) chats.push(folded);
    for (const chat of group) {
      if (chat.jid !== target) chatDeletes.push({ accountId, jid: chat.jid });
    }
  }

  const contacts: BackfillContact[] = [];
  const contactDeletes: JidBackfillPlan['contactDeletes'] = [];
  const contactsByTarget = new Map<string, BackfillContact[]>();
  for (const contact of input.contacts) {
    if (contact.accountId !== accountId) continue;
    const target = storageJid(contact.jid, maps);
    const group = contactsByTarget.get(target) ?? [];
    group.push(contact);
    contactsByTarget.set(target, group);
  }
  for (const [target, group] of contactsByTarget) {
    const canonicalRow = group.find((contact) => contact.jid === target);
    const targetKind = jidKind(target);
    const alternateJid = targetKind === 'pn'
      ? (pnToLid.get(target) ?? canonicalRow?.alternateJid ?? null)
      : (canonicalRow?.alternateJid ?? null);
    const phoneNumber = targetKind === 'pn'
      ? (target.split('@')[0] ?? null)
      : (canonicalRow?.phoneNumber ?? group.find((contact) => contact.phoneNumber)?.phoneNumber ?? null);
    const folded: BackfillContact = {
      accountId,
      jid: target,
      name: firstText([canonicalRow?.name, ...group.map((contact) => contact.name)]),
      notify: firstText([canonicalRow?.notify, ...group.map((contact) => contact.notify)]),
      phoneNumber,
      alternateJid,
      metadata: canonicalRow?.metadata ?? group.find((contact) => contact.metadata != null)?.metadata ?? {},
    };
    const changed = !canonicalRow
      || canonicalRow.name !== folded.name
      || canonicalRow.notify !== folded.notify
      || canonicalRow.phoneNumber !== folded.phoneNumber
      || canonicalRow.alternateJid !== folded.alternateJid;
    if (changed) contacts.push(folded);
    for (const contact of group) {
      if (contact.jid !== target) contactDeletes.push({ accountId, jid: contact.jid });
    }
  }

  return { aliases, conflicts, messages, chats, chatDeletes, contacts, contactDeletes };
}

export function backfillPlanIsEmpty(plan: JidBackfillPlan): boolean {
  return plan.aliases.length === 0
    && plan.messages.length === 0
    && plan.chats.length === 0
    && plan.chatDeletes.length === 0
    && plan.contacts.length === 0
    && plan.contactDeletes.length === 0;
}
