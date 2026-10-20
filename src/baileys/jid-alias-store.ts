import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { logger } from '../logger.js';
import {
  backfillPlanIsEmpty,
  bareUserJid,
  lidPnPairsFromChatMetadata,
  lidPnPairsFromContactRecord,
  lidPnPairsFromMessagePayload,
  normalizeLidPnPair,
  planJidBackfill,
  type BackfillChat,
  type BackfillContact,
  type BackfillMessage,
  type JidBackfillPlan,
  type LidPnPair,
  type StoredAlias,
} from './jid-alias.js';

export type JidBackfillReport = {
  accountId: string;
  dryRun: boolean;
  pairs: number;
  conflicts: number;
  aliases: number;
  messages: number;
  chats: number;
  chatDeletes: number;
  contacts: number;
  contactDeletes: number;
  conflictLids: string[];
};

type MessageKeyRow = {
  id: string;
  chatJid: string;
  senderJid: string | null;
  alternateChatJid: string | null;
  remoteJid: string | null;
  remoteJidAlt: string | null;
  participant: string | null;
  participantAlt: string | null;
  senderPn: string | null;
  senderLid: string | null;
};

function cloneJson(value: unknown): Prisma.InputJsonValue {
  if (value === null || value === undefined) return {};
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function reportOf(accountId: string, dryRun: boolean, pairCount: number, plan: JidBackfillPlan): JidBackfillReport {
  return {
    accountId,
    dryRun,
    pairs: pairCount,
    conflicts: plan.conflicts.length,
    aliases: plan.aliases.length,
    messages: plan.messages.length,
    chats: plan.chats.length,
    chatDeletes: plan.chatDeletes.length,
    contacts: plan.contacts.length,
    contactDeletes: plan.contactDeletes.length,
    conflictLids: plan.conflicts.map((conflict) => conflict.lid),
  };
}

export async function applyJidBackfillPlan(plan: JidBackfillPlan): Promise<void> {
  if (backfillPlanIsEmpty(plan)) return;
  await prisma.$transaction(async (tx) => {
    for (const alias of plan.aliases) {
      await tx.whatsAppJidAlias.upsert({
        where: { accountId_jid: { accountId: alias.accountId, jid: alias.jid } },
        create: { accountId: alias.accountId, jid: alias.jid, canonicalJid: alias.canonicalJid },
        update: { canonicalJid: alias.canonicalJid },
      });
    }
    for (const message of plan.messages) {
      await tx.whatsAppMessage.update({
        where: { id: message.id },
        data: {
          chatJid: message.chatJid,
          senderJid: message.senderJid,
          alternateChatJid: message.alternateChatJid,
        },
      });
    }
    for (const chat of plan.chats) {
      await tx.whatsAppChat.upsert({
        where: { accountId_jid: { accountId: chat.accountId, jid: chat.jid } },
        create: {
          accountId: chat.accountId,
          jid: chat.jid,
          name: chat.name,
          unreadCount: chat.unreadCount,
          archived: chat.archived,
          alternateJid: chat.alternateJid,
          metadata: cloneJson(chat.metadata),
        },
        update: {
          name: chat.name,
          unreadCount: chat.unreadCount,
          archived: chat.archived,
          alternateJid: chat.alternateJid,
        },
      });
    }
    for (const chat of plan.chatDeletes) {
      await tx.whatsAppChat.deleteMany({ where: { accountId: chat.accountId, jid: chat.jid } });
    }
    for (const contact of plan.contacts) {
      await tx.whatsAppContact.upsert({
        where: { accountId_jid: { accountId: contact.accountId, jid: contact.jid } },
        create: {
          accountId: contact.accountId,
          jid: contact.jid,
          name: contact.name,
          notify: contact.notify,
          phoneNumber: contact.phoneNumber,
          alternateJid: contact.alternateJid,
          metadata: cloneJson(contact.metadata),
        },
        update: {
          name: contact.name,
          notify: contact.notify,
          phoneNumber: contact.phoneNumber,
          alternateJid: contact.alternateJid,
        },
      });
    }
    for (const contact of plan.contactDeletes) {
      await tx.whatsAppContact.deleteMany({ where: { accountId: contact.accountId, jid: contact.jid } });
    }
  }, { timeout: 600_000, maxWait: 20_000 });
}

/**
 * Learn one LID ↔ phone pair and fold any rows still stored under the LID.
 * A pair that disagrees with an alias already stored for that LID is ignored.
 * Returns false when the pair was rejected.
 */
export async function persistLidPnMapping(accountId: string, pair: { lid: string; pn: string }): Promise<boolean> {
  const normalized = normalizeLidPnPair(pair);
  if (!normalized) return false;
  const existing = await prisma.whatsAppJidAlias.findUnique({
    where: { accountId_jid: { accountId, jid: normalized.lid } },
  });
  if (existing && existing.canonicalJid !== normalized.pn) {
    logger.warn(
      { accountId, lid: normalized.lid, kept: existing.canonicalJid, ignored: normalized.pn },
      'Conflicting LID mapping ignored',
    );
    return false;
  }
  if (existing?.canonicalJid === normalized.pn) return true;

  const jids = [normalized.lid, normalized.pn];
  const [messages, chats, contacts] = await Promise.all([
    prisma.whatsAppMessage.findMany({
      where: {
        accountId,
        OR: [
          { chatJid: { in: jids } },
          { senderJid: { in: jids } },
          { alternateChatJid: normalized.lid },
        ],
      },
      select: { id: true, accountId: true, chatJid: true, senderJid: true, alternateChatJid: true },
    }),
    prisma.whatsAppChat.findMany({ where: { accountId, jid: { in: jids } } }),
    prisma.whatsAppContact.findMany({ where: { accountId, jid: { in: jids } } }),
  ]);
  const plan = planJidBackfill({
    accountId,
    pairs: [normalized],
    messages,
    chats: chats.map(toBackfillChat),
    contacts: contacts.map(toBackfillContact),
  });
  await applyJidBackfillPlan(plan);
  return true;
}

function toBackfillChat(chat: {
  accountId: string;
  jid: string;
  name: string | null;
  unreadCount: number;
  archived: boolean;
  alternateJid: string | null;
  metadata: unknown;
}): BackfillChat {
  return {
    accountId: chat.accountId,
    jid: chat.jid,
    name: chat.name,
    unreadCount: chat.unreadCount,
    archived: chat.archived,
    alternateJid: chat.alternateJid,
    metadata: chat.metadata,
  };
}

function toBackfillContact(contact: {
  accountId: string;
  jid: string;
  name: string | null;
  notify: string | null;
  phoneNumber: string | null;
  alternateJid: string | null;
  metadata: unknown;
}): BackfillContact {
  return {
    accountId: contact.accountId,
    jid: contact.jid,
    name: contact.name,
    notify: contact.notify,
    phoneNumber: contact.phoneNumber,
    alternateJid: contact.alternateJid,
    metadata: contact.metadata,
  };
}

/**
 * JIDs that refer to the same direct chat: the requested JID, its bare form,
 * and every LID/phone alias stored for it. Filtering messages by any of them
 * returns the whole thread.
 */
export async function expandEquivalentJids(accountId: string, jids: string[]): Promise<string[]> {
  if (jids.length === 0) return [];
  const bare = [...new Set(jids.flatMap((jid) => [jid, bareUserJid(jid)]))];
  const rows = await prisma.whatsAppJidAlias.findMany({
    where: {
      accountId,
      OR: [{ jid: { in: bare } }, { canonicalJid: { in: bare } }],
    },
    select: { jid: true, canonicalJid: true },
  });
  const expanded = new Set(bare);
  for (const row of rows) {
    expanded.add(row.jid);
    expanded.add(row.canonicalJid);
  }
  return [...expanded];
}

export function messageJidWhere(jids: string[]): Prisma.WhatsAppMessageWhereInput {
  return {
    OR: [
      { chatJid: { in: jids } },
      { alternateChatJid: { in: jids } },
    ],
  };
}

/**
 * Idempotent re-key of one account. Mappings come from message `key` fields
 * (`remoteJid` / `remoteJidAlt`, participant alts, `senderPn`) and from chat
 * and contact metadata (`pnJid`, `lidJid`, `phoneNumber`). Safe to repeat.
 */
export async function backfillAccountJidAliases(accountId: string, options: { dryRun?: boolean } = {}): Promise<JidBackfillReport> {
  const dryRun = options.dryRun ?? false;
  const [aliasRows, chats, contacts, messageKeys] = await Promise.all([
    prisma.whatsAppJidAlias.findMany({ where: { accountId }, select: { jid: true, canonicalJid: true } }),
    prisma.whatsAppChat.findMany({ where: { accountId } }),
    prisma.whatsAppContact.findMany({ where: { accountId } }),
    prisma.$queryRaw<MessageKeyRow[]>`
      SELECT
        id,
        "chatJid",
        "senderJid",
        "alternateChatJid",
        payload->'key'->>'remoteJid' AS "remoteJid",
        payload->'key'->>'remoteJidAlt' AS "remoteJidAlt",
        payload->'key'->>'participant' AS "participant",
        payload->'key'->>'participantAlt' AS "participantAlt",
        payload->'key'->>'senderPn' AS "senderPn",
        payload->'key'->>'senderLid' AS "senderLid"
      FROM whatsapp_messages
      WHERE "accountId" = ${accountId}
      ORDER BY id ASC
    `,
  ]);

  const aliases: StoredAlias[] = aliasRows;
  const pairs: LidPnPair[] = [];
  for (const alias of aliases) {
    const normalized = normalizeLidPnPair({ lid: alias.jid, pn: alias.canonicalJid });
    if (normalized) pairs.push(normalized);
  }
  for (const contact of contacts) pairs.push(...lidPnPairsFromContactRecord(contact));
  for (const chat of chats) pairs.push(...lidPnPairsFromChatMetadata(chat.metadata));

  const messages: BackfillMessage[] = messageKeys.map((row) => {
    pairs.push(...lidPnPairsFromMessagePayload({
      key: {
        remoteJid: row.remoteJid,
        remoteJidAlt: row.remoteJidAlt,
        participant: row.participant,
        participantAlt: row.participantAlt,
        senderPn: row.senderPn,
        senderLid: row.senderLid,
      },
    }));
    return {
      id: row.id,
      accountId,
      chatJid: row.chatJid,
      senderJid: row.senderJid,
      alternateChatJid: row.alternateChatJid,
    };
  });

  const plan = planJidBackfill({
    accountId,
    pairs,
    aliases,
    messages,
    chats: chats.map(toBackfillChat),
    contacts: contacts.map(toBackfillContact),
  });
  if (!dryRun) await applyJidBackfillPlan(plan);
  if (plan.conflicts.length > 0) {
    logger.warn({ accountId, conflicts: plan.conflicts }, 'LID backfill kept the existing phone JID for conflicting mappings');
  }
  return reportOf(accountId, dryRun, pairs.length, plan);
}
