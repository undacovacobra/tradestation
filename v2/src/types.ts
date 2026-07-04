import { z } from "zod";

/** The two independent rotation lanes. */
export const GROUPS = ["evals", "funded"] as const;
export type Group = (typeof GROUPS)[number];

export function isGroup(v: string): v is Group {
  return (GROUPS as readonly string[]).includes(v);
}

/**
 * Shape of the JSON your TradingView alert sends to the webhook.
 * The GROUP is chosen by the URL, not the payload:
 *   https://<your-address>/webhook/evals   -> rotates eval (LFE…) accounts
 *   https://<your-address>/webhook/funded  -> rotates funded (LFF…) accounts
 *
 * ONE alert handles both opening AND closing. TradingView reports "buy"/"sell"
 * for every order (even the one that closes a trade), so we also read
 * `marketPosition` ({{strategy.market_position}}): when it becomes "flat" the
 * order is a CLOSE; otherwise it's an entry.
 *
 *   Single alert message:
 *   {
 *     "secret": "your-webhook-secret",
 *     "action": "{{strategy.order.action}}",       // "buy" or "sell"
 *     "symbol": "{{ticker}}",
 *     "marketPosition": "{{strategy.market_position}}"  // "long" / "short" / "flat"
 *   }
 *
 * The old two-alert style still works too: send `"action": "close"` to close.
 *
 * NOTE: the bot does NOT set symbol or quantity — you set those on the Tradovate
 * screen. It only switches account and clicks Buy / Sell / Exit.
 */
export const AlertSchema = z.object({
  secret: z.string().min(1),
  action: z.enum(["buy", "sell", "close"]),
  symbol: z.string().min(1),
  quantity: z.number().int().positive().optional(),
  orderType: z.enum(["market", "limit"]).default("market"),
  price: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  tradeId: z.string().optional(),
  /** Position AFTER this order ({{strategy.market_position}}). "flat" = close. */
  marketPosition: z.string().optional(),
});

export type Alert = z.infer<typeof AlertSchema>;

/** True when this alert represents closing the open trade (not a new entry). */
export function isCloseAlert(alert: Alert): boolean {
  return alert.action === "close" || (alert.marketPosition ?? "").trim().toLowerCase() === "flat";
}

/** An account as stored in settings.json (managed from the dashboard). */
export interface StoredAccount {
  /** The exact account id shown in Tradovate's account menu, e.g. LFE05079261220005. */
  tradovateLabel: string;
  /** Friendly nickname shown on the dashboard. Defaults to the label. */
  name: string;
  group: Group;
  enabled: boolean;
}

/** A normalized order the executor knows how to act on. */
export interface OrderRequest {
  action: "buy" | "sell";
  symbol: string;
  tradeId?: string;
}
