import { BufferJSON, proto, type WAMessage } from 'baileys';
import type { PrismaClient } from '@prisma/client';

/**
 * Turn a persisted `whatsapp_messages.payload` back into a real WAMessage.
 *
 * Payloads are written with JSON.stringify, which calls protobuf's own toJSON
 * first: bytes fields (messageSecret, media keys, poll vote ciphertext) land as
 * base64 strings and enums as their names. A plain JSON.parse hands those back
 * as strings, which is wrong for anything that does crypto with them — a poll's
 * messageSecret must be bytes to derive the vote key. `fromObject` is protobuf's
 * inverse of toJSON, and also accepts the `{ type: 'Buffer' }` shape the reviver
 * produces for fields that were already Buffers.
 */
export function storedWAMessage(payload: unknown): WAMessage {
  const revived = JSON.parse(JSON.stringify(payload ?? {}), BufferJSON.reviver) as Record<string, unknown>;
  let message: WAMessage;
  try {
    message = proto.WebMessageInfo.fromObject(revived) as unknown as WAMessage;
  } catch {
    message = revived as unknown as WAMessage;
  }
  // The key holds only strings, and Baileys extends it beyond the proto
  // (`remoteJidAlt`, `participantAlt`, `addressingMode`) — fields fromObject
  // would drop. Keep it exactly as stored.
  message.key = { ...(revived.key as WAMessage['key'] | undefined) };
  return message;
}

/**
 * A stored message of this account, by gateway id (`msg_…`) or WhatsApp
 * message id. Callers hold either: the gateway id comes from our own events and
 * list endpoint, the WhatsApp id from `quoted.message_id` and Baileys keys.
 */
export async function findStoredMessage(
  db: Pick<PrismaClient, 'whatsAppMessage'>,
  accountId: string,
  messageId: string,
): Promise<{ id: string; whatsappMessageId: string | null; chatJid: string; message: WAMessage } | null> {
  const stored = await db.whatsAppMessage.findFirst({
    where: { accountId, OR: [{ id: messageId }, { whatsappMessageId: messageId }] },
    select: { id: true, whatsappMessageId: true, chatJid: true, payload: true },
  });
  if (!stored) return null;
  return { id: stored.id, whatsappMessageId: stored.whatsappMessageId, chatJid: stored.chatJid, message: storedWAMessage(stored.payload) };
}
