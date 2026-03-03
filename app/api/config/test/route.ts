import { NextResponse } from "next/server";
import { z } from "zod";

const graphSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  tenantId: z.string().min(1)
});

const cloudflareSchema = z.object({
  apiToken: z.string().min(1),
  accountId: z.string().optional()
});

const bodySchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("graph"), config: graphSchema }),
  z.object({ provider: z.literal("cloudflare"), config: cloudflareSchema })
]);

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = bodySchema.parse(body);

    if (parsed.provider === "graph") {
      const tokenResponse = await fetch(
        `https://login.microsoftonline.com/${encodeURIComponent(parsed.config.tenantId)}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: parsed.config.clientId,
            client_secret: parsed.config.clientSecret,
            scope: "https://graph.microsoft.com/.default",
            grant_type: "client_credentials"
          })
        }
      );

      if (!tokenResponse.ok) {
        const details = await tokenResponse.text();
        return NextResponse.json(
          { ok: false, message: "Graph authentication failed", details },
          { status: 400 }
        );
      }

      return NextResponse.json({ ok: true, message: "Graph API connection successful" });
    }

    const verifyResponse = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${parsed.config.apiToken}`,
        "Content-Type": "application/json"
      }
    });

    const verifyJson = (await verifyResponse.json()) as { success?: boolean; errors?: Array<{ message?: string }> };

    if (!verifyResponse.ok || !verifyJson.success) {
      return NextResponse.json(
        {
          ok: false,
          message: "Cloudflare token verification failed",
          details: verifyJson.errors?.map((item) => item.message).filter(Boolean).join(", ") || "Unknown error"
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true, message: "Cloudflare API connection successful" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ ok: false, message: "Invalid payload", details: error.flatten() }, { status: 400 });
    }

    return NextResponse.json(
      { ok: false, message: "Unexpected error", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
