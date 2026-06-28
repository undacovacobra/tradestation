import type { Executor } from "./index.js";
import type { AccountSpec, OrderRequest } from "../types.js";
import { log } from "../logger.js";

/**
 * Safe executor that never touches a broker. It just logs what it WOULD do.
 * Use this to verify the rotation + webhook wiring end-to-end before going live.
 */
export class DryRunExecutor implements Executor {
  async init(): Promise<void> {
    log.info("DryRunExecutor ready — no orders will reach any broker.");
  }

  async placeOrder(account: AccountSpec, order: OrderRequest): Promise<void> {
    log.trade(
      `[DRY-RUN] Would ${order.action.toUpperCase()} ${order.quantity}x ${order.symbol} ` +
        `(${order.orderType}) on ${account.name} [${account.tradovateLabel}]` +
        (order.stopLoss ? ` SL=${order.stopLoss}` : "") +
        (order.takeProfit ? ` TP=${order.takeProfit}` : ""),
    );
  }

  async closePosition(account: AccountSpec, symbol: string): Promise<void> {
    log.trade(`[DRY-RUN] Would CLOSE ${symbol} on ${account.name} [${account.tradovateLabel}]`);
  }

  async shutdown(): Promise<void> {}
}
