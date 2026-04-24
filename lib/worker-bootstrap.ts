import { startTenantProcessorWorker } from "@/lib/workers/processor";
import { startTenantUploadWorker } from "@/lib/workers/uploadWorker";

function isApiBootstrapEnabled(): boolean {
  // Keep cloud behavior explicit: bootstrap in dev by default, or when explicitly enabled.
  if (process.env.NODE_ENV !== "production") {
    return true;
  }
  return process.env.AUTO_START_WORKER_ON_API === "true";
}

export function maybeBootstrapWorkerFromApi(): { attempted: boolean; started: boolean } {
  if (!isApiBootstrapEnabled()) {
    return { attempted: false, started: false };
  }

  startTenantProcessorWorker();
  startTenantUploadWorker();
  return { attempted: true, started: true };
}
