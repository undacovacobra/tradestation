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
  oncePerDay: (process.env.ONCE_PER_DAY ?? "true") === "true",
  // Remote access (ngrok) — managed from the dashboard's "Remote access" button.
  ngrokAuthtoken: process.env.NGROK_AUTHTOKEN ?? "",
  ngrokDomain: process.env.NGROK_DOMAIN ?? "",
  ngrokAutostart: (process.env.NGROK_AUTOSTART ?? "true") === "true",
  // How often (seconds) the bot re-reads the Tradovate account menu to update
  // balances, spot new accounts, and enforce the eval profit target.
  monitorSeconds: Math.max(30, Number(process.env.MONITOR_SECONDS ?? 60)),
  dataDir: resolve(ROOT, "data"),
  settingsPath: resolve(ROOT, "data", "settings.json"),
  balancesPath: resolve(ROOT, "data", "balances.json"),
  screenshotDir: resolve(ROOT, "screenshots"),
  publicDir: resolve(ROOT, "public"),
};

export type Config = typeof config;
