-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "globalAdminAssigned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "securityDefaultsDisabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "servicePrincipalCreated" BOOLEAN NOT NULL DEFAULT false;
