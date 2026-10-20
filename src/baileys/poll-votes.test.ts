import { randomBytes } from 'node:crypto';
import {
  aesEncryptGCM,
  BufferJSON,
  generateWAMessageContent,
  generateWAMessageFromContent,
  hmacSign,
  proto,
  sha256,
} from 'baileys';
import { describe, expect, it } from 'vitest';
import { decryptPollVoteAny, jidCandidates, selectedPollOptions } from './poll-votes.js';
import { storedWAMessage } from './stored-message.js';

const CREATOR_PN = '37255500001@s.whatsapp.net';
const CREATOR_LID = '111111111111111@lid';
const VOTER_PN = '37255500002@s.whatsapp.net';
const VOTER_LID = '222222222222222@lid';

/** What the voter's phone does: the inverse of Baileys' decryptPollVote. */
function encryptVote(options: string[], ctx: { pollMsgId: string; pollEncKey: Uint8Array; creatorJid: string; voterJid: string }) {
  const plaintext = proto.Message.PollVoteMessage.encode({
    selectedOptions: options.map((option) => sha256(Buffer.from(option))),
  }).finish();
  const sign = Buffer.concat([
    Buffer.from(ctx.pollMsgId), Buffer.from(ctx.creatorJid), Buffer.from(ctx.voterJid),
    Buffer.from('Poll Vote'), new Uint8Array([1]),
  ]);
  const key = hmacSign(sign, hmacSign(ctx.pollEncKey, new Uint8Array(32), 'sha256'), 'sha256');
  const encIv = randomBytes(12);
  const encPayload = aesEncryptGCM(plaintext, key, encIv, Buffer.from(`${ctx.pollMsgId}\u0000${ctx.voterJid}`));
  return { encPayload, encIv };
}

/** A poll as POST /messages sends it, round-tripped through the payload column. */
async function storedPoll() {
  const content = await generateWAMessageContent(
    { poll: { name: 'Lunch?', values: ['Pizza', 'Sushi', 'Salad'], selectableCount: 2 } },
    { upload: async () => { throw new Error('no upload'); } } as never,
  );
  const sent = generateWAMessageFromContent(VOTER_PN, content, { userJid: CREATOR_PN });
  const payload = JSON.parse(JSON.stringify(sent, BufferJSON.replacer)) as unknown;
  return storedWAMessage(payload);
}

describe('poll votes', () => {
  it('keeps the poll secret as bytes after a trip through the payload column', async () => {
    const poll = await storedPoll();
    // protobuf toJSON stores bytes as base64; reviving must turn them back.
    expect(poll.message?.messageContextInfo?.messageSecret).toBeInstanceOf(Uint8Array);
    expect(poll.message?.messageContextInfo?.messageSecret?.length).toBe(32);
    expect(poll.key.fromMe).toBe(true);
  });

  it('decrypts a vote keyed on LIDs when the phone JIDs are tried first', async () => {
    const poll = await storedPoll();
    const pollMsgId = poll.key.id!;
    const pollEncKey = poll.message!.messageContextInfo!.messageSecret!;
    const vote = encryptVote(['Sushi', 'Pizza'], { pollMsgId, pollEncKey, creatorJid: CREATOR_LID, voterJid: VOTER_LID });

    const decrypted = decryptPollVoteAny(vote, {
      messageId: pollMsgId,
      encKey: pollEncKey,
      creatorJids: jidCandidates(CREATOR_PN, CREATOR_LID),
      voterJids: jidCandidates(VOTER_PN, VOTER_LID),
    });
    expect(decrypted).toMatchObject({ creatorJid: CREATOR_LID, voterJid: VOTER_LID });
    // Option names come back in the poll's order, not the voter's.
    expect(selectedPollOptions(poll.message!, decrypted!.vote)).toEqual(['Pizza', 'Sushi']);
  });

  it('reads an empty selection as a withdrawn vote', async () => {
    const poll = await storedPoll();
    const pollEncKey = poll.message!.messageContextInfo!.messageSecret!;
    const vote = encryptVote([], { pollMsgId: poll.key.id!, pollEncKey, creatorJid: CREATOR_PN, voterJid: VOTER_PN });
    const decrypted = decryptPollVoteAny(vote, {
      messageId: poll.key.id!, encKey: pollEncKey, creatorJids: [CREATOR_PN], voterJids: [VOTER_PN],
    });
    expect(selectedPollOptions(poll.message!, decrypted!.vote)).toEqual([]);
  });

  it('returns null instead of guessing when no identity pairing authenticates', async () => {
    const poll = await storedPoll();
    const pollEncKey = poll.message!.messageContextInfo!.messageSecret!;
    const vote = encryptVote(['Salad'], { pollMsgId: poll.key.id!, pollEncKey, creatorJid: CREATOR_LID, voterJid: VOTER_LID });
    expect(decryptPollVoteAny(vote, {
      messageId: poll.key.id!, encKey: pollEncKey, creatorJids: [CREATOR_PN], voterJids: [VOTER_PN],
    })).toBeNull();
    expect(decryptPollVoteAny(vote, {
      messageId: poll.key.id!, encKey: randomBytes(32), creatorJids: [CREATOR_LID], voterJids: [VOTER_LID],
    })).toBeNull();
  });

  it('normalizes candidates to device-free user JIDs without duplicates', () => {
    expect(jidCandidates('37255500001:12@s.whatsapp.net', CREATOR_PN, null, undefined, '111111111111111:3@lid', 'garbage'))
      .toEqual([CREATOR_PN, CREATOR_LID]);
  });
});

describe('storedWAMessage', () => {
  it('keeps Baileys key extensions that the protobuf schema does not know', () => {
    const message = storedWAMessage({
      key: { remoteJid: VOTER_LID, remoteJidAlt: VOTER_PN, fromMe: false, id: 'ABC' },
      message: { conversation: 'hi' },
    });
    expect(message.key).toEqual({ remoteJid: VOTER_LID, remoteJidAlt: VOTER_PN, fromMe: false, id: 'ABC' });
    expect(message.message?.conversation).toBe('hi');
  });
});
