-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "totalCount" INTEGER NOT NULL,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "tenantName" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "adminPassword" TEXT NOT NULL,
    "encryptionVersion" INTEGER NOT NULL DEFAULT 1,
    "domain" TEXT NOT NULL,
    "inboxNames" TEXT NOT NULL,
    "inboxCount" INTEGER NOT NULL DEFAULT 99,
    "forwardingUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "currentStep" TEXT,
    "zoneId" TEXT,
    "tenantId" TEXT,
    "authCode" TEXT,
    "deviceCode" TEXT,
    "authCodeExpiry" DATETIME,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tenant_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Tenant_batchId_status_idx" ON "Tenant"("batchId", "status");

-- CreateIndex
CREATE INDEX "Tenant_domain_idx" ON "Tenant"("domain");
