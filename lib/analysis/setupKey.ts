import type { ScoreResult } from "./scoring";

/** Identity of a setup — one signal per swing/zone/line, shared by the live scanner and the backtest. */
export function buildSetupKey(version: string, scored: ScoreResult): string {
  if (scored.strategy === "trendline" && scored.trigger?.line) {
    const a = scored.trigger.line.anchors;
    return `${version}:${scored.strategy}:${scored.direction}:${a[0]?.time}-${a[a.length - 1]?.time}`;
  }
  if (scored.strategy === "structure" && scored.trigger?.event) {
    const e = scored.trigger.event;
    return `${version}:${scored.strategy}:${e.type}:${e.zone?.id ?? e.level.toFixed(5)}`;
  }
  if (scored.strategy === "fibonacci" && scored.trigger?.fib) {
    return `${version}:${scored.strategy}:${scored.trigger.fib.swingLow.time}-${scored.trigger.fib.swingHigh.time}`;
  }
  if (scored.strategy === "zones" && scored.trigger?.zone) {
    return `${version}:${scored.strategy}:${scored.trigger.zone.id}`;
  }
  if (scored.strategy === "setforget" && scored.trigger?.setForget) {
    const s = scored.trigger.setForget;
    return `${version}:${scored.strategy}:${s.legLow.time}-${s.legHigh.time}`;
  }
  return `${version}:${scored.strategy}:${scored.direction}`;
}
