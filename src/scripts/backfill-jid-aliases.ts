import { prisma } from '../db/prisma.js';
import { backfillAccountJidAliases, type JidBackfillReport } from '../baileys/jid-alias-store.js';

/**
 * Fold split LID / phone threads back into one chat per person.
 *
 *   pnpm backfill:jid-aliases --dry-run
 *   pnpm backfill:jid-aliases --account wa_...
 *   pnpm exec tsx src/scripts/backfill-jid-aliases.ts
 *
 * Reads mappings already present on stored message keys (`remoteJidAlt` and
 * the other explicit LID/phone alternates) plus chat and contact metadata.
 * Writes aliases, re-keys messages onto the phone JID, and merges chat and
 * contact rows. Running it again is a no-op once the data matches.
 */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function emptyTotals(): Omit<JidBackfillReport, 'accountId' | 'conflictLids'> & { accounts: number; conflictLids: string[] } {
  return {
    accounts: 0,
    dryRun: false,
    pairs: 0,
    conflicts: 0,
    aliases: 0,
    messages: 0,
    chats: 0,
    chatDeletes: 0,
    contacts: 0,
    contactDeletes: 0,
    conflictLids: [],
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const onlyAccount = flag('--account');
  const accounts = onlyAccount
    ? [{ id: onlyAccount }]
    : await prisma.whatsAppAccount.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } });

  const totals = emptyTotals();
  totals.dryRun = dryRun;
  for (const account of accounts) {
    const report = await backfillAccountJidAliases(account.id, { dryRun });
    totals.accounts += 1;
    totals.pairs += report.pairs;
    totals.conflicts += report.conflicts;
    totals.aliases += report.aliases;
    totals.messages += report.messages;
    totals.chats += report.chats;
    totals.chatDeletes += report.chatDeletes;
    totals.contacts += report.contacts;
    totals.contactDeletes += report.contactDeletes;
    totals.conflictLids.push(...report.conflictLids);
    console.log(JSON.stringify(report));
  }
  console.log(JSON.stringify({ ...totals, conflictLids: totals.conflictLids.slice(0, 20) }));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
