import { timingSafeEqual } from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { TradeCoordinator } from "./coordinator.js";
import { Registry } from "./registry.js";
import { V4AlertSchema } from "./models.js";
import { tradingDayKey } from "./tradingDay.js";
import { log } from "./logger.js";
import { notifyActionNeeded, notifyGoodNews } from "./notify.js";
import { BalanceLog } from "./balances.js";
import { ConnectionManager } from "./connectionManager.js";
import { listEvents, pushEvent } from "./events.js";
import { autoStartTunnel, connectTunnel, disconnectTunnel, tunnelStatus } from "./tunnel.js";

const registry = new Registry(config.registryPath);
const workers = new ConnectionManager(registry.connections());
const balances = new BalanceLog(config.balancesPath);
const today = () => tradingDayKey(new Date(), config.tradingDayTz, config.tradingDayResetHour);
const coordinator = new TradeCoordinator(registry, workers, config.poolStateDir, today, balances, true, (message) => {
  pushEvent("error", message);
  notifyActionNeeded(message);
});
const app = express();
app.use(express.json({ limit: "128kb" }));
app.use(express.static(config.publicDir));

function validSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const expected = Buffer.from(config.webhookSecret);
  const actual = Buffer.from(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isDirectLocalRequest(req: express.Request): boolean {
  const address = req.socket.remoteAddress ?? "";
  const loopback = address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
  return loopback && !req.header("x-forwarded-for");
}

function adminAuthorized(req: express.Request): boolean {
  return isDirectLocalRequest(req) || validSecret(req.header("x-webhook-secret") ?? req.body?.secret ?? req.query.secret);
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
    executionStyle: registry.executionStyle,
    remoteAccessEnabled: registry.remoteAccessEnabled,
    connections: workers.values().map((worker) => worker.status()),
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    version: 4,
    running: registry.running,
    mode: registry.mode,
    executionStyle: registry.executionStyle,
    remoteAccessEnabled: registry.remoteAccessEnabled,
    connections: workers.values().map((worker) => ({
      ...worker.definition,
      accounts: registry.snapshot().accounts.filter((account) => account.connectionId === worker.definition.id).map((account) => ({
        id: account.id, name: account.name, platformLabel: account.platformLabel, stage: account.stage, status: account.status,
      })),
      accountCount: registry.snapshot().accounts.filter((account) => account.connectionId === worker.definition.id).length,
      status: worker.status(),
    })),
    accounts: registry.snapshot().accounts,
    pools: coordinator.status(),
    tunnel: tunnelStatus(),
    events: listEvents(80),
  });
});

app.post("/api/mode", (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  try {
    const mode = String(req.body?.mode ?? "");
    if (mode !== "practice" && mode !== "live") throw new Error("Mode must be practice or live");
    if (mode === "live") {
      if (req.body?.confirmLive !== true) throw new Error("Live mode requires explicit confirmation");
      if (!workers.values().some((worker) => worker.status().loggedIn)) throw new Error("Connect and log into at least one execution session before enabling Live mode");
    }
    registry.setMode(mode);
    const message = mode === "live"
      ? "LIVE MODE ENABLED — armed webhook signals can place real orders."
      : "Practice mode enabled — webhook signals will not place orders.";
    pushEvent(mode === "live" ? "warn" : "info", message);
    return res.json({ ok: true, mode, message });
  } catch (error) {
    return res.status(400).json({ ok: false, error: (error as Error).message });
  }
});

app.post("/api/execution-style", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  try {
    const executionStyle = String(req.body?.executionStyle ?? "");
    if (executionStyle !== "standard" && executionStyle !== "fast-entry") throw new Error("Execution style must be standard or fast-entry");
    if (executionStyle === "fast-entry" && req.body?.confirmGap !== true) throw new Error("Fast Entry requires explicit confirmation of the brief unprotected gap");
    registry.setExecutionStyle(executionStyle);
    for (const worker of workers.values()) worker.invalidateArmed();
    await Promise.allSettled(workers.values().filter((worker) => worker.status().loggedIn).map((worker) => coordinator.prearmConnection(worker.definition.id)));
    const message = executionStyle === "fast-entry"
      ? "Fast Entry enabled — market entry happens first, then ATLAS immediately adds a DOM OCO-one-time target and stop."
      : "Standard execution enabled — the account ATM is prepared before entry.";
    pushEvent(executionStyle === "fast-entry" ? "warn" : "info", message);
    return res.json({ ok: true, executionStyle, message });
  } catch (error) {
    return res.status(400).json({ ok: false, error: (error as Error).message });
  }
});

app.post("/api/tunnel/connect", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  const tunnel = await connectTunnel();
  return res.status(tunnel.state === "error" ? 503 : 200).json({ ok: tunnel.state === "on", tunnel, error: tunnel.error });
});

app.post("/api/tunnel/disconnect", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  return res.json({ ok: true, tunnel: await disconnectTunnel() });
});

app.post("/api/connections", (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  try {
    const name = String(req.body?.name ?? "").trim();
    const firm = String(req.body?.firm ?? "").trim();
    if (!name || !firm) throw new Error("Login name and firm name are required.");
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "login";
    let id = base; let suffix = 2;
    while (registry.connection(id)) id = `${base}-${suffix++}`;
    const connection = registry.addConnection({ id, name, firm, adapter: "tradovate", url: String(req.body?.url ?? "https://trader.tradovate.com"), sessionDir: `.sessions/${id}`, accountPattern: String(req.body?.accountPattern ?? "[A-Z0-9][A-Z0-9_-]{5,}"), enabled: true, autoConnect: req.body?.autoConnect === true });
    workers.add(connection);
    pushEvent("info", `Added login ${connection.name} for ${connection.firm}.`);
    return res.status(201).json({ ok: true, connection });
  } catch (error) { return res.status(400).json({ ok: false, error: (error as Error).message }); }
});

app.delete("/api/connections/:id", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  try {
    if (coordinator.hasOpenTradeForConnection(req.params.id)) throw new Error("Connection has an open trade");
    registry.removeConnection(req.params.id);
    await workers.remove(req.params.id);
    return res.json({ ok: true });
  } catch (error) { return res.status(400).json({ ok: false, error: (error as Error).message }); }
});

app.post("/api/balances/refresh", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  const results = await coordinator.refreshBalances();
  pushEvent("info", `Balance refresh finished: ${results.reduce((sum, item) => sum + item.refreshed, 0)} accounts updated.`);
  return res.json({ ok: true, results });
});

app.post("/api/pools/:poolId/accounts/:accountId", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  try {
    const { poolId, accountId } = req.params;
    if (coordinator.hasOpenTradeForAccount(accountId)) throw new Error("This account has an open trade");
    const action = String(req.body?.action ?? "");
    if (action === "up" || action === "down") registry.movePoolAccount(poolId, accountId, action);
    else if (action === "skip-today") await coordinator.skipToday(poolId, accountId);
    else if (action === "resume-today") await coordinator.resumeToday(poolId, accountId);
    else if (action === "hold") registry.setAccountStatus(accountId, "held");
    else if (action === "activate") registry.setAccountStatus(accountId, "active");
    else if (action === "pass") registry.setAccountStatus(accountId, "passed");
    else if (action === "remove") {
      registry.removeAccount(accountId);
      balances.remove(accountId);
    }
    else if (action === "next") await coordinator.setNext(poolId, accountId);
    else throw new Error(`Unsupported action: ${action}`);
    if (!["skip-today", "resume-today", "next"].includes(action)) await coordinator.prearmPool(poolId);
    pushEvent("info", `${action} applied to ${accountId} in ${poolId}.`);
    return res.json({ ok: true });
  } catch (error) { return res.status(400).json({ ok: false, error: (error as Error).message }); }
});

app.post("/api/connections/:id/connect", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ ok: false, error: "Unknown connection" });
  try { await worker.connect(); await coordinator.prearmConnection(worker.definition.id); return res.json({ ok: true, status: worker.status() }); }
  catch (error) {
    const message = `${worker.definition.name} needs attention: ${(error as Error).message}`;
    pushEvent("error", message);
    notifyActionNeeded(message);
    return res.status(503).json({ ok: false, error: (error as Error).message });
  }
});

app.post("/api/connections/:id/test-bracket", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ ok: false, error: "Unknown connection" });
  const targetPerContract = Number(req.body?.targetPerContract);
  const stopPerContract = Number(req.body?.stopPerContract);
  if (!(targetPerContract > 0) || !(stopPerContract > 0)) {
    return res.status(400).json({ ok: false, error: "Enter a positive take profit and stop loss." });
  }
  try {
    worker.invalidateArmed();
    await worker.run((adapter) => adapter.setBracket(targetPerContract, stopPerContract, true));
    pushEvent("info", `Verified +$${targetPerContract} / -$${stopPerContract} ATM bracket on ${worker.definition.name}; no trade placed.`);
    return res.json({ ok: true, targetPerContract, stopPerContract, placedTrade: false });
  } catch (error) {
    const fields = await worker.run((adapter) => adapter.inspectFields()).catch(() => []);
    return res.status(409).json({ ok: false, error: (error as Error).message, fields, placedTrade: false });
  }
});

app.get("/api/connections/:id/atm-controls", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ ok: false, error: "Unknown connection" });
  try {
    const controls = await worker.run((adapter) => adapter.inspectAtmControls());
    return res.json({ ok: true, controls, changedSettings: false, placedTrade: false });
  } catch (error) { return res.status(503).json({ ok: false, error: (error as Error).message }); }
});

app.get("/api/connections/:id/accounts", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ ok: false, error: "Unknown connection" });
  try {
    const accounts = await worker.run((adapter) => adapter.discoverAccounts());
    const known = registry.snapshot().accounts.filter((a) => a.connectionId === req.params.id).map((a) => a.platformLabel);
    return res.json({ ok: true, accounts, unknown: accounts.filter((label) => !known.includes(label)), missing: known.filter((label) => !accounts.includes(label)) });
  } catch (error) { return res.status(503).json({ ok: false, error: (error as Error).message }); }
});

app.post("/api/accounts/onboard", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  try {
    const account = registry.onboardAccount({
      id: String(req.body?.id ?? "").trim(),
      name: String(req.body?.name ?? "").trim(),
      firm: String(req.body?.firm ?? "").trim(),
      stage: req.body?.stage,
      connectionId: String(req.body?.connectionId ?? "").trim(),
      platformLabel: String(req.body?.platformLabel ?? "").trim(),
      poolIds: Array.isArray(req.body?.poolIds) ? req.body.poolIds.filter((x: unknown): x is string => typeof x === "string") : [],
      targetPerContract: Number(req.body?.targetPerContract ?? 0),
      stopPerContract: Number(req.body?.stopPerContract ?? 0),
    });
    await coordinator.prearmPoolsForAccount(account.id);
    return res.status(201).json({ ok: true, account, pools: registry.pools().filter((pool) => pool.accountIds.includes(account.id)).map((pool) => pool.id) });
  } catch (error) {
    return res.status(400).json({ ok: false, error: (error as Error).message });
  }
});

app.patch("/api/accounts/:accountId", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  try {
    const accountId = req.params.accountId;
    if (coordinator.hasOpenTradeForAccount(accountId)) throw new Error("This account has an open trade");
    const account = registry.updateAccount(accountId, {
      name: String(req.body?.name ?? "").trim(),
      firm: String(req.body?.firm ?? "").trim(),
      stage: req.body?.stage,
      poolIds: Array.isArray(req.body?.poolIds) ? req.body.poolIds.filter((x: unknown): x is string => typeof x === "string") : [],
      targetPerContract: req.body?.targetPerContract == null ? undefined : Number(req.body.targetPerContract),
      stopPerContract: req.body?.stopPerContract == null ? undefined : Number(req.body.stopPerContract),
    });
    await coordinator.prearmPoolsForAccount(account.id);
    return res.json({ ok: true, account, pools: registry.pools().filter((pool) => pool.accountIds.includes(account.id)).map((pool) => pool.id) });
  } catch (error) {
    return res.status(400).json({ ok: false, error: (error as Error).message });
  }
});

app.post("/api/accounts/:accountId/bracket", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  try {
    const accountId = req.params.accountId;
    if (coordinator.hasOpenTradeForAccount(accountId)) throw new Error("This account has an open trade");
    const account = registry.updateAccountBracket(
      accountId,
      Number(req.body?.targetPerContract),
      Number(req.body?.stopPerContract),
    );
    pushEvent("info", `Saved +$${account.targetPerContract} / -$${account.stopPerContract} bracket for ${account.name}.`);
    await coordinator.prearmPoolsForAccount(account.id);
    return res.json({ ok: true, account });
  } catch (error) {
    return res.status(400).json({ ok: false, error: (error as Error).message });
  }
});

app.post("/api/pools/:id/lane", (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  try {
    const pool = registry.setPoolExecutionLane(req.params.id, String(req.body?.executionLane ?? ""));
    return res.json({ ok: true, pool });
  } catch (error) {
    return res.status(400).json({ ok: false, error: (error as Error).message });
  }
});

app.post("/api/remote-access", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  const enabled = Boolean(req.body?.enabled);
  registry.setRemoteAccessEnabled(enabled);
  const tunnel = enabled ? await connectTunnel() : await disconnectTunnel();
  return res.status(enabled && tunnel.state !== "on" ? 503 : 200).json({ ok: !enabled || tunnel.state === "on", tunnel, remoteAccessEnabled: enabled, error: tunnel.error });
});

app.post("/api/pools/:poolId/test-webhook", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  try {
    const action = req.body?.action ?? "buy";
    const alert = V4AlertSchema.parse({
      signalId: `dashboard-test-${Date.now()}`,
      action,
      symbol: String(req.body?.symbol ?? "MNQ").trim().toUpperCase(),
      quantity: Number(req.body?.quantity ?? 1),
      marketPosition: action === "close" ? "flat" : action === "sell" ? "short" : "long",
      test: true,
    });
    const result = await coordinator.handle(req.params.poolId, alert);
    pushEvent("info", `Dashboard test webhook for ${req.params.poolId}: ${result.message}`);
    return res.status(result.ok ? 200 : 409).json({ ok: result.ok, result, placedTrade: false });
  } catch (error) {
    const message = `Dashboard test webhook failed for ${req.params.poolId}: ${(error as Error).message}`;
    pushEvent("error", message);
    notifyActionNeeded(message);
    return res.status(400).json({ ok: false, error: (error as Error).message, placedTrade: false });
  }
});

app.post("/api/tests/simultaneous", async (req, res) => {
  if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: "Invalid secret" });
  const startedAt = Date.now();
  try {
    const evalPoolId = String(req.body?.evalPoolId ?? "");
    const fundedPoolId = String(req.body?.fundedPoolId ?? "");
    if (!evalPoolId || !fundedPoolId || evalPoolId === fundedPoolId) throw new Error("Choose one eval pool and one different funded pool");
    const requests = [
      { stage: "eval", poolId: evalPoolId, quantity: Number(req.body?.evalQuantity) },
      { stage: "funded", poolId: fundedPoolId, quantity: Number(req.body?.fundedQuantity) },
    ] as const;
    for (const request of requests) {
      if (!Number.isInteger(request.quantity) || request.quantity <= 0) throw new Error(`${request.stage} quantity must be a positive whole number`);
      const pool = registry.pool(request.poolId);
      if (!pool) throw new Error(`Unknown ${request.stage} pool: ${request.poolId}`);
      const poolStatus = coordinator.status().find((item) => item.id === request.poolId);
      const nextAccount = poolStatus?.accounts.find((account) => account.isNext);
      if (!nextAccount || nextAccount.stage !== request.stage) throw new Error(`${pool.name}'s next account is not ${request.stage}`);
    }
    const settled = await Promise.allSettled(requests.map(async (request) => {
      const result = await coordinator.handle(request.poolId, V4AlertSchema.parse({
        signalId: `simultaneous-${request.stage}-${Date.now()}`,
        action: "buy",
        symbol: "MNQ",
        quantity: request.quantity,
        marketPosition: "long",
        test: true,
      }));
      return { ...request, result };
    }));
    const results = settled.map((item, index) => item.status === "fulfilled"
      ? { ok: true, ...item.value }
      : { ok: false, ...requests[index]!, error: item.reason instanceof Error ? item.reason.message : String(item.reason) });
    const totalMs = Date.now() - startedAt;
    pushEvent("info", `Simultaneous eval/funded test finished in ${totalMs} ms; no trades were placed.`);
    return res.json({ ok: results.every((result) => result.ok), totalMs, results, placedTrade: false });
  } catch (error) {
    return res.status(400).json({ ok: false, error: (error as Error).message, totalMs: Date.now() - startedAt, placedTrade: false });
  }
});

app.post("/webhook/:poolId", async (req, res) => {
  try {
    const alert = parseAuthorizedAlert(req);
    const result = await coordinator.handle(req.params.poolId, alert);
    if (result.timingMs) pushEvent("trade", `${req.params.poolId} entry click completed in ${result.timingMs.total} ms (queue ${result.timingMs.queueWait} ms, browser ${result.timingMs.execution} ms).`);
    if (result.won) notifyGoodNews(`🏅 Confirmed winning trade closed. ${result.message}`);
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    const message = (error as Error).message;
    log.warn(`Webhook rejected for ${req.params.poolId}: ${message}`);
    if (message !== "Invalid webhook secret") {
      const alertMessage = `Webhook failed for ${req.params.poolId}: ${message}`;
      pushEvent("error", alertMessage);
      notifyActionNeeded(alertMessage);
    }
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
    for (const result of results) {
      if (!result.ok) {
        const message = `Webhook failed for ${result.poolId}: ${result.message}`;
        pushEvent("error", message);
        notifyActionNeeded(message);
      } else if (result.won) notifyGoodNews(`🏅 Confirmed winning trade closed. ${result.message}`);
    }
    return res.status(results.every((r) => r.ok) ? 200 : 207).json({ ok: results.every((r) => r.ok), results });
  } catch (error) {
    return res.status((error as Error).message === "Invalid webhook secret" ? 401 : 400).json({ ok: false, error: (error as Error).message });
  }
});

async function autoConnect(): Promise<void> {
  await Promise.allSettled(workers.values().filter((w) => w.definition.autoConnect).map(async (worker) => {
    try { await worker.connect(); await coordinator.prearmConnection(worker.definition.id); log.info(`Connected ${worker.definition.name}`); }
    catch (error) {
      const message = `${worker.definition.name} needs attention: ${(error as Error).message}`;
      log.warn(message);
      notifyActionNeeded(message);
    }
  }));
}

const healthTimer = setInterval(() => {
  const tunnel = tunnelStatus();
  if (registry.remoteAccessEnabled && tunnel.state !== "on" && tunnel.state !== "connecting") {
    void connectTunnel().catch((error) => log.warn(`Ngrok reconnect failed: ${(error as Error).message}`));
  }
  for (const worker of workers.values()) {
    const status = worker.status();
    if (worker.definition.autoConnect && (!status.connected || !status.loggedIn) && !status.busy) {
      void worker.recover()
        .then(() => coordinator.prearmConnection(worker.definition.id))
        .catch((error) => {
          const message = `Health recovery failed for ${worker.definition.name}: ${(error as Error).message}`;
          log.warn(message);
          pushEvent("error", message);
          notifyActionNeeded(message);
        });
    }
  }
  void coordinator.recoverPendingProtection().catch((error) => {
    const message = `Pending Fast Entry protection needs attention: ${(error as Error).message}`;
    pushEvent("error", message);
    notifyActionNeeded(message);
  });
}, config.healthCheckSeconds * 1_000);
healthTimer.unref();

const targetTimer = setInterval(() => {
  void coordinator.monitorBrokerPositions().then((settled) => {
    for (const result of settled) {
      pushEvent("trade", result.message);
      if (result.won) notifyGoodNews(`Confirmed winning trade closed. ${result.message}`);
    }
    return coordinator.monitorBalanceTargets();
  }).then((results) => {
    for (const result of results) {
      const message = `Evaluation target reached. ${result.message}`;
      pushEvent("trade", message);
      notifyGoodNews(message);
    }
  }).catch((error) => {
    const message = `Balance target monitor needs attention: ${(error as Error).message}`;
    pushEvent("error", message);
    notifyActionNeeded(message);
  });
}, config.monitorActiveSeconds * 1_000);
targetTimer.unref();

const server = app.listen(config.port, config.host, () => {
  log.info(`V4 listening at http://${config.host}:${config.port}`);
  log.info(`Pools: ${registry.pools().map((pool) => pool.id).join(", ") || "none configured"}`);
  void autoConnect().then(() => coordinator.recoverPendingProtection()).catch((error) => {
    const message = `Startup protection recovery needs attention: ${(error as Error).message}`;
    pushEvent("error", message);
    notifyActionNeeded(message);
  });
  if (registry.remoteAccessEnabled) void connectTunnel().catch((error) => log.warn(`Ngrok startup failed: ${(error as Error).message}`));
  for (const pool of coordinator.status()) {
    if (!pool.state?.openTrade) continue;
    const message = `ATLAS restarted while ${pool.name} still records an open trade on ${pool.state.openTrade.accountName}. Check Tradovate before taking another action.`;
    pushEvent("error", message);
    notifyActionNeeded(message);
  }
});

async function shutdown() {
  clearInterval(healthTimer);
  clearInterval(targetTimer);
  await disconnectTunnel();
  await Promise.allSettled(workers.values().map((worker) => worker.disconnect()));
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
