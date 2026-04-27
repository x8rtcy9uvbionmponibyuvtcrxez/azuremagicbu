-- CreateTable: ServiceOperation — audit log + execution state for the
-- Services tab (bulk rename / remove / swap / photo-apply). One row per
-- invocation. csvData stores the raw operator input so the op can be
-- re-driven; results stores per-row outcomes for review and retry.
CREATE TABLE "ServiceOperation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "opType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "csvData" TEXT NOT NULL,
    "csvRowCount" INTEGER NOT NULL DEFAULT 0,
    "options" TEXT,
    "results" TEXT,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceOperation_pkey" PRIMARY KEY ("id")
);

-- Indexes for common queries: list ops by tenant, find queued/running ops by type.
CREATE INDEX "ServiceOperation_tenantId_createdAt_idx" ON "ServiceOperation"("tenantId", "createdAt");
CREATE INDEX "ServiceOperation_opType_status_idx" ON "ServiceOperation"("opType", "status");

-- Foreign key: SetNull on tenant delete (audit row survives even if tenant
-- is deleted later, just loses the link).
ALTER TABLE "ServiceOperation" ADD CONSTRAINT "ServiceOperation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
