-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TenantStatus" ADD VALUE 'domain_add';
ALTER TYPE "TenantStatus" ADD VALUE 'domain_verify';
ALTER TYPE "TenantStatus" ADD VALUE 'licensed_user';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "dkimConfigured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "domainAdded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "domainDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "domainVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "licensedUserId" TEXT,
ADD COLUMN     "licensedUserUpn" TEXT;
