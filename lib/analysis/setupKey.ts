import type { ScoreResult } from "./scoring";

const TIME_BUCKET_S = 3600; // 1 hour — keeps a setup stable across small swing extensions

function bucketTime(t: number): number {
  return Math.round(t / TIME_BUCKET_S) * TIME_BUCKET_S;
}

/** Identity of a setup — one signal per swing/zone/line, shared by the live scanner and the backtest.
 *  Swing/leg times are rounded to the nearest hour so a small extension of the same swing does not
 *  reset the setup and discard accumulated confirmations. */
export function buildSetupKey(version: string, scored: ScoreResult): string {
  if (scored.strategy === "fibonacci" && scored.trigger?.fib) {
    const f = scored.trigger.fib;
    return `${version}:${scored.strategy}:${bucketTime(f.swingLow.time)}-${bucketTime(f.swingHigh.time)}`;
  }
  if (scored.strategy === "zones" && scored.trigger?.zone) {
    return `${version}:${scored.strategy}:${scored.trigger.zone.id}`;
  }
  if (scored.strategy === "setforget" && scored.trigger?.setForget) {
    const s = scored.trigger.setForget;
    return `${version}:${scored.strategy}:${bucketTime(s.legLow.time)}-${bucketTime(s.legHigh.time)}`;
  }
  return `${version}:${scored.strategy}:${scored.direction}`;
}
