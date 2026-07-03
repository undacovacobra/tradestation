import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

export const config = {
  webhookSecret: required("WEBHOOK_SECRET"),
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? "",
  port: Number(process.env.PORT ?? 3300),
  headed: (process.env.HEADED ?? "true") === "true",
  // Speed knobs for the order path. Defaults favour fast fills; raise if your
  // machine/connection is slow or Tradovate shows an order-confirm popup.
  orderConfirmWaitMs: Number(process.env.ORDER_CONFIRM_WAIT_MS ?? 350),
  switchSettleMs: Number(process.env.SWITCH_SETTLE_MS ?? 300),
  // Save success screenshots (slower). Failures always screenshot regardless.
  captureShots: (process.env.SCREENSHOTS ?? "false") === "true",
  sessionDir: resolve(ROOT, process.env.SESSION_DIR ?? ".tradovate-session"),
  tradovateUrl: process.env.TRADOVATE_URL ?? "https://trader.tradovate.com",
  oncePerDay: (process.env.ONCE_PER_DAY ?? "true") === "true",
  // Futures "trading day" rolls over in the evening, not at midnight. Default:
  // 6pm US/Eastern (the CME session reopen). Change TRADING_DAY_TZ to
  // "America/Chicago" for Central, or TRADING_DAY_RESET_HOUR for a different hour.
  tradingDayTz: process.env.TRADING_DAY_TZ ?? "America/New_York",
  tradingDayResetHour: Math.min(23, Math.max(0, Number(process.env.TRADING_DAY_RESET_HOUR ?? 18))),
  // Remote access (ngrok) — managed from the dashboard's "Remote access" button.
  ngrokAuthtoken: process.env.NGROK_AUTHTOKEN ?? "",
  ngrokDomain: process.env.NGROK_DOMAIN ?? "",
  ngrokAutostart: (process.env.NGROK_AUTOSTART ?? "true") === "true",
  // How often (seconds) the bot re-reads the Tradovate account menu to update
  // balances, spot new accounts, and enforce the eval profit target — when NO
  // trade is open (the relaxed cadence).
  monitorSeconds: Math.max(30, Number(process.env.MONITOR_SECONDS ?? 60)),
  // Faster cadence used while a trade is OPEN, so the profit-target stop reacts
  // quickly on the one account that's live (a cheap top-bar read, ~50ms).
  monitorActiveSeconds: Math.max(1, Number(process.env.MONITOR_ACTIVE_SECONDS ?? 3)),
  dataDir: resolve(ROOT, "data"),
  settingsPath: resolve(ROOT, "data", "settings.json"),
  balancesPath: resolve(ROOT, "data", "balances.json"),
  screenshotDir: resolve(ROOT, "screenshots"),
  publicDir: resolve(ROOT, "public"),
};

export type Config = typeof config;
