import { NextRequest, NextResponse } from "next/server";
import { scoreOpenSignals } from "@/lib/engine/outcomes";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

/**
 * GET /api/watch — the one-minute check of the open trade.
 *
 * The scan (/api/scan) runs every 15 minutes, on the close of a candle. In
 * between, this follows the open trade minute by minute: the moment price has
 * touched the profit-lock trigger, the "move your stop" message goes to
 * Telegram, and a trade that has reached its stop or target is closed in the
 * feed. With no trade open it reads one row count and returns — no market data
 * is fetched.
 *
 * The scheduler calls it every minute with `Authorization: Bearer $CRON_SECRET`,
 * like the scan. Without that job the same check still runs on every scan, so
 * the message then comes up to 15 minutes later, as it did before.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const supabase = createAdminClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "the database is not configured" }, { status: 503 });
  try {
    const settled = await scoreOpenSignals(supabase, { force: true, fast: true });
    return NextResponse.json({ ok: true, settled, at: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 160) }, { status: 500 });
  }
}
