-- CreateEnum
CREATE TYPE "UploaderEsp" AS ENUM ('instantly', 'smartlead');

-- CreateEnum
CREATE TYPE "UploaderStatus" AS ENUM ('idle', 'queued', 'running', 'completed', 'failed');

-- AlterTable: Batch — per-batch uploader config (credentials encrypted at the app layer)
ALTER TABLE "Batch" ADD COLUMN "uploaderEsp" "UploaderEsp";
ALTER TABLE "Batch" ADD COLUMN "uploaderAutoTrigger" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Batch" ADD COLUMN "uploaderWorkers" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Batch" ADD COLUMN "instantlyEmail" TEXT;
ALTER TABLE "Batch" ADD COLUMN "instantlyPassword" TEXT;
ALTER TABLE "Batch" ADD COLUMN "instantlyV1Key" TEXT;
ALTER TABLE "Batch" ADD COLUMN "instantlyV2Key" TEXT;
ALTER TABLE "Batch" ADD COLUMN "instantlyWorkspace" TEXT;
ALTER TABLE "Batch" ADD COLUMN "instantlyApiVersion" TEXT DEFAULT 'v1';
ALTER TABLE "Batch" ADD COLUMN "smartleadApiKey" TEXT;
ALTER TABLE "Batch" ADD COLUMN "smartleadLoginUrl" TEXT;

-- AlterTable: Tenant — per-tenant uploader tracking
ALTER TABLE "Tenant" ADD COLUMN "uploaderJobId" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "uploaderStatus" "UploaderStatus" NOT NULL DEFAULT 'idle';
ALTER TABLE "Tenant" ADD COLUMN "uploaderQueuedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "uploaderStartedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "uploaderCompletedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "uploaderTotal" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN "uploaderSucceeded" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN "uploaderFailed" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN "uploaderSkipped" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN "uploaderWarnings" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN "uploaderErrorMessage" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "uploaderLastLogAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Tenant_uploaderStatus_idx" ON "Tenant"("uploaderStatus");
