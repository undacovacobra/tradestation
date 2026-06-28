import express from "express";
import { config } from "./config.js";
import { AlertSchema, type OrderRequest } from "./types.js";
import { AccountRotation } from "./rotation.js";
import { createExecutor } from "./executor/index.js";
import { log } from "./logger.js";

const rotation = new AccountRotation(config.accounts, config.statePath, config.oncePerDay);
const executor = createExecutor(config);

/**
 * Serialize all alert handling. TradingView can fire entry+exit close together,
 * and browser automation must never run two order flows at once.
 */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function handleEntry(order: OrderRequest): Promise<string> {
  const choice = rotation.selectAccountForEntry();
  if ("error" in choice) {
    log.warn(`Entry rejected: ${choice.error}`);
    return choice.error;
  }
  await executor.placeOrder(choice.account, order);
  rotation.recordOpen(choice.index, order);
  return `Opened ${order.action} ${order.symbol} on ${choice.account.name}`;
}

async function handleClose(symbol: string): Promise<string> {
  if (rotation.isFlat) {
    log.warn("Close received but no trade is open — ignoring.");
    return "No open trade to close.";
  }
  const open = rotation.getState().openTrade!;
  const account = config.accounts[open.accountIndex]!;
  await executor.closePosition(account, symbol);
  const { closed, next } = rotation.recordClose();
  return `Closed ${closed.symbol} on ${closed.accountName}. Next account: ${next.name}`;
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/status", (_req, res) => {
  const s = rotation.getState();
  res.json({
    executor: config.executor,
    oncePerDay: config.oncePerDay,
    nextAccount: config.accounts[s.currentIndex]?.name,
    openTrade: s.openTrade,
    accounts: config.accounts.map((a) => a.name),
    tradesToday: Object.entries(s.lastTradedDay).length,
  });
});

app.post("/webhook", async (req, res) => {
  const parsed = AlertSchema.safeParse(req.body);
  if (!parsed.success) {
    log.warn("Rejected malformed alert:", parsed.error.flatten().fieldErrors);
    return res.status(400).json({ ok: false, error: "Invalid alert payload" });
  }
  const alert = parsed.data;
  if (alert.secret !== config.webhookSecret) {
    log.warn("Rejected alert with bad secret.");
    return res.status(401).json({ ok: false, error: "Bad secret" });
  }

  try {
    const message = await enqueue(() => {
      if (alert.action === "close") {
        return handleClose(alert.symbol);
      }
      const order: OrderRequest = {
        action: alert.action,
        symbol: alert.symbol,
        quantity: alert.quantity ?? 1,
        orderType: alert.orderType,
        price: alert.price,
        stopLoss: alert.stopLoss,
        takeProfit: alert.takeProfit,
        tradeId: alert.tradeId,
      };
      return handleEntry(order);
    });
    return res.json({ ok: true, message });
  } catch (err) {
    log.error("Alert handling failed:", err);
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

async function main() {
  await executor.init();
  app.listen(config.port, () => {
    log.info(`Webhook server listening on http://localhost:${config.port}/webhook`);
    log.info(`Executor=${config.executor} | accounts=${config.accounts.length} | oncePerDay=${config.oncePerDay}`);
    const s = rotation.getState();
    log.info(`Next account up: ${config.accounts[s.currentIndex]?.name}`);
  });
}

const shutdown = async () => {
  log.info("Shutting down…");
  await executor.shutdown();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  log.error("Fatal startup error:", err);
  process.exit(1);
});
