import { WebSocket } from "ws";
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

import { createAdminClient } from "@/lib/supabase/admin";

async function main() {
  const supabase = createAdminClient();
  if (!supabase) {
    console.error("Supabase admin client not available");
    process.exit(1);
  }
  console.log("Clearing signals table…");
  const { error } = await supabase.from("signals").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (error) {
    console.error("Failed to clear signals:", error.message);
    process.exit(1);
  }
  console.log("Signals table cleared.");
}

main();
