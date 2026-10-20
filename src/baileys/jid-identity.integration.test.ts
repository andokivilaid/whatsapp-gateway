import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db/prisma.js';
import { id } from '../ids.js';
import { JidIdentity } from './jid-identity.js';

const suite = describe.skipIf(process.env.RUN_DATABASE_TESTS !== '1');
const suffix = randomUUID();
const userId = `test_user_${suffix}`;
const tenantId = `test_tenant_${suffix}`;
const accountId = id('wa');

const LID = '116978031300656@lid';
const PN = '3725142131@s.whatsapp.net';

/**
 * The production split, reproduced: our sends live under the phone JID, the
 * contact's replies under their LID. Learning the pairing late must fold the
 * LID thread into the phone thread without losing anything.
 */
suite('LID ↔ phone merge against Postgres', () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, name: 'LID Test', email: `${suffix}@example.test`, emailVerified: true } });
    await prisma.tenant.create({ data: { id: tenantId, ownerUserId: userId, name: 'LID Test' } });
    await prisma.whatsAppAccount.create({ data: { id: accountId, tenantId, displayName: 'LID Test' } });

    await prisma.whatsAppChat.createMany({
      data: [
        { accountId, jid: PN, unreadCount: 1 },
        { accountId, jid: LID, name: 'Ando', unreadCount: 2, metadata: { source: 'lid' } },
      ],
    });
    await prisma.whatsAppContact.createMany({
      data: [
        { accountId, jid: LID, notify: 'Ando', phoneNumber: '116978031300656' },
      ],
    });
    await prisma.whatsAppMessage.createMany({
      data: [
        { id: id('msg'), accountId, whatsappMessageId: `out_${suffix}`, chatJid: PN, direction: 'outbound', messageType: 'conversation', text: 'test' },
        { id: id('msg'), accountId, whatsappMessageId: `in_${suffix}`, chatJid: LID, senderJid: LID, direction: 'inbound', messageType: 'conversation', text: 'Hi' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('folds the LID thread into the phone thread when the pairing is learned', async () => {
    const identity = new JidIdentity(prisma, accountId);
    expect(await identity.learn({ lid: LID, pn: PN }, 'message')).toBe(true);

    const messages = await prisma.whatsAppMessage.findMany({ where: { accountId }, orderBy: { whatsappMessageId: 'asc' } });
    expect(messages.map((message) => message.chatJid)).toEqual([PN, PN]);
    expect(messages.find((message) => message.direction === 'inbound')?.senderJid).toBe(PN);

    const chats = await prisma.whatsAppChat.findMany({ where: { accountId } });
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ jid: PN, name: 'Ando', unreadCount: 3 });
    expect(chats[0]?.metadata).toMatchObject({ lid: LID, source: 'lid' });

    const contacts = await prisma.whatsAppContact.findMany({ where: { accountId } });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ jid: PN, notify: 'Ando', phoneNumber: '3725142131' });

    expect(await identity.canonical(LID)).toBe(PN);
  });

  it('is a no-op when the same pairing is learned again', async () => {
    const identity = new JidIdentity(prisma, accountId);
    expect(await identity.learn({ lid: LID, pn: PN }, 'message')).toBe(false);
    expect(await prisma.whatsAppChat.count({ where: { accountId } })).toBe(1);
  });
});
