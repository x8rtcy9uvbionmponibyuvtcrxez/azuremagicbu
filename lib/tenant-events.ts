import { prisma } from "@/lib/prisma";

export type TenantEventLevel = "info" | "warn" | "error";

type LogTenantEventInput = {
  batchId: string;
  tenantId?: string | null;
  eventType: string;
  message: string;
  level?: TenantEventLevel;
  details?: unknown;
};

function serializeDetails(details: unknown): string | null {
  if (details === undefined) return null;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

export async function logTenantEvent(input: LogTenantEventInput): Promise<void> {
  try {
    await prisma.tenantEvent.create({
      data: {
        batchId: input.batchId,
        tenantId: input.tenantId || null,
        level: input.level || "info",
        eventType: input.eventType,
        message: input.message,
        details: serializeDetails(input.details)
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[TenantEvent] Failed to log ${input.eventType}: ${message}`);
  }
}
