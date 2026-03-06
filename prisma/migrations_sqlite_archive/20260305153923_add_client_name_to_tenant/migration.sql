-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Tenant" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
INSERT INTO "new_Tenant" ("adminEmail", "adminPassword", "authCode", "authCodeExpiry", "authConfirmed", "batchId", "cloudAppAdminAssigned", "createdAt", "csvUrl", "currentStep", "delegationComplete", "deviceCode", "dkimConfigured", "domain", "domainAdded", "domainDefault", "domainVerified", "encryptionVersion", "errorMessage", "forwardingUrl", "globalAdminAssigned", "id", "inboxCount", "inboxNames", "instantlyConnected", "instantlyConnectedCount", "instantlyFailedCount", "licensedUserId", "licensedUserUpn", "mailboxStatuses", "passwordsSet", "progress", "securityDefaultsDisabled", "servicePrincipalCreated", "setupConfirmed", "sharedMailboxesCreated", "signInEnabled", "smartleadConnected", "smartleadConnectedCount", "smartleadFailedCount", "smtpAuthEnabled", "status", "tenantId", "tenantName", "updatedAt", "zoneId") SELECT "adminEmail", "adminPassword", "authCode", "authCodeExpiry", "authConfirmed", "batchId", "cloudAppAdminAssigned", "createdAt", "csvUrl", "currentStep", "delegationComplete", "deviceCode", "dkimConfigured", "domain", "domainAdded", "domainDefault", "domainVerified", "encryptionVersion", "errorMessage", "forwardingUrl", "globalAdminAssigned", "id", "inboxCount", "inboxNames", "instantlyConnected", "instantlyConnectedCount", "instantlyFailedCount", "licensedUserId", "licensedUserUpn", "mailboxStatuses", "passwordsSet", "progress", "securityDefaultsDisabled", "servicePrincipalCreated", "setupConfirmed", "sharedMailboxesCreated", "signInEnabled", "smartleadConnected", "smartleadConnectedCount", "smartleadFailedCount", "smtpAuthEnabled", "status", "tenantId", "tenantName", "updatedAt", "zoneId" FROM "Tenant";
DROP TABLE "Tenant";
ALTER TABLE "new_Tenant" RENAME TO "Tenant";
CREATE INDEX "Tenant_batchId_status_idx" ON "Tenant"("batchId", "status");
CREATE INDEX "Tenant_domain_idx" ON "Tenant"("domain");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
