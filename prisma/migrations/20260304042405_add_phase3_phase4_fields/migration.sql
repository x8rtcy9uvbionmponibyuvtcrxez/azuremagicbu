-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TenantStatus" ADD VALUE 'mailbox_config';
ALTER TYPE "TenantStatus" ADD VALUE 'dkim_config';
ALTER TYPE "TenantStatus" ADD VALUE 'sequencer_connect';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "cloudAppAdminAssigned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "delegationComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "instantlyConnected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "instantlyConnectedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "instantlyFailedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "passwordsSet" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sharedMailboxesCreated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "signInEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "smartleadConnected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "smartleadConnectedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "smartleadFailedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "smtpAuthEnabled" BOOLEAN NOT NULL DEFAULT false;
