-- AlterTable: Tenant — per-tenant profile-photo rollup state
-- Tracks completion at the tenant level so the UI can show "all 50 mailboxes
-- got their photos" without iterating personas. Failed/Completed counts mirror
-- the existing instantlyConnected/smartleadConnected pattern.
ALTER TABLE "Tenant" ADD COLUMN "profilePhotosApplied" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tenant" ADD COLUMN "profilePhotosCompleted" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN "profilePhotosFailed" INTEGER;

-- CreateTable: TenantPersona — one row per unique inboxName for a tenant.
-- Holds the photo binary (BYTEA) plus apply-status fields. Photos are at
-- most a few hundred KB each (Microsoft Graph caps at 4 MB) so storing
-- inline in Postgres is fine at our scale.
CREATE TABLE "TenantPersona" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "personaName" TEXT NOT NULL,
    "photoData" BYTEA,
    "photoMime" TEXT,
    "photoSize" INTEGER,
    "photoApplied" BOOLEAN NOT NULL DEFAULT false,
    "applyError" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantPersona_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantPersona_tenantId_personaName_key" ON "TenantPersona"("tenantId", "personaName");
CREATE INDEX "TenantPersona_tenantId_idx" ON "TenantPersona"("tenantId");

-- AddForeignKey: cascade on tenant delete (no orphan personas)
ALTER TABLE "TenantPersona" ADD CONSTRAINT "TenantPersona_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
