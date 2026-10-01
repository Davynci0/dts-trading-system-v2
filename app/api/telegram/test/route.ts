import { NextResponse } from "next/server";
import { sendTelegramMessage } from "@/lib/telegram";

/**
 * POST /api/telegram/test
 * Stage 1 wiring check: proves bot token + chat ID work end-to-end.
 */
export async function POST() {
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
