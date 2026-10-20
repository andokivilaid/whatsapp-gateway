/**
 * Outbound receipt updates are not ordered. A delayed SERVER_ACK (2) must not
 * erase a READ (4) that already landed. Ranks follow Baileys'
 * `WebMessageInfo.Status`. `received` is the placeholder written when a message
 * is first stored, so any real receipt replaces it. `deleted` is terminal.
 * Anything else that is not a known status is left alone.
 */

const NAMED_STATUS_RANK: Record<string, number> = {
  error: 0,
  pending: 1,
  server_ack: 2,
  delivery_ack: 3,
  read: 4,
  played: 5,
  received: -1,
  deleted: Number.POSITIVE_INFINITY,
};

export function messageStatusRank(status: string): number | null {
  const trimmed = status.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const named = NAMED_STATUS_RANK[trimmed.toLowerCase()];
  return named === undefined ? null : named;
}

function statusToken(rank: number): string {
  if (rank === Number.POSITIVE_INFINITY) return 'deleted';
  if (rank === -1) return 'received';
  return String(rank);
}

/**
 * The status to store. Returns `current` when `incoming` is missing, unknown,
 * or would move the receipt backwards.
 */
export function resolveMessageStatus(current: string, incoming: string | number | null | undefined): string {
  if (incoming === undefined || incoming === null) return current;
  const incomingText = String(incoming).trim();
  if (!incomingText) return current;
  const nextRank = messageStatusRank(incomingText);
  if (nextRank === null) return current;
  const currentRank = messageStatusRank(current);
  if (currentRank !== null && nextRank <= currentRank) return current;
  return statusToken(nextRank);
}
