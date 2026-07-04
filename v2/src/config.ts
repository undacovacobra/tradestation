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
  sessionDir: resolve(ROOT, process.env.SESSION_DIR ?? ".tradovate-session"),
  tradovateUrl: process.env.TRADOVATE_URL ?? "https://trader.tradovate.com",
  // Order-path speed knobs. If Tradovate is set to pop an order-confirm dialog,
  // raise ORDER_CONFIRM_WAIT_MS so the bot has time to see and click it.
  orderConfirmWaitMs: Number(process.env.ORDER_CONFIRM_WAIT_MS ?? 250),
  switchSettleMs: Number(process.env.SWITCH_SETTLE_MS ?? 250),
  // Save a screenshot on every order (slower). Failures always screenshot.
  captureShots: (process.env.SCREENSHOTS ?? "false") === "true",
  // Remote access (ngrok) — dashboard "Remote access" button.
  ngrokAuthtoken: process.env.NGROK_AUTHTOKEN ?? "",
  ngrokDomain: process.env.NGROK_DOMAIN ?? "",
  ngrokAutostart: (process.env.NGROK_AUTOSTART ?? "true") === "true",
  dataDir: resolve(ROOT, "data"),
  settingsPath: resolve(ROOT, "data", "settings.json"),
  screenshotDir: resolve(ROOT, "screenshots"),
  publicDir: resolve(ROOT, "public"),
};

export type Config = typeof config;
