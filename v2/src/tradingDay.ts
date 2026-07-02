/**
 * The futures "trading day" doesn't run midnight-to-midnight — the session
 * rolls over in the evening (e.g. 6:00pm ET, when the new session opens). So a
 * trade at 7pm belongs to the NEXT trading day, not the same calendar date.
 *
 * `tradingDayKey` returns a YYYY-MM-DD label for the trading day that a given
 * instant falls in, given a time zone and the hour the day resets. It works by
 * shifting the wall-clock time forward by (24 - resetHour) hours so that the
 * reset hour lands on midnight, then taking the date.
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

  // Use a UTC date purely as a calendar calculator on the wall-clock values.
  const cal = new Date(
    Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)),
  );
  const shiftHours = (24 - (resetHour % 24)) % 24;
  cal.setUTCHours(cal.getUTCHours() + shiftHours);
  return cal.toISOString().slice(0, 10);
}
