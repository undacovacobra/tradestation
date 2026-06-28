import { z } from "zod";

/**
 * Shape of the JSON your TradingView alert sends to the webhook.
 *
 * Example alert message in TradingView (Premium, "Webhook URL" enabled):
 *
 *   Entry:
 *   {
 *     "secret": "your-webhook-secret",
 *     "action": "{{strategy.order.action}}",   // "buy" or "sell"
 *     "symbol": "MNQ1!",
 *     "quantity": 1,
 *     "orderType": "market",
 *     "stopLoss": 50,        // optional, in ticks/points per your strategy
 *     "takeProfit": 100,     // optional
 *     "tradeId": "{{strategy.order.id}}"
 *   }
 *
 *   Exit (separate alert on your strategy's close):
 *   {
 *     "secret": "your-webhook-secret",
 *     "action": "close",
 *     "symbol": "MNQ1!",
 *     "tradeId": "{{strategy.order.id}}"
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

export interface AccountSpec {
  /** Human-friendly name for logs. */
  name: string;
  /** The exact account label as shown in the Tradovate account selector dropdown. */
  tradovateLabel: string;
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
