import type { AccountBalance } from "./types.js";

const LABEL_RE = /LF[EF]\d{6,}/g;

/**
 * Pull a dollar balance out of one row of text from the Tradovate account
 * menu, e.g. "Eval 1 LFE05079261220005 $50,123.45". Account ids are long digit
 * runs, so they are stripped FIRST and we only accept tokens that clearly look
 * like money (a $ sign, thousands commas, or cents) — a bare "50000" is
 * ambiguous and ignored.
 */
export function extractBalance(rowText: string, _label?: string): number | null {
  const withoutIds = rowText.replace(LABEL_RE, " ");
  const match =
    withoutIds.match(/-?\$\s*-?[\d,]+(?:\.\d+)?/) ?? // $50,123.45 / -$120.00
    withoutIds.match(/-?\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/) ?? // 50,123 or 50,123.45
    withoutIds.match(/-?\b\d+\.\d{2}\b/); // 50123.45
  if (!match) return null;
  const value = Number(match[0].replace(/[$,\s]/g, ""));
  if (!Number.isFinite(value)) return null;
  // Sanity window: a prop-account balance, not a price or a timestamp.
  if (value < -1_000_000 || value > 100_000_000) return null;
  return value;
}

/**
 * Turn the raw row texts read from the account menu into one balance per
 * account label. If a label appears in several rows (top bar + menu), the
 * first row that yields a parsable balance wins.
 */
export function extractAccountBalances(rowTexts: string[]): AccountBalance[] {
  const map = new Map<string, number | null>();
  for (const raw of rowTexts) {
    for (const label of raw.match(LABEL_RE) ?? []) {
      const balance = extractBalance(raw, label);
      if (!map.has(label) || (map.get(label) === null && balance !== null)) {
        map.set(label, balance);
      }
    }
  }
  return [...map.entries()].map(([label, balance]) => ({ label, balance })).sort((a, b) => a.label.localeCompare(b.label));
}
