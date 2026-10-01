import { NextRequest, NextResponse } from "next/server";
import { runScan } from "@/lib/engine/scanner";
import { PAIRS, TIMEFRAMES, type Pair, type Timeframe } from "@/lib/types";

export const maxDuration = 300;

function parseParams(req: NextRequest, body: Record<string, unknown> | null) {
  const sp = req.nextUrl.searchParams;
  const rawPairs = (body?.pairs as string[] | undefined) ?? sp.get("pairs")?.split(",");
  const rawTfs = (body?.timeframes as string[] | undefined) ?? sp.get("timeframes")?.split(",");
  const pairs = (rawPairs?.length ? rawPairs : PAIRS).filter((p): p is Pair =>
    (PAIRS as readonly string[]).includes(p)
  );
  const timeframes = (rawTfs?.length ? rawTfs : ["M15", "H1"]).filter((t): t is Timeframe =>
    (TIMEFRAMES as readonly string[]).includes(t)
  );
  return { pairs, timeframes };
}

async function handle(req: NextRequest, body: Record<string, unknown> | null) {
  // Vercel cron sends Authorization: Bearer $CRON_SECRET when configured
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}` && !body) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { pairs, timeframes } = parseParams(req, body);
  const summary = await runScan({ pairs, timeframes });
  return NextResponse.json(summary);
}

/** GET — Vercel cron entry point (full scan: all pairs, M15 + H1). */
export async function GET(req: NextRequest) {
  return handle(req, null);
}

/** POST — manual/dashboard trigger. Body: { pairs?: string[], timeframes?: string[] }. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  return handle(req, body);
}
