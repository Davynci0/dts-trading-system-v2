import { fetchLatestPrice } from "./oanda";

/** OANDA instrument → its quote currency (the last part of the name). */
export function quoteCurrency(instrument: string): string {
  const parts = instrument.split("_");
  return parts[parts.length - 1] ?? instrument;
}

/** The OANDA instrument that prices one unit of the quote currency in USD,
 *  or null when the quote currency IS USD (conversion rate 1). */
export function quoteUsdInstrument(instrument: string): string | null {
  const q = quoteCurrency(instrument);
  if (q === "USD") return null;
  if (q === "JPY") return "USD_JPY"; // 1 JPY = 1/USD_JPY dollars
  return `${q}_USD`;
}

/** USD value of one unit of the quote currency, needed to size USD-account
 *  risks on non-USD-quoted pairs (JPY pairs, GBP_AUD, GBP_NZD, ...).
 *  Fetches the small set of conversion instruments once per scan.
 *  Returns {} if every pair is USD-quoted. */
export async function fetchQuoteUsdRates(instruments: string[]): Promise<Record<string, number>> {
  const needed = [
    ...new Set(instruments.map(quoteUsdInstrument).filter((x): x is string => x != null)),
  ];
  const rates: Record<string, number> = {};
  await Promise.all(
    needed.map(async (conv) => {
      try {
        const px = await fetchLatestPrice(conv);
        if (px && px.close > 0) rates[conv] = px.close;
      } catch {
        // conversion unavailable — sizing for those pairs degrades gracefully
      }
    })
  );
  return rates;
}

/** USD value of 1 unit of the instrument's quote currency given the fetched
 *  conversion prices. 0 when the rate is unknown (the risk check then refuses
 *  to size rather than risking the wrong amount). */
export function quoteUsdRateFor(instrument: string, rates: Record<string, number>): number {
  const conv = quoteUsdInstrument(instrument);
  if (conv == null) return 1; // USD-quoted (incl. XAU_USD)
  const px = rates[conv];
  if (!px || px <= 0) return 0;
  return conv === "USD_JPY" ? 1 / px : px;
}

/** Price display digits per instrument (XAU 2, JPY quotes 3, 4-dec majors 5). */
export function displayDigits(instrument: string): number {
  const q = quoteCurrency(instrument);
  if (instrument.startsWith("XAU")) return 2;
  if (q === "JPY") return 3;
  return 5;
}
