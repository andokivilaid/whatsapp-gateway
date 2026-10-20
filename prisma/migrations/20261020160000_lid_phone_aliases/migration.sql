-- One person, two addresses: WhatsApp reports 1:1 contacts as `<n>@lid` while
-- sends go to `<phone>@s.whatsapp.net`, so one conversation was stored as two
-- chats. Record LID → phone aliases and re-key existing rows onto the phone JID.
-- Every step is idempotent, and the whole migration is one transaction: it
-- rewrites stored rows, so it lands completely or not at all.

BEGIN;

CREATE TABLE "whatsapp_jid_aliases" (
    "accountId" TEXT NOT NULL,
    "lid" TEXT NOT NULL,
    "pnJid" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_jid_aliases_pkey" PRIMARY KEY ("accountId","lid")
);

CREATE INDEX "whatsapp_jid_aliases_accountId_pnJid_idx" ON "whatsapp_jid_aliases"("accountId", "pnJid");

ALTER TABLE "whatsapp_jid_aliases" ADD CONSTRAINT "whatsapp_jid_aliases_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "whatsapp_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 1. Learn pairings from what is already stored. Device suffixes (`:12@`) are
--    stripped; a pairing needs exactly one LID and one phone JID.
WITH candidates AS (
    -- message keys: chat address and its alternate
    SELECT m."accountId", m."messageTimestamp" AS seen,
           m.payload->'key'->>'remoteJid' AS a, m.payload->'key'->>'remoteJidAlt' AS b
    FROM "whatsapp_messages" m
    UNION ALL
    -- message keys: group sender and its alternate
    SELECT m."accountId", m."messageTimestamp",
           m.payload->'key'->>'participant', m.payload->'key'->>'participantAlt'
    FROM "whatsapp_messages" m
    UNION ALL
    -- history-sync conversations
    SELECT c."accountId", c."updatedAt", c.jid, c.metadata->>'pnJid' FROM "whatsapp_chats" c
    UNION ALL
    SELECT c."accountId", c."updatedAt", c.metadata->>'lidJid', c.jid FROM "whatsapp_chats" c
    UNION ALL
    -- contacts
    SELECT k."accountId", k."updatedAt", k.metadata->>'lid', k.jid FROM "whatsapp_contacts" k
    UNION ALL
    SELECT k."accountId", k."updatedAt", k.jid, k.metadata->>'phoneNumber' FROM "whatsapp_contacts" k
),
normalized AS (
    SELECT "accountId", seen,
           regexp_replace(a, ':[0-9]+@', '@') AS a,
           CASE WHEN b IS NOT NULL AND position('@' IN b) = 0 AND regexp_replace(b, '\D', '', 'g') <> ''
                THEN regexp_replace(b, '\D', '', 'g') || '@s.whatsapp.net'
                ELSE regexp_replace(b, ':[0-9]+@', '@') END AS b
    FROM candidates
    WHERE a IS NOT NULL AND b IS NOT NULL
),
pairs AS (
    SELECT "accountId", seen,
           CASE WHEN a LIKE '%@lid' THEN a ELSE b END AS lid,
           CASE WHEN a LIKE '%@lid' THEN b ELSE a END AS pn
    FROM normalized
    WHERE (a LIKE '%@lid' AND b LIKE '%@s.whatsapp.net')
       OR (b LIKE '%@lid' AND a LIKE '%@s.whatsapp.net')
)
INSERT INTO "whatsapp_jid_aliases" ("accountId", "lid", "pnJid", "source", "createdAt", "updatedAt")
SELECT DISTINCT ON ("accountId", lid) "accountId", lid, pn, 'backfill', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM pairs
ORDER BY "accountId", lid, seen DESC
ON CONFLICT ("accountId", "lid") DO NOTHING;

-- 2. Messages: earlier code stored group senders device-qualified (`n:3@lid`),
--    which names a device, not a person. Normalize, then re-key chat and sender.
UPDATE "whatsapp_messages" SET "senderJid" = regexp_replace("senderJid", ':[0-9]+@', '@')
WHERE "senderJid" ~ ':[0-9]+@(lid|s\.whatsapp\.net)$';

UPDATE "whatsapp_messages" SET "chatJid" = regexp_replace("chatJid", ':[0-9]+@', '@')
WHERE "chatJid" ~ ':[0-9]+@(lid|s\.whatsapp\.net)$';

UPDATE "whatsapp_messages" m SET "chatJid" = a."pnJid"
FROM "whatsapp_jid_aliases" a
WHERE m."accountId" = a."accountId" AND m."chatJid" = a.lid;

UPDATE "whatsapp_messages" m SET "senderJid" = a."pnJid"
FROM "whatsapp_jid_aliases" a
WHERE m."accountId" = a."accountId" AND m."senderJid" = a.lid;

-- 3. Chats: fold each LID chat into its phone chat (keeping the phone chat's
--    values, filling gaps from the LID chat), then drop the LID chat.
INSERT INTO "whatsapp_chats" ("accountId", "jid", "name", "unreadCount", "archived", "metadata", "createdAt", "updatedAt")
SELECT DISTINCT ON (c."accountId", a."pnJid")
       c."accountId", a."pnJid", c.name, c."unreadCount", c.archived,
       c.metadata || jsonb_build_object('lid', c.jid), c."createdAt", CURRENT_TIMESTAMP
FROM "whatsapp_chats" c
JOIN "whatsapp_jid_aliases" a ON a."accountId" = c."accountId" AND a.lid = c.jid
ORDER BY c."accountId", a."pnJid", c."updatedAt" DESC
ON CONFLICT ("accountId", "jid") DO UPDATE SET
    "name" = COALESCE("whatsapp_chats".name, EXCLUDED.name),
    "unreadCount" = "whatsapp_chats"."unreadCount" + EXCLUDED."unreadCount",
    "metadata" = EXCLUDED.metadata || "whatsapp_chats".metadata,
    "updatedAt" = CURRENT_TIMESTAMP;

DELETE FROM "whatsapp_chats" c
USING "whatsapp_jid_aliases" a
WHERE a."accountId" = c."accountId" AND a.lid = c.jid;

-- 4. Contacts: same fold; the phone number is now known for certain.
INSERT INTO "whatsapp_contacts" ("accountId", "jid", "name", "notify", "phoneNumber", "metadata", "createdAt", "updatedAt")
SELECT DISTINCT ON (k."accountId", a."pnJid")
       k."accountId", a."pnJid", k.name, k.notify, split_part(a."pnJid", '@', 1),
       k.metadata || jsonb_build_object('lid', k.jid), k."createdAt", CURRENT_TIMESTAMP
FROM "whatsapp_contacts" k
JOIN "whatsapp_jid_aliases" a ON a."accountId" = k."accountId" AND a.lid = k.jid
ORDER BY k."accountId", a."pnJid", k."updatedAt" DESC
ON CONFLICT ("accountId", "jid") DO UPDATE SET
    "name" = COALESCE("whatsapp_contacts".name, EXCLUDED.name),
    "notify" = COALESCE("whatsapp_contacts".notify, EXCLUDED.notify),
    "phoneNumber" = EXCLUDED."phoneNumber",
    "metadata" = EXCLUDED.metadata || "whatsapp_contacts".metadata,
    "updatedAt" = CURRENT_TIMESTAMP;

DELETE FROM "whatsapp_contacts" k
USING "whatsapp_jid_aliases" a
WHERE a."accountId" = k."accountId" AND a.lid = k.jid;

-- A LID's user part is not a phone number; earlier code stored it as one.
UPDATE "whatsapp_contacts" SET "phoneNumber" = NULL
WHERE jid LIKE '%@lid' AND "phoneNumber" IS NOT NULL;

-- 5. Every stored conversation gets a chat row (inbound-only LID threads had none).
INSERT INTO "whatsapp_chats" ("accountId", "jid", "createdAt", "updatedAt")
SELECT m."accountId", m."chatJid", MIN(m."messageTimestamp"), CURRENT_TIMESTAMP
FROM "whatsapp_messages" m
WHERE m."chatJid" LIKE '%@s.whatsapp.net' OR m."chatJid" LIKE '%@lid' OR m."chatJid" LIKE '%@g.us'
GROUP BY m."accountId", m."chatJid"
ON CONFLICT ("accountId", "jid") DO NOTHING;

-- 6. Push names are often the only name WhatsApp ever gives a contact: keep the
--    latest one per inbound sender where no name is recorded yet.
INSERT INTO "whatsapp_contacts" ("accountId", "jid", "notify", "phoneNumber", "createdAt", "updatedAt")
SELECT DISTINCT ON (m."accountId", m."senderJid")
       m."accountId", m."senderJid", m.payload->>'pushName',
       CASE WHEN m."senderJid" LIKE '%@s.whatsapp.net' THEN split_part(m."senderJid", '@', 1) END,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "whatsapp_messages" m
WHERE m.direction = 'inbound'
  AND m."senderJid" IS NOT NULL
  AND (m."senderJid" LIKE '%@s.whatsapp.net' OR m."senderJid" LIKE '%@lid')
  AND COALESCE(btrim(m.payload->>'pushName'), '') <> ''
ORDER BY m."accountId", m."senderJid", m."messageTimestamp" DESC
ON CONFLICT ("accountId", "jid") DO UPDATE SET
    "notify" = COALESCE("whatsapp_contacts".notify, EXCLUDED.notify),
    "updatedAt" = CURRENT_TIMESTAMP;

COMMIT;
