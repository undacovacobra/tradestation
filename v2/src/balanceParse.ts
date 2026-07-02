/**
 * Pull the account balance out of Tradovate's top-bar equity readout.
 *
 * The top bar reads like "ACCOUNT LFE05079261220007 EQUITY 50,320.00 USD
 * OPEN P/L 0.00 USD". We want the number right after "EQUITY" — NOT the account
 * id (a long digit run) and NOT the OPEN P/L figure.
 */
export function extractEquity(text: string): number | null {
  if (!text) return null;
  // Preferred: the amount immediately following the word EQUITY.
  const after = /EQUITY[^0-9$-]*(-?\$?\s*-?[\d,]+(?:\.\d+)?)/i.exec(text);
  const token = after?.[1] ?? firstMoneyToken(text);
  if (!token) return null;
  const value = Number(token.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(value)) return null;
  // Sanity window for a prop-account balance (not a price or a timestamp).
  if (value < -1_000_000 || value > 100_000_000) return null;
  return value;
}

/** First clearly-money-looking token in a string (has $, commas, or cents). */
function firstMoneyToken(text: string): string | null {
  const withoutIds = text.replace(/LF[EF]\d{6,}/g, " ");
  const m =
    withoutIds.match(/-?\$\s*-?[\d,]+(?:\.\d+)?/) ??
    withoutIds.match(/-?\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/) ??
    withoutIds.match(/-?\b\d+\.\d{2}\b/);
  return m?.[0] ?? null;
}
