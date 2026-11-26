import Link from "next/link";

const MARKETS = [
  { id: "gold", label: "XAU/USD", href: "/" },
  { id: "btc", label: "BTC/USD", href: "/btc" },
] as const;

/** The two systems, one button each: the one shown is pressed, the other goes to its page. */
export default function MarketSwitch({ active }: { active: (typeof MARKETS)[number]["id"] }) {
  return (
    <div className="flex overflow-hidden rounded border border-neutral-700" role="group" aria-label="Market">
      {MARKETS.map((m) =>
        m.id === active ? (
          <span key={m.id} aria-current="page" className="bg-neutral-700 px-2.5 py-1.5 text-sm font-medium text-white">
            {m.label}
          </span>
        ) : (
          <Link key={m.id} href={m.href} className="bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-400 transition-colors hover:text-neutral-100">
            {m.label}
          </Link>
        )
      )}
    </div>
  );
}
