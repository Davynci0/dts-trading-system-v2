"use client";

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/types";
import { pipSize } from "@/lib/analysis/confirmations";

const fmtPips = (price: number, pair: string) => (price / pipSize(pair)).toFixed(1);
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Per-strategy outcome record, split by status: "would the skip have won?" is
 * the skip success rate; active-signal win rate is the live score. */
function successStats(signals: Signal[]) {
  const by = new Map<string, { firedWin: number; firedLoss: number; skipWin: number; skipLoss: number }>();
  for (const s of signals) {
    if (s.outcome !== "win" && s.outcome !== "loss") continue;
    const b = by.get(s.strategy) ?? { firedWin: 0, firedLoss: 0, skipWin: 0, skipLoss: 0 };
    if (s.status === "skipped") {
      if (s.outcome === "win") b.skipWin++;
      else b.skipLoss++;
    } else {
      if (s.outcome === "win") b.firedWin++;
      else b.firedLoss++;
    }
    by.set(s.strategy, b);
  }
  return [...by.entries()];
}

/**
 * Signal feed (Section 9). Reads signals written by the scanner via
 * /api/signals (service role server-side; the anon key never sees them).
 */
export default function SignalFeed() {
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetch("/api/signals")
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j.error) setError(j.error);
          else setSignals((j.signals ?? []) as Signal[]);
        })
        .catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const notice = error;
  const stats = signals ? successStats(signals) : [];

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <h2 className="mb-3 text-sm font-semibold text-neutral-100">Signal Feed</h2>
      {stats.length > 0 && (
        <div className="mb-3 space-y-0.5 rounded border border-neutral-800 bg-neutral-950 p-2">
          {stats.map(([strategy, b]) => {
            const firedTotal = b.firedWin + b.firedLoss;
            const skipTotal = b.skipWin + b.skipLoss;
            return (
              <div key={strategy} className="flex justify-between text-[10px] text-neutral-400">
                <span className="capitalize">{strategy}</span>
                <span>
                  {firedTotal > 0 && `signals ${b.firedWin}/${firedTotal} won (${Math.round((100 * b.firedWin) / firedTotal)}%)`}
                  {firedTotal > 0 && skipTotal > 0 && " · "}
                  {skipTotal > 0 && `skips ${b.skipWin}/${skipTotal} would have won (${Math.round((100 * b.skipWin) / skipTotal)}%)`}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {notice && <p className="text-xs text-amber-400">{notice}</p>}
      {!notice && signals?.length === 0 && (
        <p className="text-xs text-neutral-500">
          No signals yet — trigger a scan to run the engine.
        </p>
      )}
      <ul className="space-y-2">
        {signals?.map((s) => (
          <li
            key={s.id}
            className={`rounded border p-2 text-xs ${
              s.status === "skipped"
                ? "border-amber-900/60 bg-amber-950/30"
                : "border-neutral-800 bg-neutral-950"
            }`}
          >
            <div className="flex justify-between">
              <span className="font-medium text-neutral-200">
                {s.pair.replace("_", "/")}{" "}
                <span className={s.direction === "long" ? "text-teal-400" : "text-red-400"}>
                  {s.direction.toUpperCase()}
                </span>
              </span>
              <span className="text-neutral-500">
                {fmtTime(s.created_at)} · {s.strategy} · {s.confidence}/5
                {s.confidence >= 4 ? " ★" : ""}
                {s.status === "skipped" ? " · SKIPPED" : ""}
              </span>
            </div>
            {s.stop_loss > 0 && s.take_profit > 0 && (
              <div className="mt-1 font-mono text-neutral-400">
                E {s.entry} · SL {s.stop_loss} · TP {s.take_profit}
                {s.r_multiple != null && ` · ${s.r_multiple.toFixed(2)}R`}
              </div>
            )}
            {s.stop_loss > 0 && s.take_profit > 0 && (
              <div className="mt-0.5 text-neutral-300">
                Risk {fmtPips(Math.abs(s.entry - s.stop_loss), s.pair)} pips → make{" "}
                {fmtPips(Math.abs(s.take_profit - s.entry), s.pair)} pips
              </div>
            )}
            {(s.sl_basis || s.tp_basis) && (
              <div className="mt-0.5 text-neutral-500">
                SL {s.sl_basis ?? "—"} · TP at {s.tp_basis ?? "—"}
              </div>
            )}
            {s.status === "skipped" && (
              <div className="mt-1 text-amber-400/80">{s.skip_reason}</div>
            )}
            {s.outcome && (
              <div
                className={`mt-1 font-medium ${
                  s.outcome === "win"
                    ? "text-teal-400"
                    : s.outcome === "loss"
                      ? "text-red-400"
                      : "text-neutral-500"
                }`}
              >
                {s.status === "skipped"
                  ? s.outcome === "win"
                    ? `↳ Would have hit TP ${s.outcome_price ?? ""} — +${s.outcome_r?.toFixed(2)}R (this skip missed a winner)`
                    : s.outcome === "loss"
                      ? `↳ Would have hit SL ${s.outcome_price ?? ""} — −1R (good skip)`
                      : "↳ Expired without touching TP/SL"
                  : s.outcome === "win"
                    ? `↳ Hit TP ${s.outcome_price ?? ""} — +${s.outcome_r?.toFixed(2)}R`
                    : s.outcome === "loss"
                      ? `↳ Hit SL ${s.outcome_price ?? ""} — −1R`
                      : "↳ Expired without touching TP/SL"}
                {s.outcome_at && s.outcome !== "expired" && ` · ${fmtTime(s.outcome_at)}`}
              </div>
            )}
            {!s.outcome && s.stop_loss > 0 && (
              <div className="mt-1 text-neutral-600">↳ outcome pending…</div>
            )}
            {s.vision_note && (
              <div className="mt-1 text-neutral-500">AI: {s.vision_note}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
