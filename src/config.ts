import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { AccountSpec } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");

const AccountsFileSchema = z.object({
  accounts: z
    .array(
      z.object({
        name: z.string().min(1),
        tradovateLabel: z.string().min(1),
        enabled: z.boolean().default(true),
      }),
    )
    .min(1),
});

function loadAccounts(): AccountSpec[] {
  const path = resolve(ROOT, "data", "accounts.json");
  if (!existsSync(path)) {
    throw new Error(
      `Missing data/accounts.json. Copy data/accounts.example.json to data/accounts.json and fill in your account labels.`,
    );
  }
  const parsed = AccountsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return parsed.accounts.filter((a) => a.enabled);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

export const config = {
  webhookSecret: required("WEBHOOK_SECRET"),
  port: Number(process.env.PORT ?? 3000),
  executor: (process.env.EXECUTOR ?? "dryrun") as "dryrun" | "tradovate",
  headed: (process.env.HEADED ?? "true") === "true",
  sessionDir: resolve(ROOT, process.env.SESSION_DIR ?? ".tradovate-session"),
  tradovateUrl: process.env.TRADOVATE_URL ?? "https://trader.tradovate.com",
  oncePerDay: (process.env.ONCE_PER_DAY ?? "true") === "true",
  statePath: resolve(ROOT, "data", "state.json"),
  accounts: loadAccounts(),
};

export type Config = typeof config;
