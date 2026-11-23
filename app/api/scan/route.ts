import { NextRequest, NextResponse } from "next/server";
import { runScan } from "@/lib/engine/scanner";
import { isAuthorizedMutation } from "@/lib/apiGuard";
import { PAIRS, type Pair } from "@/lib/types";

export const maxDuration = 60; // Hobby plan cap

function parsePairs(req: NextRequest, body: Record<string, unknown> | null): Pair[] {
  const raw = (body?.pairs as string[] | undefined) ?? req.nextUrl.searchParams.get("pairs")?.split(",");
  return (raw?.length ? raw : [...PAIRS]).filter((p): p is Pair => (PAIRS as readonly string[]).includes(p));
}

async function handle(req: NextRequest, body: Record<string, unknown> | null) {
  // the scheduler sends Authorization: Bearer $CRON_SECRET
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}` && !body) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runScan({ pairs: parsePairs(req, body) }));
}

/** GET — the scheduler's entry point, every 15 minutes. */
export async function GET(req: NextRequest) {
  return handle(req, null);
}

/** POST — manual/dashboard trigger. Body: { pairs?: string[] }.
 *  The POST path bypasses the cron bearer (the dashboard can't hold a secret)
 *  but must be same-origin or carry the cron secret. */
export async function POST(req: NextRequest) {
  if (!isAuthorizedMutation(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  return handle(req, body);
}
