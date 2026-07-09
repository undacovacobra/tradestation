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
  // V3 lives on 3400 so it can run alongside V2 (3300) while being tested.
  port: Number(process.env.PORT ?? 3400),
  headed: (process.env.HEADED ?? "true") === "true",
  // Self-healing: open + log into the Tradovate browser automatically on boot
  // (no human "Connect browser" click after a restart). Off with AUTO_CONNECT=false.
  autoConnect: (process.env.AUTO_CONNECT ?? "true") === "true",
  // Phone notifications via Telegram. Leave blank to disable.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  sessionDir: resolve(ROOT, process.env.SESSION_DIR ?? ".tradovate-session"),
  tradovateUrl: process.env.TRADOVATE_URL ?? "https://trader.tradovate.com",
  // Order-path speed knobs. If Tradovate is set to pop an order-confirm dialog,
  // raise ORDER_CONFIRM_WAIT_MS so the bot has time to see and click it.
  orderConfirmWaitMs: Number(process.env.ORDER_CONFIRM_WAIT_MS ?? 250),
  switchSettleMs: Number(process.env.SWITCH_SETTLE_MS ?? 250),
  // Save a screenshot on every order (slower). Failures always screenshot.
  captureShots: (process.env.SCREENSHOTS ?? "false") === "true",
  // Daily WIN bench: an account that closes a winner sits out the rest of the
  // (futures) trading day. Losers/breakeven keep cycling. Turn off with false.
  benchWinnersForDay: (process.env.ONCE_PER_DAY ?? "true") !== "false",
  // Futures "trading day" boundary — the 6pm ET session reset, not midnight.
  tradingDayTz: process.env.TRADING_DAY_TZ ?? "America/New_York",
  tradingDayResetHour: Number(process.env.TRADING_DAY_RESET_HOUR ?? 18),
  // While a trade is open, how often (seconds) to re-read that ONE account's
  // balance to catch the profit target. Only touches the already-selected
  // account — never switches. Min 1s. Idle = no browser work at all.
  monitorActiveSeconds: Math.max(1, Number(process.env.MONITOR_ACTIVE_SECONDS ?? 3)),
  // Remote access (ngrok) — dashboard "Remote access" button.
  ngrokAuthtoken: process.env.NGROK_AUTHTOKEN ?? "",
  ngrokDomain: process.env.NGROK_DOMAIN ?? "",
  ngrokAutostart: (process.env.NGROK_AUTOSTART ?? "true") === "true",
  dataDir: resolve(ROOT, "data"),
  settingsPath: resolve(ROOT, "data", "settings.json"),
  balancesPath: resolve(ROOT, "data", "balances.json"),
  screenshotDir: resolve(ROOT, "screenshots"),
  publicDir: resolve(ROOT, "public"),
};

export type Config = typeof config;
