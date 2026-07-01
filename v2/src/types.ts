import { z } from "zod";

/** The two independent rotation lanes. */
export const GROUPS = ["evals", "funded"] as const;
export type Group = (typeof GROUPS)[number];

export function isGroup(v: string): v is Group {
  return (GROUPS as readonly string[]).includes(v);
}

/**
 * Shape of the JSON your TradingView alert sends to the webhook.
 * Same shape as V1 — the GROUP is chosen by the URL, not the payload:
 *   https://<your-address>/webhook/evals   -> rotates eval (LFE…) accounts
 *   https://<your-address>/webhook/funded  -> rotates funded (LFF…) accounts
 *
 *   Entry:
 *   {
 *     "secret": "your-webhook-secret",
 *     "action": "{{strategy.order.action}}",   // "buy" or "sell"
 *     "symbol": "MNQ1!",
 *     "quantity": 1,
 *     "tradeId": "{{strategy.order.id}}"
 *   }
 *
 *   Exit (separate alert on your strategy's close):
 *   {
 *     "secret": "your-webhook-secret",
 *     "action": "close",
 *     "symbol": "MNQ1!"
 *   }
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
});

export type Alert = z.infer<typeof AlertSchema>;

/** An account as stored in settings.json (managed from the dashboard, never by hand). */
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
  quantity: number;
  orderType: "market" | "limit";
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  tradeId?: string;
}
