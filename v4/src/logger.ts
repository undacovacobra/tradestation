/** Tiny timestamped logger so trade activity is easy to follow and audit. */
function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`[${ts()}] INFO  ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`[${ts()}] WARN  ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`[${ts()}] ERROR ${msg}`, ...rest),
  trade: (msg: string, ...rest: unknown[]) => console.log(`[${ts()}] TRADE ${msg}`, ...rest),
};
