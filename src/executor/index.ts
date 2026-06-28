import type { AccountSpec, OrderRequest } from "../types.js";
import type { Config } from "../config.js";
import { DryRunExecutor } from "./dryRun.js";
import { TradovateExecutor } from "./tradovate.js";

/**
 * The contract every execution backend implements. The rest of the bot only
 * talks to this interface, so swapping dry-run <-> live Tradovate is one config flag.
 */
export interface Executor {
  /** Called once at startup (e.g. launch browser, restore session). */
  init(): Promise<void>;
  /** Open a position on the given account. */
  placeOrder(account: AccountSpec, order: OrderRequest): Promise<void>;
  /** Flatten/close the open position on the given account. */
  closePosition(account: AccountSpec, symbol: string): Promise<void>;
  /** Clean shutdown. */
  shutdown(): Promise<void>;
}

export function createExecutor(config: Config): Executor {
  switch (config.executor) {
    case "tradovate":
      return new TradovateExecutor(config);
    case "dryrun":
    default:
      return new DryRunExecutor();
  }
}
