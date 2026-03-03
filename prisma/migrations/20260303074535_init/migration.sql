-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('uploading', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('queued', 'cloudflare', 'tenant_prep', 'auth_pending', 'mailboxes', 'completed', 'failed');

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'uploading',
    "totalCount" INTEGER NOT NULL,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "tenantName" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "adminPassword" TEXT NOT NULL,
    "encryptionVersion" INTEGER NOT NULL DEFAULT 1,
    "domain" TEXT NOT NULL,
    "inboxNames" JSONB NOT NULL,
    "inboxCount" INTEGER NOT NULL DEFAULT 99,
    "forwardingUrl" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "currentStep" TEXT,
    "zoneId" TEXT,
    "tenantId" TEXT,
    "authCode" TEXT,
    "authCodeExpiry" TIMESTAMP(3),
    "authConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "setupConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "csvUrl" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tenant_batchId_status_idx" ON "Tenant"("batchId", "status");

-- CreateIndex
CREATE INDEX "Tenant_domain_idx" ON "Tenant"("domain");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
