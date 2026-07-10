/**
 * The futures "trading day" rolls over in the evening (6pm ET by default), not
 * at midnight — so a win at 7pm belongs to the NEXT trading day. `tradingDayKey`
 * returns a YYYY-MM-DD label for the trading day an instant falls in, by
 * shifting the wall-clock time forward by (24 - resetHour) hours so the reset
 * hour lands on midnight, then taking the date.
 */
export function tradingDayKey(at: Date, timeZone: string, resetHour: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") p[part.type] = part.value;
  const cal = new Date(
    Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)),
  );
  cal.setUTCHours(cal.getUTCHours() + ((24 - (resetHour % 24)) % 24));
  return cal.toISOString().slice(0, 10);
}
