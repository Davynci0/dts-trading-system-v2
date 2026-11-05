import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedMutation } from "@/lib/apiGuard";
import { sendTelegramMessage } from "@/lib/telegram";

/**
 * POST /api/telegram/test
 * Stage 1 wiring check: proves bot token + chat ID work end-to-end.
 * Same-origin dashboard use or cron-secret bearer only.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedMutation(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  try {
    await sendTelegramMessage("✅ DTS wiring test — Telegram bot connected.");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 502 }
    );
  }
}
