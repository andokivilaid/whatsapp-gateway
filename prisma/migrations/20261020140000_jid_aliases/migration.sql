-- LID ↔ phone aliases, and the alternate JID stored on the canonical chat,
-- contact, and message rows. Existing threads are re-keyed by
-- `pnpm backfill:jid-aliases`, which reads mappings out of stored payloads.
ALTER TABLE "whatsapp_chats" ADD COLUMN "alternateJid" TEXT;

ALTER TABLE "whatsapp_contacts" ADD COLUMN "alternateJid" TEXT;

ALTER TABLE "whatsapp_messages" ADD COLUMN "alternateChatJid" TEXT;

CREATE INDEX "whatsapp_messages_accountId_alternateChatJid_idx"
ON "whatsapp_messages"("accountId", "alternateChatJid");

CREATE TABLE "whatsapp_jid_aliases" (
    "accountId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "canonicalJid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_jid_aliases_pkey" PRIMARY KEY ("accountId", "jid")
);

CREATE INDEX "whatsapp_jid_aliases_accountId_canonicalJid_idx"
ON "whatsapp_jid_aliases"("accountId", "canonicalJid");

ALTER TABLE "whatsapp_jid_aliases"
    ADD CONSTRAINT "whatsapp_jid_aliases_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "whatsapp_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
