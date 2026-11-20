"use client";

import { useEffect, useState } from "react";

/**
 * The site clock, shown on every page: the date, the viewer's local time with
 * its time zone, UTC (the scanner and the candles run on UTC), and how long
 * the current chart candle has left — a new signal can only arrive when it
 * closes.
 */
export default function Clock({ barSeconds, timeframe }: { barSeconds: number; timeframe: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  // rendered on the client only: the server does not know the viewer's time zone
  if (now == null) return <span className="ml-auto font-mono text-xs text-neutral-700">--:--:--</span>;

  const d = new Date(now);
  const date = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const local = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "local";
  const utc = d.toISOString().slice(11, 19);
  // candles are aligned to the clock, so the time left is the remainder of the bar length
  const left = barSeconds - (Math.floor(now / 1000) % barSeconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  const countdown = left >= 3600 ? `${Math.floor(left / 3600)}:${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}` : `${pad(Math.floor(left / 60))}:${pad(left % 60)}`;

  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-0.5 font-mono text-xs text-neutral-400">
      <span className="text-neutral-500">{date}</span>
      <span title="Your local time">
        <span className="text-neutral-100">{local}</span> {zone}
      </span>
      <span title="UTC — the time the scanner and the candles use">
        <span className="text-neutral-200">{utc}</span> UTC
      </span>
      <span title={`Time left on the current ${timeframe} candle. A signal can only arrive when it closes.`} className={left <= 60 ? "text-amber-300" : ""}>
        {timeframe} candle closes in <span className="text-neutral-100">{countdown}</span>
      </span>
    </div>
  );
}
