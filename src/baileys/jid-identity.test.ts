import { describe, expect, it } from 'vitest';
import { canonicalJidFor, isLidJid, isPhoneJid, JidIdentity, pairOf, pairsFromKey, phoneJidFrom, userJid } from './jid-identity.js';

/**
 * WhatsApp addresses one person two ways. These are the rules that decide which
 * address a conversation is stored under — get them wrong and a contact's
 * history silently splits in two.
 */
describe('jid identity rules', () => {
  it('recognises LID and phone JIDs', () => {
    expect(isLidJid('116978031300656@lid')).toBe(true);
    expect(isPhoneJid('3725142131@s.whatsapp.net')).toBe(true);
    expect(isLidJid('120363@g.us')).toBe(false);
    expect(isPhoneJid('120363@g.us')).toBe(false);
    expect(isLidJid(null)).toBe(false);
  });

  it('drops device suffixes, which name a device, not a person', () => {
    expect(userJid('999:3@lid')).toBe('999@lid');
    expect(userJid('3725550000:12@s.whatsapp.net')).toBe('3725550000@s.whatsapp.net');
    expect(userJid('120363@g.us')).toBe('120363@g.us');
  });

  it('turns numbers in any common shape into a phone JID', () => {
    expect(phoneJidFrom('+372 514 2131')).toBe('3725142131@s.whatsapp.net');
    expect(phoneJidFrom('3725142131')).toBe('3725142131@s.whatsapp.net');
    expect(phoneJidFrom('3725142131:4@s.whatsapp.net')).toBe('3725142131@s.whatsapp.net');
    expect(phoneJidFrom('116978031300656@lid')).toBeNull();
    expect(phoneJidFrom('')).toBeNull();
  });

  it('pairs a LID with a phone JID in either order', () => {
    const pair = { lid: '116978031300656@lid', pn: '3725142131@s.whatsapp.net' };
    expect(pairOf('116978031300656@lid', '3725142131@s.whatsapp.net')).toEqual(pair);
    expect(pairOf('3725142131@s.whatsapp.net', '116978031300656@lid')).toEqual(pair);
    expect(pairOf('116978031300656@lid', '3725142131')).toEqual(pair);
  });

  it('refuses pairs that are not one LID plus one phone', () => {
    expect(pairOf('1@lid', '2@lid')).toBeNull();
    expect(pairOf('3725142131@s.whatsapp.net', '3725142132@s.whatsapp.net')).toBeNull();
    expect(pairOf('120363@g.us', '3725142131@s.whatsapp.net')).toBeNull();
    expect(pairOf('1@lid', null)).toBeNull();
  });

  it('reads both the chat and the group-sender pairing off a message key', () => {
    expect(pairsFromKey({ remoteJid: '116978031300656@lid', remoteJidAlt: '3725142131@s.whatsapp.net' }))
      .toEqual([{ lid: '116978031300656@lid', pn: '3725142131@s.whatsapp.net' }]);
    expect(pairsFromKey({
      remoteJid: '120363@g.us',
      participant: '999:3@lid',
      participantAlt: '3725550000:3@s.whatsapp.net',
    })).toEqual([{ lid: '999@lid', pn: '3725550000@s.whatsapp.net' }]);
    expect(pairsFromKey({ remoteJid: '3725142131@s.whatsapp.net' })).toEqual([]);
    expect(pairsFromKey(undefined)).toEqual([]);
  });
});

type Alias = { pnJid: string };
function fakeDb(aliases: Record<string, string> = {}) {
  const merges: string[] = [];
  const db = {
    whatsAppJidAlias: {
      findUnique: async ({ where }: { where: { accountId_lid: { lid: string } } }): Promise<Alias | null> => {
        const pn = aliases[where.accountId_lid.lid];
        return pn ? { pnJid: pn } : null;
      },
    },
    $transaction: async (run: (tx: unknown) => Promise<void>) => {
      const tx = {
        whatsAppJidAlias: {
          upsert: async ({ create }: { create: { lid: string; pnJid: string } }) => {
            aliases[create.lid] = create.pnJid;
            merges.push(`${create.lid}->${create.pnJid}`);
          },
        },
        whatsAppMessage: { updateMany: async () => ({ count: 0 }) },
        whatsAppChat: { findUnique: async () => null },
        whatsAppContact: { findUnique: async () => null },
      };
      await run(tx);
    },
  };
  return { db: db as never, aliases, merges };
}

describe('JidIdentity', () => {
  it('stores a LID under its phone JID once the pairing is known', async () => {
    const { db } = fakeDb({ '116978031300656@lid': '3725142131@s.whatsapp.net' });
    const identity = new JidIdentity(db, 'wa_1');
    expect(await identity.canonical('116978031300656@lid')).toBe('3725142131@s.whatsapp.net');
    expect(await identity.canonical('116978031300656:7@lid')).toBe('3725142131@s.whatsapp.net');
  });

  it('leaves unknown LIDs, phones and groups alone', async () => {
    const { db } = fakeDb();
    const identity = new JidIdentity(db, 'wa_1');
    expect(await identity.canonical('777@lid')).toBe('777@lid');
    expect(await identity.canonical('3725142131:2@s.whatsapp.net')).toBe('3725142131@s.whatsapp.net');
    expect(await identity.canonical('120363@g.us')).toBe('120363@g.us');
    expect(await identity.canonical('status@broadcast')).toBe('status@broadcast');
    expect(await identity.canonical(null)).toBeNull();
  });

  it("falls back to Baileys' LID store and remembers what it learns", async () => {
    const { db, merges } = fakeDb();
    let lookups = 0;
    const identity = new JidIdentity(db, 'wa_1', async () => {
      lookups += 1;
      return '3725142131@s.whatsapp.net';
    });
    expect(await identity.canonical('116978031300656@lid')).toBe('3725142131@s.whatsapp.net');
    expect(await identity.canonical('116978031300656@lid')).toBe('3725142131@s.whatsapp.net');
    expect(lookups).toBe(1);
    expect(merges).toEqual(['116978031300656@lid->3725142131@s.whatsapp.net']);
  });

  it('survives a failing LID store', async () => {
    const { db } = fakeDb();
    const identity = new JidIdentity(db, 'wa_1', async () => { throw new Error('store closed'); });
    expect(await identity.canonical('777@lid')).toBe('777@lid');
  });

  it('merges only on a new or changed pairing', async () => {
    const { db, merges } = fakeDb({ '1@lid': '3721@s.whatsapp.net' });
    const identity = new JidIdentity(db, 'wa_1');
    expect(await identity.learn({ lid: '1@lid', pn: '3721@s.whatsapp.net' }, 'message')).toBe(false);
    expect(await identity.learn({ lid: '2@lid', pn: '3722@s.whatsapp.net' }, 'message')).toBe(true);
    expect(await identity.learn({ lid: '2@lid', pn: '3722@s.whatsapp.net' }, 'message')).toBe(false);
    expect(await identity.learn({ lid: '1@lid', pn: '3729@s.whatsapp.net' }, 'contact')).toBe(true);
    expect(await identity.learn(null, 'message')).toBe(false);
    expect(merges).toEqual(['2@lid->3722@s.whatsapp.net', '1@lid->3729@s.whatsapp.net']);
  });

  it('resolves API filters from the alias table without a socket', async () => {
    const { db } = fakeDb({ '116978031300656@lid': '3725142131@s.whatsapp.net' });
    expect(await canonicalJidFor(db, 'wa_1', '116978031300656@lid')).toBe('3725142131@s.whatsapp.net');
    expect(await canonicalJidFor(db, 'wa_1', '777@lid')).toBe('777@lid');
    expect(await canonicalJidFor(db, 'wa_1', '120363@g.us')).toBe('120363@g.us');
  });
});
