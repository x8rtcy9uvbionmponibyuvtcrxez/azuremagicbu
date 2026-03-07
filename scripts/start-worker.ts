import { config } from "dotenv";
import { resolve } from "path";

// Load .env files in the same order as Next.js:
// .env first, then .env.local overrides
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), ".env.local"), override: true });

import { prisma } from "@/lib/prisma";
import { startTenantProcessorWorker } from "@/lib/workers/processor";

const worker = startTenantProcessorWorker();

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
    console.error("[Worker] Error while closing worker:", error instanceof Error ? error.message : String(error));
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

console.log("[Worker] Tenant processor worker started");
