import { describe, expect, it } from 'vitest';
import {
  bareUserJid,
  canonicalJid,
  jidKind,
  lidPnPairsFromChat,
  lidPnPairsFromContact,
  lidPnPairsFromContactRecord,
  lidPnPairsFromMessagePayload,
  planJidBackfill,
  type BackfillChat,
  type BackfillContact,
  type BackfillMessage,
  type JidBackfillPlan,
} from './jid-alias.js';

const PHONE = '3725142131@s.whatsapp.net';
const LID = '116978031300656@lid';
const ACCOUNT = 'wa_live';

describe('LID and phone JID mapping', () => {
  it('classifies phone, LID, hosted, and group JIDs', () => {
    expect(jidKind(PHONE)).toBe('pn');
    expect(jidKind('3725142131@c.us')).toBe('pn');
    expect(jidKind('3725142131@hosted')).toBe('pn');
    expect(jidKind(LID)).toBe('lid');
    expect(jidKind('116978031300656@hosted.lid')).toBe('lid');
    expect(jidKind('120363000000000000@g.us')).toBe('group');
    expect(jidKind('status@broadcast')).toBe('other');
  });

  it('strips the device suffix without touching the domain', () => {
    expect(bareUserJid('3725142131:3@s.whatsapp.net')).toBe(PHONE);
    expect(bareUserJid(`${LID.split('@')[0]}:0@lid`)).toBe(LID);
    expect(bareUserJid(PHONE)).toBe(PHONE);
  });

  it('learns the phone JID from remoteJidAlt on an inbound LID message', () => {
    expect(lidPnPairsFromMessagePayload({
      key: {
        remoteJid: LID,
        remoteJidAlt: PHONE,
        addressingMode: 'lid',
      },
    })).toEqual([{ lid: LID, pn: PHONE }]);
  });

  it('learns the same pair when the phone JID is remoteJid and the LID is the alt', () => {
    expect(lidPnPairsFromMessagePayload({
      key: { remoteJid: `3725142131:2@s.whatsapp.net`, remoteJidAlt: `${LID.split('@')[0]}:1@lid` },
    })).toEqual([{ lid: LID, pn: PHONE }]);
  });

  it('accepts senderPn and participantAlt, and ignores a quoted participant', () => {
    expect(lidPnPairsFromMessagePayload({
      key: { remoteJid: LID, senderPn: PHONE },
      message: { extendedTextMessage: { contextInfo: { participant: '999000@s.whatsapp.net' } } },
    })).toEqual([{ lid: LID, pn: PHONE }]);

    expect(lidPnPairsFromMessagePayload({
      key: {
        remoteJid: '120363@g.us',
        participant: LID,
        participantAlt: PHONE,
      },
    })).toEqual([{ lid: LID, pn: PHONE }]);
  });

  it('does not invent a phone from a contact whose phoneNumber is the LID user', () => {
    expect(lidPnPairsFromContactRecord({
      jid: LID,
      phoneNumber: LID.split('@')[0] ?? '',
      metadata: { id: LID },
    })).toEqual([]);
    expect(lidPnPairsFromContactRecord({
      jid: LID,
      phoneNumber: PHONE.split('@')[0] ?? '',
    })).toEqual([{ lid: LID, pn: PHONE }]);
  });

  it('reads a real phone from contact and chat metadata', () => {
    expect(lidPnPairsFromContact({ id: LID, phoneNumber: PHONE })).toEqual([{ lid: LID, pn: PHONE }]);
    expect(lidPnPairsFromContact({ id: PHONE, lid: LID })).toEqual([{ lid: LID, pn: PHONE }]);
    expect(lidPnPairsFromContact({ id: LID, phoneNumber: PHONE.split('@')[0] ?? '' })).toEqual([{ lid: LID, pn: PHONE }]);
    expect(lidPnPairsFromChat({ id: LID, pnJid: PHONE })).toEqual([{ lid: LID, pn: PHONE }]);
  });

  it('prefers the phone JID as the canonical chat id once the pair is known', () => {
    const maps = { lidToPn: new Map([[LID, PHONE]]), pnToLid: new Map([[PHONE, LID]]) };
    expect(canonicalJid(LID, maps)).toEqual({ jid: PHONE, alternateJid: LID });
    expect(canonicalJid('3725142131:4@s.whatsapp.net', maps)).toEqual({ jid: PHONE, alternateJid: LID });
    expect(canonicalJid('120363@g.us', maps)).toEqual({ jid: '120363@g.us', alternateJid: null });
    expect(canonicalJid(LID, { lidToPn: new Map() })).toEqual({ jid: LID, alternateJid: null });
  });
});

function message(partial: Partial<BackfillMessage> & Pick<BackfillMessage, 'id' | 'chatJid'>): BackfillMessage {
  return {
    accountId: ACCOUNT,
    senderJid: null,
    alternateChatJid: null,
    ...partial,
  };
}

function chat(partial: Partial<BackfillChat> & Pick<BackfillChat, 'jid'>): BackfillChat {
  return {
    accountId: ACCOUNT,
    name: null,
    unreadCount: 0,
    archived: false,
    alternateJid: null,
    ...partial,
  };
}

function contact(partial: Partial<BackfillContact> & Pick<BackfillContact, 'jid'>): BackfillContact {
  return {
    accountId: ACCOUNT,
    name: null,
    notify: null,
    phoneNumber: null,
    alternateJid: null,
    ...partial,
  };
}

function applyPlan(input: {
  messages: BackfillMessage[];
  chats: BackfillChat[];
  contacts: BackfillContact[];
  aliases: { jid: string; canonicalJid: string }[];
}, plan: JidBackfillPlan) {
  const messages = input.messages.map((row) => {
    const update = plan.messages.find((item) => item.id === row.id);
    return update ? { ...row, ...update } : row;
  });
  const deletedChats = new Set(plan.chatDeletes.map((row) => row.jid));
  const chats = input.chats.filter((row) => !deletedChats.has(row.jid));
  for (const row of plan.chats) {
    const index = chats.findIndex((chat) => chat.jid === row.jid);
    if (index >= 0) chats[index] = row;
    else chats.push(row);
  }
  const deletedContacts = new Set(plan.contactDeletes.map((row) => row.jid));
  const contacts = input.contacts.filter((row) => !deletedContacts.has(row.jid));
  for (const row of plan.contacts) {
    const index = contacts.findIndex((item) => item.jid === row.jid);
    if (index >= 0) contacts[index] = row;
    else contacts.push(row);
  }
  const aliases = [...input.aliases];
  for (const alias of plan.aliases) {
    if (!aliases.some((row) => row.jid === alias.jid)) aliases.push({ jid: alias.jid, canonicalJid: alias.canonicalJid });
  }
  return { messages, chats, contacts, aliases };
}

describe('LID backfill', () => {
  it('re-keys the live split: outbound phone thread plus inbound LID thread become one chat', () => {
    const input = {
      pairs: lidPnPairsFromMessagePayload({
        key: { remoteJid: LID, remoteJidAlt: PHONE, addressingMode: 'lid' },
      }),
      messages: [
        message({ id: 'out', chatJid: PHONE, senderJid: null }),
        message({ id: 'in', chatJid: LID, senderJid: LID }),
      ],
      chats: [
        chat({ jid: PHONE, name: 'Alice', unreadCount: 1 }),
        chat({ jid: LID, unreadCount: 4 }),
      ],
      contacts: [
        contact({ jid: PHONE, name: 'Alice', phoneNumber: '3725142131' }),
        contact({ jid: LID, phoneNumber: '116978031300656' }),
      ],
    };
    const plan = planJidBackfill({ accountId: ACCOUNT, ...input });

    expect(plan.conflicts).toEqual([]);
    expect(plan.aliases).toEqual([{ accountId: ACCOUNT, jid: LID, canonicalJid: PHONE }]);
    expect(plan.messages).toEqual([
      { id: 'out', chatJid: PHONE, senderJid: null, alternateChatJid: LID },
      { id: 'in', chatJid: PHONE, senderJid: PHONE, alternateChatJid: LID },
    ]);
    expect(plan.chats).toEqual([
      expect.objectContaining({ jid: PHONE, name: 'Alice', unreadCount: 5, alternateJid: LID, archived: false }),
    ]);
    expect(plan.chatDeletes).toEqual([{ accountId: ACCOUNT, jid: LID }]);
    expect(plan.contacts).toEqual([
      expect.objectContaining({
        jid: PHONE,
        name: 'Alice',
        phoneNumber: '3725142131',
        alternateJid: LID,
      }),
    ]);
    expect(plan.contactDeletes).toEqual([{ accountId: ACCOUNT, jid: LID }]);
  });

  it('keeps the phone chat name when the LID chat is the only named row, and creates the phone chat if needed', () => {
    const plan = planJidBackfill({
      accountId: ACCOUNT,
      pairs: [{ lid: LID, pn: PHONE }],
      messages: [message({ id: 'in', chatJid: LID, senderJid: LID })],
      chats: [chat({ jid: LID, name: 'Bob', unreadCount: 2, archived: true })],
      contacts: [],
    });
    expect(plan.chats).toEqual([
      expect.objectContaining({ jid: PHONE, name: 'Bob', unreadCount: 2, archived: true, alternateJid: LID }),
    ]);
    expect(plan.chatDeletes).toEqual([{ accountId: ACCOUNT, jid: LID }]);
  });

  it('does not move group chats, but does rewrite a LID sender onto the phone JID', () => {
    const group = '120363000000000000@g.us';
    const plan = planJidBackfill({
      accountId: ACCOUNT,
      pairs: [{ lid: LID, pn: PHONE }],
      messages: [message({ id: 'g', chatJid: group, senderJid: LID })],
      chats: [chat({ jid: group, name: 'Team', unreadCount: 3 })],
      contacts: [],
    });
    expect(plan.messages).toEqual([
      { id: 'g', chatJid: group, senderJid: PHONE, alternateChatJid: null },
    ]);
    expect(plan.chats).toEqual([]);
    expect(plan.chatDeletes).toEqual([]);
  });

  it('keeps an already stored alias when a later payload names a different phone', () => {
    const other = '15550001111@s.whatsapp.net';
    const plan = planJidBackfill({
      accountId: ACCOUNT,
      pairs: [{ lid: LID, pn: other }],
      aliases: [{ jid: LID, canonicalJid: PHONE }],
      messages: [message({ id: 'in', chatJid: LID, senderJid: LID })],
      chats: [],
      contacts: [],
    });
    expect(plan.aliases).toEqual([]);
    expect(plan.conflicts).toEqual([{ lid: LID, pn: other, keptPn: PHONE }]);
    expect(plan.messages[0]).toMatchObject({ chatJid: PHONE, alternateChatJid: LID });
  });

  it('is idempotent: applying the plan and planning again changes nothing', () => {
    const original = {
      messages: [
        message({ id: 'out', chatJid: '3725142131:0@s.whatsapp.net' }),
        message({ id: 'in', chatJid: `${LID.split('@')[0]}:1@lid`, senderJid: LID }),
      ],
      chats: [
        chat({ jid: PHONE, name: 'Alice', unreadCount: 1 }),
        chat({ jid: LID, unreadCount: 4 }),
      ],
      contacts: [
        contact({ jid: PHONE, name: 'Alice', phoneNumber: '3725142131' }),
        contact({ jid: LID, name: null, phoneNumber: LID.split('@')[0] ?? null }),
      ],
      aliases: [] as { jid: string; canonicalJid: string }[],
    };
    const pairs = [{ lid: LID, pn: PHONE }];
    const first = planJidBackfill({ accountId: ACCOUNT, pairs, ...original });
    const next = applyPlan(original, first);
    const second = planJidBackfill({ accountId: ACCOUNT, pairs, ...next });
    expect(second.aliases).toEqual([]);
    expect(second.messages).toEqual([]);
    expect(second.chats).toEqual([]);
    expect(second.chatDeletes).toEqual([]);
    expect(second.contacts).toEqual([]);
    expect(second.contactDeletes).toEqual([]);
    expect(second.conflicts).toEqual([]);
    expect(next.messages.map((row) => row.chatJid)).toEqual([PHONE, PHONE]);
  });

  it('leaves an unmapped LID chat where it is', () => {
    const plan = planJidBackfill({
      accountId: ACCOUNT,
      pairs: [],
      messages: [message({ id: 'in', chatJid: LID, senderJid: LID })],
      chats: [chat({ jid: LID, unreadCount: 1 })],
      contacts: [contact({ jid: LID })],
    });
    expect(plan.aliases).toEqual([]);
    expect(plan.messages).toEqual([]);
    expect(plan.chats).toEqual([]);
    expect(plan.chatDeletes).toEqual([]);
    expect(plan.contacts).toEqual([]);
  });
});
