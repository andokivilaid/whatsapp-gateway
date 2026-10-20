/**
 * Poll votes, decrypted.
 *
 * A vote arrives as a `pollUpdateMessage` whose payload is AES-GCM encrypted
 * with a key derived from the poll's `messageSecret`, the poll's message id,
 * and the JIDs of the poll's creator and of the voter. Baileys 7 ships the
 * primitive (`decryptPollVote`) but no longer runs it on incoming messages, so
 * without this a vote reaches a consumer as the bare label "poll vote".
 *
 * The awkward part is the JIDs. Since WhatsApp's LID migration the same person
 * is `<phone>@s.whatsapp.net` or `<n>@lid` depending on the chat's addressing
 * mode, and the key is derived from whichever one the voter's client used. We
 * cannot know that up front, so every plausible creator × voter pairing is
 * tried; AES-GCM authenticates, so a wrong guess fails instead of decoding to
 * garbage. Kept pure (no db, no socket) so the crypto is unit-testable.
 */
import {
  decryptPollVote,
  getAggregateVotesInPollMessage,
  jidNormalizedUser,
  type proto,
  type WAMessageContent,
} from 'baileys';

export interface DecryptedPollVote {
  vote: proto.Message.PollVoteMessage;
  creatorJid: string;
  voterJid: string;
}

/** Distinct, device-free user JIDs, in the order given (most likely first). */
export function jidCandidates(...jids: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const jid of jids) {
    if (!jid || !jid.includes('@')) continue;
    const normalized = jidNormalizedUser(jid);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/** Try every creator × voter identity until one decrypts; null when none does. */
export function decryptPollVoteAny(
  encrypted: proto.Message.IPollEncValue,
  poll: { messageId: string; encKey: Uint8Array; creatorJids: string[]; voterJids: string[] },
): DecryptedPollVote | null {
  if (!encrypted.encPayload || !encrypted.encIv) return null;
  for (const creatorJid of poll.creatorJids) {
    for (const voterJid of poll.voterJids) {
      try {
        const vote = decryptPollVote(encrypted, {
          pollCreatorJid: creatorJid,
          pollMsgId: poll.messageId,
          pollEncKey: poll.encKey,
          voterJid,
        });
        return { vote, creatorJid, voterJid };
      } catch {
        // Wrong identity pairing: GCM authentication failed. Try the next one.
      }
    }
  }
  return null;
}

/** The poll creation node, whichever version WhatsApp used. */
export function pollCreation(content: WAMessageContent | null | undefined) {
  return content?.pollCreationMessage ?? content?.pollCreationMessageV2 ?? content?.pollCreationMessageV3 ?? null;
}

/**
 * Option names a vote selects, in the poll's own order. A vote carries only
 * SHA-256 hashes of option names; Baileys' aggregator matches them against the
 * poll. An empty list means the voter withdrew their vote.
 */
export function selectedPollOptions(pollContent: WAMessageContent, vote: proto.Message.IPollVoteMessage): string[] {
  const names = new Set((pollCreation(pollContent)?.options ?? []).map((option) => option.optionName ?? ''));
  return getAggregateVotesInPollMessage({ message: pollContent, pollUpdates: [{ pollUpdateMessageKey: {}, vote }] })
    .filter((option) => option.voters.length > 0 && names.has(option.name))
    .map((option) => option.name);
}
