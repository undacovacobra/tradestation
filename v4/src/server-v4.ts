import { timingSafeEqual } from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { TradeCoordinator } from "./coordinator.js";
import { Registry } from "./registry.js";
import { V4AlertSchema } from "./models.js";
import { createWorkers } from "./workers.js";
import { tradingDayKey } from "./tradingDay.js";
import { log } from "./logger.js";
import { notifyActionNeeded } from "./notify.js";

const registry = new Registry(config.registryPath);
const workers = createWorkers(registry.connections());
const today = () => tradingDayKey(new Date(), config.tradingDayTz, config.tradingDayResetHour);
const coordinator = new TradeCoordinator(registry, workers, config.poolStateDir, today);
const app = express();
app.use(express.json({ limit: "128kb" }));
app.use(express.static(config.publicDir));

function validSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const expected = Buffer.from(config.webhookSecret);
  const actual = Buffer.from(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseAuthorizedAlert(req: express.Request) {
  const parsed = V4AlertSchema.parse(req.body);
  const supplied = req.header("x-webhook-secret") ?? parsed.secret;
  if (!validSecret(supplied)) throw new Error("Invalid webhook secret");
  return parsed;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: 4,
    running: registry.running,
    mode: registry.mode,
    connections: [...workers.values()].map((worker) => worker.status()),
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    version: 4,
    running: registry.running,
    mode: registry.mode,
    connections: [...workers.values()].map((worker) => ({ ...worker.definition, status: worker.status() })),
    pools: coordinator.status(),
  });
});

app.post("/api/connections/:id/connect", async (req, res) => {
  if (!validSecret(req.header("x-webhook-secret") ?? req.body?.secret)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ ok: false, error: "Unknown connection" });
  try { await worker.connect(); return res.json({ ok: true, status: worker.status() }); }
  catch (error) { return res.status(503).json({ ok: false, error: (error as Error).message }); }
});

app.get("/api/connections/:id/accounts", async (req, res) => {
  if (!validSecret(req.header("x-webhook-secret") ?? req.query.secret)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ ok: false, error: "Unknown connection" });
  try {
    const accounts = await worker.run((adapter) => adapter.discoverAccounts());
    const known = registry.snapshot().accounts.filter((a) => a.connectionId === req.params.id).map((a) => a.platformLabel);
    return res.json({ ok: true, accounts, unknown: accounts.filter((label) => !known.includes(label)), missing: known.filter((label) => !accounts.includes(label)) });
  } catch (error) { return res.status(503).json({ ok: false, error: (error as Error).message }); }
});

app.post("/api/accounts/onboard", (req, res) => {
  if (!validSecret(req.header("x-webhook-secret") ?? req.body?.secret)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  try {
    const account = registry.onboardAccount({
      id: String(req.body?.id ?? "").trim(),
      name: String(req.body?.name ?? "").trim(),
      firm: String(req.body?.firm ?? "").trim(),
      stage: req.body?.stage,
      connectionId: String(req.body?.connectionId ?? "").trim(),
      platformLabel: String(req.body?.platformLabel ?? "").trim(),
      poolIds: Array.isArray(req.body?.poolIds) ? req.body.poolIds.filter((x: unknown): x is string => typeof x === "string") : [],
    });
    return res.status(201).json({ ok: true, account, pools: registry.pools().filter((pool) => pool.accountIds.includes(account.id)).map((pool) => pool.id) });
  } catch (error) {
    return res.status(400).json({ ok: false, error: (error as Error).message });
  }
});

app.post("/webhook/:poolId", async (req, res) => {
  try {
    const alert = parseAuthorizedAlert(req);
    const result = await coordinator.handle(req.params.poolId, alert);
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    const message = (error as Error).message;
    log.warn(`Webhook rejected for ${req.params.poolId}: ${message}`);
    return res.status(message === "Invalid webhook secret" ? 401 : 409).json({ ok: false, poolId: req.params.poolId, error: message });
  }
});

/** Fan one signal out to several independent pools. Workers run in parallel across logins. */
app.post("/webhook", async (req, res) => {
  try {
    const alert = parseAuthorizedAlert(req);
    const pools = Array.isArray(req.body?.pools) ? req.body.pools.filter((x: unknown): x is string => typeof x === "string") : [];
    if (!pools.length) throw new Error("Provide a non-empty pools array");
    const results = await coordinator.handleMany(pools, alert);
    return res.status(results.every((r) => r.ok) ? 200 : 207).json({ ok: results.every((r) => r.ok), results });
  } catch (error) {
    return res.status((error as Error).message === "Invalid webhook secret" ? 401 : 400).json({ ok: false, error: (error as Error).message });
  }
});

async function autoConnect(): Promise<void> {
  await Promise.allSettled([...workers.values()].filter((w) => w.definition.autoConnect).map(async (worker) => {
    try { await worker.connect(); log.info(`Connected ${worker.definition.name}`); }
    catch (error) {
      const message = `${worker.definition.name} needs attention: ${(error as Error).message}`;
      log.warn(message);
      notifyActionNeeded(message);
    }
  }));
}

const healthTimer = setInterval(() => {
  for (const worker of workers.values()) {
    const status = worker.status();
    if (worker.definition.autoConnect && (!status.connected || !status.loggedIn) && !status.busy) {
      void worker.recover().catch((error) => log.warn(`Health recovery failed for ${worker.definition.name}: ${(error as Error).message}`));
    }
  }
}, config.healthCheckSeconds * 1_000);
healthTimer.unref();

const server = app.listen(config.port, config.host, () => {
  log.info(`V4 listening at http://${config.host}:${config.port}`);
  log.info(`Pools: ${registry.pools().map((pool) => pool.id).join(", ") || "none configured"}`);
  void autoConnect();
});

async function shutdown() {
  clearInterval(healthTimer);
  await Promise.allSettled([...workers.values()].map((worker) => worker.disconnect()));
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
