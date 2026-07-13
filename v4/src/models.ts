import { z } from "zod";

export const StageSchema = z.enum(["eval", "funded"]);
export type Stage = z.infer<typeof StageSchema>;

export const ConnectionSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  name: z.string().min(1),
  firm: z.string().min(1),
  adapter: z.enum(["tradovate", "simulated"]).default("tradovate"),
  url: z.string().url().default("https://trader.tradovate.com"),
  sessionDir: z.string().min(1),
  accountPattern: z.string().min(1).default("[A-Z0-9][A-Z0-9_-]{5,}"),
  enabled: z.boolean().default(true),
  autoConnect: z.boolean().default(true),
});
export type ConnectionDefinition = z.infer<typeof ConnectionSchema>;

export const AccountSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  name: z.string().min(1),
  firm: z.string().min(1),
  stage: StageSchema,
  connectionId: z.string().min(1),
  platformLabel: z.string().min(1),
  enabled: z.boolean().default(true),
  status: z.enum(["active", "passed", "held"]).default("active"),
  tags: z.array(z.string().min(1)).default([]),
});
export type AccountDefinition = z.infer<typeof AccountSchema>;

export const PoolSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  name: z.string().min(1),
  accountIds: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true),
  benchWinnersForDay: z.boolean().default(true),
  executionLane: z.string().min(1).optional(),
  balanceTarget: z.number().positive().optional(),
});
export type PoolDefinition = z.infer<typeof PoolSchema>;

export const RegistrySchema = z.object({
  version: z.literal(4),
  running: z.boolean().default(true),
  mode: z.enum(["practice", "live"]).default("practice"),
  connections: z.array(ConnectionSchema).default([]),
  accounts: z.array(AccountSchema).default([]),
  pools: z.array(PoolSchema).default([]),
});
export type RegistryData = z.infer<typeof RegistrySchema>;

export const V4AlertSchema = z.object({
  secret: z.string().min(1).optional(),
  signalId: z.string().min(1).optional(),
  action: z.enum(["buy", "sell", "close"]),
  symbol: z.string().min(1),
  quantity: z.coerce.number().int().positive().optional(),
  marketPosition: z.string().optional(),
  tradeId: z.string().optional(),
  /** Test signals plan the action but are never allowed to click a broker UI. */
  test: z.boolean().default(false),
});
export type V4Alert = z.infer<typeof V4AlertSchema>;

export function isCloseAlert(alert: V4Alert): boolean {
  return alert.action === "close" || (alert.marketPosition ?? "").trim().toLowerCase() === "flat";
}

export interface OpenPoolTrade {
  accountId: string;
  accountName: string;
  connectionId: string;
  platformLabel: string;
  symbol: string;
  action: "buy" | "sell";
  quantity?: number;
  signalId?: string;
  openedAt: string;
  simulated: boolean;
  entryBalance?: number;
}

export interface PoolState {
  nextAccountId: string | null;
  openTrade: OpenPoolTrade | null;
  lastWonDay: Record<string, string>;
  skippedDay: Record<string, string>;
  history: Array<OpenPoolTrade & { closedAt: string; won?: boolean }>;
}

export interface WorkerStatus {
  connectionId: string;
  connected: boolean;
  loggedIn: boolean;
  busy: boolean;
  selectedAccount: string | null;
  lastError?: string;
}

export interface TradeResult {
  ok: boolean;
  poolId: string;
  message: string;
  accountId?: string;
  connectionId?: string;
  simulated: boolean;
}
