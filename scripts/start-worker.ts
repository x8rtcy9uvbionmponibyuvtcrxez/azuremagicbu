import { config } from "dotenv";
import { resolve } from "path";

// Load .env files in the same order as Next.js:
// .env first, then .env.local overrides
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), ".env.local"), override: true });

import { prisma } from "@/lib/prisma";
import { startTenantProcessorWorker } from "@/lib/workers/processor";
import { startTenantUploadWorker } from "@/lib/workers/uploadWorker";

const worker = startTenantProcessorWorker();
const uploadWorker = startTenantUploadWorker();

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[Worker] Received ${signal}. Shutting down...`);

  try {
    await worker.close();
  } catch (error) {
    console.error("[Worker] Error while closing tenant processor:", error instanceof Error ? error.message : String(error));
  }

  try {
    await uploadWorker.close();
  } catch (error) {
    console.error("[Worker] Error while closing upload worker:", error instanceof Error ? error.message : String(error));
  }

  try {
    await prisma.$disconnect();
  } catch (error) {
    console.error("[Worker] Error while disconnecting Prisma:", error instanceof Error ? error.message : String(error));
  }

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  console.error("[Worker] Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[Worker] Uncaught exception:", error);
});

console.log("[Worker] Tenant processor + upload workers started");
void uploadWorker; // retained reference — prevents tree-shaking
