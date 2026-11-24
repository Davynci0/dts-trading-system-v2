"use client";

/** Tori Trades' trendlines on the 4-hour chart — what is drawn, and what the last 4-hour candle did. Alerts only, never a trade of the system. */
export interface ToriSummary {
  lines: { kind: "down" | "up"; touches: number; now: number }[];
  safetyLong: number | null;
  safetyShort: number | null;
  event: { type: "break" | "bounce"; direction: "long" | "short"; kind: "down" | "up"; touches: number; close: number; time: number; stop: number | null; safety: number | null } | null;
  readAt: number;
}

export default function ToriPanel({ tori, digits = 2 }: { tori: ToriSummary | null; digits?: number }) {
  if (!tori) return null;
  const px = (n: number | null) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits));
  const at = (s: number) => new Date(s * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const e = tori.event;
  return (
    <div className="rounded-lg border border-violet-500/30 bg-neutral-900/60 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-violet-300">Tori trendlines (4-hour)</h2>
        <span className="text-[10px] text-neutral-500">alerts only</span>
      </div>
      {e ? (
        <p className="mt-2 rounded border border-violet-500/40 bg-violet-500/10 p-2 text-xs text-violet-200">
          {e.type === "break"
            ? `A ${e.touches}-touch ${e.kind} line broke — her ${e.direction === "long" ? "buy" : "sell"} idea`
            : `Touch ${e.touches + 1} of a ${e.kind} line — her ${e.direction === "long" ? "buy" : "sell"} bounce idea`}
          {` · close ${px(e.close)} · her stop ${px(e.stop)} (${at(e.time)})`}
        </p>
      ) : (
        <p className="mt-2 text-xs text-neutral-500">No setup on the 4-hour candle that closed {at(tori.readAt)}.</p>
      )}
      <ul className="mt-3 space-y-1 font-mono text-[11px] text-neutral-400">
        {tori.lines.length === 0 && <li>no trendline with a week of data yet</li>}
        {tori.lines.map((l, k) => (
          <li key={k} className="flex justify-between">
            <span>
              {l.kind} line · {l.touches} touches{l.touches >= 3 ? " — a break is her setup" : ""}
            </span>
            <span>{px(l.now)}</span>
          </li>
        ))}
        <li className="flex justify-between text-neutral-500">
          <span>safety line for a buy / a sell</span>
          <span>
            {px(tori.safetyLong)} / {px(tori.safetyShort)}
          </span>
        </li>
      </ul>
      <p className="mt-3 text-[10px] leading-relaxed text-neutral-600">
        Her rules: a full-bodied 4-hour close through a line with 3+ touches and a week of data — a broken down line is a buy idea, a broken up line a sell idea; the stop goes beyond the opposing trendline (the safety line), moved to break-even once in profit and trailed behind new lines; or the third touch of a line as a bounce. Breaks (about three a month on gold) are sent to Telegram; bounces are shown here only. On five years of gold the break was about break-even, so these are alerts for your own judgment, not system signals.
      </p>
    </div>
  );
}
