-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('uploading', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('queued', 'cloudflare', 'tenant_prep', 'auth_pending', 'domain_add', 'domain_verify', 'licensed_user', 'mailboxes', 'mailbox_config', 'dkim_config', 'sequencer_connect', 'completed', 'failed');

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
    "clientName" TEXT NOT NULL DEFAULT 'Unknown',
    "adminEmail" TEXT NOT NULL,
    "adminPassword" TEXT NOT NULL,
    "encryptionVersion" INTEGER NOT NULL DEFAULT 1,
    "domain" TEXT NOT NULL,
    "inboxNames" TEXT NOT NULL,
    "inboxCount" INTEGER NOT NULL DEFAULT 99,
    "forwardingUrl" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "currentStep" TEXT,
    "zoneId" TEXT,
    "tenantId" TEXT,
    "authCode" TEXT,
    "deviceCode" TEXT,
    "authCodeExpiry" TIMESTAMP(3),
    "authConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "setupConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "securityDefaultsDisabled" BOOLEAN NOT NULL DEFAULT false,
    "servicePrincipalCreated" BOOLEAN NOT NULL DEFAULT false,
    "globalAdminAssigned" BOOLEAN NOT NULL DEFAULT false,
    "domainAdded" BOOLEAN NOT NULL DEFAULT false,
    "domainVerified" BOOLEAN NOT NULL DEFAULT false,
    "domainDefault" BOOLEAN NOT NULL DEFAULT false,
    "dkimConfigured" BOOLEAN NOT NULL DEFAULT false,
    "licensedUserId" TEXT,
    "licensedUserUpn" TEXT,
    "sharedMailboxesCreated" BOOLEAN NOT NULL DEFAULT false,
    "passwordsSet" BOOLEAN NOT NULL DEFAULT false,
    "smtpAuthEnabled" BOOLEAN NOT NULL DEFAULT false,
    "delegationComplete" BOOLEAN NOT NULL DEFAULT false,
    "signInEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cloudAppAdminAssigned" BOOLEAN NOT NULL DEFAULT false,
    "mailboxStatuses" TEXT,
    "smartleadConnected" BOOLEAN NOT NULL DEFAULT false,
    "instantlyConnected" BOOLEAN NOT NULL DEFAULT false,
    "smartleadConnectedCount" INTEGER NOT NULL DEFAULT 0,
    "smartleadFailedCount" INTEGER NOT NULL DEFAULT 0,
    "instantlyConnectedCount" INTEGER NOT NULL DEFAULT 0,
    "instantlyFailedCount" INTEGER NOT NULL DEFAULT 0,
    "csvUrl" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantEvent" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "tenantId" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tenant_batchId_status_idx" ON "Tenant"("batchId", "status");

-- CreateIndex
CREATE INDEX "Tenant_domain_idx" ON "Tenant"("domain");

-- CreateIndex
CREATE INDEX "TenantEvent_batchId_createdAt_idx" ON "TenantEvent"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "TenantEvent_tenantId_createdAt_idx" ON "TenantEvent"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantEvent" ADD CONSTRAINT "TenantEvent_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantEvent" ADD CONSTRAINT "TenantEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

