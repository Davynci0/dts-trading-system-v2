import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** GET /api/setups — active setup states (drives the live confirmation tracker). */
export async function GET() {
  try {
    const supabase = createAdminClient();
    if (!supabase) return NextResponse.json({ setups: [], configured: false });

    const { data, error } = await supabase
      .from("market_state")
      .select("pair, timeframe, dedupe_key, payload, updated_at")
      .eq("kind", "setup")
      .order("updated_at", { ascending: false })
      .limit(300);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ setups: data ?? [], configured: true });
  } catch (e) {
    // transient Supabase/network blip — the poller retries in 30s; don't flash a 500 in the UI
    return NextResponse.json({ setups: [], configured: true, warning: (e as Error).message });
  }
}
