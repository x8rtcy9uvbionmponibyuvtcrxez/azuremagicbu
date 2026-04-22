import { NextResponse } from "next/server";

import { diagnoseTenant } from "@/lib/services/diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  params: {
    id: string;
  };
};

// GET is read-only; POST is accepted too for form-style callers.
export async function GET(_request: Request, { params }: Params) {
  try {
    const result = await diagnoseTenant(params.id);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "Tenant not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request, params: Params) {
  return GET(request, params);
}
