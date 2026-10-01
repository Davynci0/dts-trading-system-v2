import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { scoreOpenSignals } from "@/lib/engine/outcomes";

export const maxDuration = 30;

/** GET /api/signals — latest 50 signal rows (service role; browser never sees the key). */
export async function GET() {
  try {
    const supabase = createAdminClient();
    if (!supabase) return NextResponse.json({ signals: [], configured: false });

    // settle anything that has hit TP/SL since the last look (throttled to once a minute)
    await scoreOpenSignals(supabase).catch(() => 0);

    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ signals: data ?? [], configured: true });
  } catch (e) {
    // transient Supabase/network blip — the poller retries in 30s; don't flash a 500 in the UI
    return NextResponse.json({ signals: [], configured: true, warning: (e as Error).message });
  }
}
