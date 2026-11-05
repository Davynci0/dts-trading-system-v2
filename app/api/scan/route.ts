import { NextRequest, NextResponse } from "next/server";
import { runScan } from "@/lib/engine/scanner";
import { isAuthorizedMutation } from "@/lib/apiGuard";
import { PAIRS, TRADE_TIMEFRAMES, type Pair, type Timeframe } from "@/lib/types";

export const maxDuration = 60; // Hobby plan cap — 9 pairs scan concurrently well inside this

function parseParams(req: NextRequest, body: Record<string, unknown> | null) {
  const sp = req.nextUrl.searchParams;
  const rawPairs = (body?.pairs as string[] | undefined) ?? sp.get("pairs")?.split(",");
  const pairs = (rawPairs?.length ? rawPairs : [...PAIRS]).filter((p): p is Pair =>
    (PAIRS as readonly string[]).includes(p)
  );
  // The scanner only runs on M15 execution timeframe; any other timeframe is ignored.
  const timeframes: Timeframe[] = [...TRADE_TIMEFRAMES];
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

/** GET — Vercel cron entry point (full scan: all pairs, M15 only). */
export async function GET(req: NextRequest) {
  return handle(req, null);
}

/** POST — manual/dashboard trigger. Body: { pairs?: string[], timeframes?: string[] }.
 *  The POST path bypasses the cron bearer (the dashboard can't hold a secret)
 *  but must be same-origin or carry the cron secret. */
export async function POST(req: NextRequest) {
  if (!isAuthorizedMutation(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  return handle(req, body);
}
