-- CreateTable
CREATE TABLE "TenantEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "tenantId" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantEvent_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TenantEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TenantEvent_batchId_createdAt_idx" ON "TenantEvent"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "TenantEvent_tenantId_createdAt_idx" ON "TenantEvent"("tenantId", "createdAt");
