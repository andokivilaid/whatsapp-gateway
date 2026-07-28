CREATE TABLE "android_instances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT,
    "displayName" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'platinum',
    "providerInstanceId" TEXT,
    "sourceProviderInstanceId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "encryptedControlUrl" TEXT,
    "encryptedControlToken" TEXT,
    "novncUrl" TEXT,
    "encryptedVncPassword" TEXT,
    "encryptedProxyUrl" TEXT,
    "androidVersion" TEXT,
    "whatsappVersion" TEXT,
    "lastHealthAt" TIMESTAMP(3),
    "lastError" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "android_instances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "android_instances_providerInstanceId_key"
ON "android_instances"("providerInstanceId");

CREATE UNIQUE INDEX "android_instances_accountId_key"
ON "android_instances"("accountId");

CREATE UNIQUE INDEX "android_instances_tenantId_idempotencyKey_key"
ON "android_instances"("tenantId", "idempotencyKey");

CREATE INDEX "android_instances_tenantId_status_idx"
ON "android_instances"("tenantId", "status");

ALTER TABLE "android_instances"
ADD CONSTRAINT "android_instances_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "android_instances"
ADD CONSTRAINT "android_instances_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "whatsapp_accounts"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
