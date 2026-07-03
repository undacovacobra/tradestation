import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { resolve } from "node:path";
import { config } from "./config.js";
import { AlertSchema, GROUPS, isCloseAlert, isGroup, type Group, type OrderRequest } from "./types.js";
import { SettingsStore } from "./store.js";
import { GroupRotation } from "./rotation.js";
import { tradingDayKey } from "./tradingDay.js";
import { TradovateBrowser } from "./browser.js";
import { Monitor } from "./monitor.js";
import { connectTunnel, disconnectTunnel, tunnelStatus, autoStartTunnel } from "./tunnel.js";
import { pushEvent, listEvents } from "./events.js";
import { log } from "./logger.js";

const store = new SettingsStore(config.settingsPath);
const browser = new TradovateBrowser(config);
// The trading day rolls over in the evening (default 6pm ET), not at midnight.
const tradingDay = (at: Date = new Date()) => tradingDayKey(at, config.tradingDayTz, config.tradingDayResetHour);
const rotations: Record<Group, GroupRotation> = {
  evals: new GroupRotation("evals", resolve(config.dataDir, "state-evals.json"), config.oncePerDay, tradingDay),
  funded: new GroupRotation("funded", resolve(config.dataDir, "state-funded.json"), config.oncePerDay, tradingDay),
};

/**
 * Serialize everything that may touch the browser (orders from BOTH groups,
 * account scans). TradingView can fire alerts close together and browser
 * automation must never run two flows at once.
 *
 * SPEED: `pendingTrades` counts webhook trades waiting for the browser. All
 * background work (balance sweeps, arming) checks it and yields, so a trade
 * never waits behind more than one tiny background step.
 */
let queue: Promise<unknown> = Promise.resolve();
let pendingTrades = 0;
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** Which lane fired most recently — the best guess for what fires next. */
let lastAlertGroup: Group = "evals";

/**
 * Pre-arm the browser for the group's NEXT entry: select that account and
 * pre-set the size, so the entry webhook only has to click Buy/Sell.
 * Fire-and-forget; skipped in practice mode / when not logged in / not flat.
 */
function armNext(group: Group): void {
  if (store.mode !== "live" || !browser.status().loggedIn) return;
  const rotation = rotations[group];
  if (!rotation.isFlat) return;
  const next = rotation.peekNext(store.accountsIn(group));
  if (!next) return;
  void enqueue(() => {
    if (pendingTrades > 0) return Promise.resolve(); // never delay a real trade
    return browser.armFor(next.tradovateLabel, store.contractsFor(group));
  }).catch((err) => log.warn(`Pre-arm failed: ${(err as Error).message}`));
}

// ---------------------------------------------------------------------------
// Trade handling
// ---------------------------------------------------------------------------

/** Open a position. Returns the account balance read just before the order
 *  (live mode) so we can later judge win/loss; undefined in practice. */
async function executeEntry(label: string, name: string, order: OrderRequest, group: Group): Promise<number | undefined> {
  const qty = order.quantity ?? 1;
  if (store.mode === "practice") {
    pushEvent("trade", `PRACTICE — would ${order.action.toUpperCase()} ${qty} ${order.symbol} on ${name} (${label}). No real order placed.`, group);
    return undefined;
  }
  await browser.switchAccount(label);
  // Set + verify the size FIRST; setQuantity throws if it can't confirm, so we
  // never click Buy/Sell with the wrong number of contracts.
  await browser.setQuantity(qty);
  await browser.clickOrder(order.action, label);
  pushEvent("trade", `LIVE — clicked ${order.action.toUpperCase()} ${qty} ${order.symbol} on ${name} (${label}).`, group);
  // Read the entry balance AFTER firing the order so it never delays the fill.
  // A just-opened position has ~0 P&L, so this equals the pre-trade balance for
  // win/loss purposes.
  const after = await browser.readSelectedAccount().catch(() => null);
  return after?.balance ?? undefined;
}

/** Flatten the position. Returns the balance read just after closing (live)
 *  so win/loss can be measured; undefined in practice. */
async function executeClose(label: string, name: string, symbol: string, group: Group): Promise<number | undefined> {
  if (store.mode === "practice") {
    pushEvent("trade", `PRACTICE — would CLOSE ${symbol} on ${name} (${label}). No real order placed.`, group);
    return undefined;
  }
  await browser.switchAccount(label);
  await browser.clickExit(label);
  const after = await browser.readSettledBalance().catch(() => null);
  pushEvent("trade", `LIVE — closed ${symbol} on ${name} (${label}).`, group);
  return after?.balance ?? undefined;
}

async function handleEntry(group: Group, order: OrderRequest): Promise<string> {
  const rotation = rotations[group];
  let choice = rotation.selectAccountForEntry(store.accountsIn(group));

  // Belt-and-braces target guard: never OPEN a trade on an eval that's already
  // at/above the profit target, even if the monitor hasn't retired it yet.
  let guard = 0;
  while (!("error" in choice) && group === "evals" && guard++ < 100) {
    const bal = monitor.balanceOf(choice.account.tradovateLabel);
    if (bal === null || bal < store.evalTarget) break;
    pushEvent(
      "info",
      `${choice.account.name} is already at $${bal.toLocaleString()} (target reached) — skipping it and retiring it.`,
      group,
    );
    store.markPassed(choice.account.tradovateLabel);
    choice = rotation.selectAccountForEntry(store.accountsIn(group));
  }

  if ("error" in choice) {
    pushEvent("warn", `Entry skipped: ${choice.error}`, group);
    return choice.error;
  }
  const acct = choice.account;
  // The dashboard's per-group "Contracts per trade" is the source of truth for
  // size — not the alert — so the bot sets exactly this many on Tradovate.
  order.quantity = store.contractsFor(group);
  const entryBalance = await executeEntry(acct.tradovateLabel, acct.name, order, group);
  rotation.recordOpen(acct, order, entryBalance);
  return `Opened ${order.action} ${order.quantity} ${order.symbol} on ${acct.name}`;
}

async function handleClose(group: Group, symbol: string): Promise<string> {
  const rotation = rotations[group];
  if (rotation.isFlat) {
    pushEvent("warn", "A close alert arrived but no trade is open — ignoring it.", group);
    return "No open trade to close.";
  }
  const open = rotation.getState().openTrade!;
  const exitBalance = await executeClose(open.tradovateLabel, open.accountName, symbol, group);
  const { closed, next, won, pnl } = rotation.recordClose(store.accountsIn(group), { exitBalance });
  const nextMsg = next ? `Next up: ${next.name}.` : "No accounts left in this group.";
  const resultMsg =
    pnl != null
      ? won
        ? ` WON +$${pnl.toLocaleString()} — ${closed.accountName} is done for today.`
        : ` Result ${pnl >= 0 ? "+" : ""}$${pnl.toLocaleString()} (not a win) — it stays in the cycle.`
      : "";
  pushEvent(won ? "trade" : "info", `Round-trip finished on ${closed.accountName}.${resultMsg} ${nextMsg}`, group);
  // Get the browser sitting on the next account with the size pre-set, so the
  // next entry only has to click Buy/Sell.
  armNext(group);
  return `Closed ${closed.symbol} on ${closed.accountName}.${resultMsg} ${nextMsg}`;
}

/**
 * Close a group's open trade WITHOUT a webhook (used by the monitor when an
 * eval hits the profit target). Flattens at market and advances the rotation.
 */
async function forceClose(group: Group, reason: string): Promise<void> {
  const rotation = rotations[group];
  if (rotation.isFlat) return;
  const open = rotation.getState().openTrade!;
  const exitBalance = await enqueue(() => executeClose(open.tradovateLabel, open.accountName, open.symbol, group));
  // Hitting the profit target is by definition a win for that account.
  const { closed, next } = rotation.recordClose(store.accountsIn(group), { won: true, exitBalance });
  const nextMsg = next ? `Next up: ${next.name}.` : "No accounts left in this group.";
  pushEvent("warn", `${reason} Closed the open trade on ${closed.accountName} automatically. ${nextMsg}`, group);
  armNext(group);
}

const monitor = new Monitor({
  store,
  rotations,
  isBrowserReady: () => browser.status().loggedIn,
  readSelected: () => enqueue(() => browser.readSelectedAccount()),
  readAccount: (label) => enqueue(() => browser.readAccount(label)),
  // Interruptible full sweep: each account is its own small queue job and the
  // loop bails out the moment a trade is waiting — so a webhook never sits
  // behind a multi-second all-accounts balance cycle.
  readAll: async () => {
    const labels = await enqueue(() => (pendingTrades > 0 ? Promise.resolve([]) : browser.listAccounts()));
    const out: { label: string; balance: number | null }[] = [];
    for (const label of labels) {
      if (pendingTrades > 0) break; // yield to the trade; finish next sweep
      out.push(await enqueue(() => browser.readAccount(label)).catch(() => ({ label, balance: null })));
    }
    // The sweep leaves the browser on whatever account it read last — put it
    // back on the account that's up next so entries stay instant.
    armNext(lastAlertGroup);
    return out;
  },
  forceClose,
  balancesPath: config.balancesPath,
  intervalSeconds: config.monitorSeconds,
  activeIntervalSeconds: config.monitorActiveSeconds,
});

// ---------------------------------------------------------------------------
// App + dashboard authentication
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.disable("x-powered-by");

/** Session cookie value: HMAC of the dashboard password, keyed by the webhook secret. */
function authToken(): string {
  return createHmac("sha256", config.webhookSecret).update(config.dashboardPassword).digest("hex");
}

function isAuthed(req: Request): boolean {
  if (!config.dashboardPassword) return true; // no password set -> local-only use
  const cookies = req.headers.cookie ?? "";
  const match = /(?:^|;\s*)dash=([a-f0-9]+)/.exec(cookies);
  if (!match) return false;
  const expected = Buffer.from(authToken());
  const got = Buffer.from(match[1]!);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthed(req)) return next();
  res.status(401).json({ ok: false, error: "Please log in." });
}

app.post("/api/login", (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!config.dashboardPassword || password === config.dashboardPassword) {
    res.cookie("dash", authToken(), { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Wrong password." });
});

// ---------------------------------------------------------------------------
// Webhooks (one per group) — protected by the shared secret, not the cookie.
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/webhook/:group", async (req, res) => {
  const groupName = req.params.group;
  if (!isGroup(groupName)) {
    return res.status(404).json({ ok: false, error: "Unknown webhook. Use /webhook/evals or /webhook/funded." });
  }
  const group: Group = groupName;

  const parsed = AlertSchema.safeParse(req.body);
  if (!parsed.success) {
    pushEvent("warn", "Rejected an alert that didn't look right (bad or missing fields).", group);
    return res.status(400).json({ ok: false, error: "Invalid alert payload" });
  }
  const alert = parsed.data;
  if (alert.secret !== config.webhookSecret) {
    pushEvent("warn", "Rejected an alert with the wrong secret.", group);
    return res.status(401).json({ ok: false, error: "Bad secret" });
  }
  if (!store.running) {
    pushEvent("warn", `Alert received (${alert.action} ${alert.symbol}) but the bot is PAUSED — nothing was done.`, group);
    return res.json({ ok: true, message: "Bot is paused; alert ignored." });
  }

  const received = Date.now();
  lastAlertGroup = group;
  pendingTrades++;
  try {
    let waitedMs = 0;
    const message = await enqueue(() => {
      waitedMs = Date.now() - received;
      if (isCloseAlert(alert)) return handleClose(group, alert.symbol);
      // Past the close check, this is an entry: action is "buy" or "sell".
      const order: OrderRequest = {
        action: alert.action === "sell" ? "sell" : "buy",
        symbol: alert.symbol,
        quantity: alert.quantity ?? 1,
        orderType: alert.orderType,
        price: alert.price,
        stopLoss: alert.stopLoss,
        takeProfit: alert.takeProfit,
        tradeId: alert.tradeId,
      };
      return handleEntry(group, order);
    });
    const totalMs = Date.now() - received;
    pushEvent("info", `⚡ Handled in ${totalMs}ms (waited ${waitedMs}ms for its turn).`, group);
    return res.json({ ok: true, message });
  } catch (err) {
    pushEvent("error", `Something went wrong handling a ${alert.action} alert: ${(err as Error).message}`, group);
    return res.status(500).json({ ok: false, error: (err as Error).message });
  } finally {
    pendingTrades--;
  }
});

// ---------------------------------------------------------------------------
// Dashboard API (cookie-protected when a password is set)
// ---------------------------------------------------------------------------

const api = express.Router();
api.use(requireAuth);

api.get("/status", (_req, res) => {
  const balances = monitor.snapshot();
  const withBalance = (a: { tradovateLabel: string; group: string }) => {
    const b = balances[a.tradovateLabel];
    return {
      ...a,
      balance: b?.balance ?? null,
      balanceUpdatedAt: b?.updatedAt ?? null,
      history: b?.history ?? [],
      toTarget: a.group === "evals" && b ? Math.max(0, store.evalTarget - b.balance) : null,
    };
  };
  const groups: Record<string, unknown> = {};
  for (const group of GROUPS) {
    const rotation = rotations[group];
    const enabled = store.accountsIn(group);
    const state = rotation.getState();
    groups[group] = {
      webhookPath: `/webhook/${group}`,
      accounts: store.allAccountsIn(group).map((a) => ({
        ...withBalance(a),
        restingToday: rotation.isBenchedToday(a.tradovateLabel), // won already today
      })),
      next: rotation.peekNext(enabled)?.name ?? null,
      openTrade: state.openTrade,
      tradesToday: rotation.tradesToday(),
      recentHistory: state.history.slice(-5).reverse(),
    };
  }
  res.json({
    ok: true,
    running: store.running,
    mode: store.mode,
    oncePerDay: config.oncePerDay,
    evalTarget: store.evalTarget,
    contracts: { evals: store.contractsFor("evals"), funded: store.contractsFor("funded") },
    browser: browser.status(),
    tunnel: tunnelStatus(),
    groups,
    passed: store.passedAccounts().map(withBalance),
    events: listEvents(60),
  });
});

api.post("/running", (req, res) => {
  const running = req.body?.running === true;
  store.setRunning(running);
  pushEvent("info", running ? "Bot STARTED — alerts will be handled." : "Bot PAUSED — alerts will be ignored.");
  res.json({ ok: true, running });
});

api.post("/mode", (req, res) => {
  const mode = req.body?.mode;
  if (mode !== "practice" && mode !== "live") {
    return res.status(400).json({ ok: false, error: "mode must be 'practice' or 'live'" });
  }
  if (mode === "live" && req.body?.confirm !== true) {
    return res.status(400).json({ ok: false, error: "Switching to LIVE requires confirmation." });
  }
  store.setMode(mode);
  pushEvent(
    mode === "live" ? "warn" : "info",
    mode === "live"
      ? "Switched to LIVE mode — alerts will place REAL orders in Tradovate."
      : "Switched to PRACTICE mode — trades are only simulated in the log.",
  );
  if (mode === "live") armNext(lastAlertGroup);
  return res.json({ ok: true, mode });
});

api.post("/accounts/add", (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const group = req.body?.group;
  if (!label) return res.status(400).json({ ok: false, error: "Account id is required." });
  if (typeof group !== "string" || !isGroup(group)) {
    return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
  }
  const acct = store.upsertAccount(label, group, name || undefined);
  pushEvent("info", `Account ${acct.name} (${label}) added to ${group}.`, group);
  res.json({ ok: true, account: acct });
});

api.post("/accounts/remove", (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  const removed = store.removeAccount(label);
  if (removed) pushEvent("info", `Account ${label} removed.`);
  res.json({ ok: removed });
});

api.post("/accounts/toggle", (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  res.json({ ok: store.toggleAccount(label) });
});

api.post("/accounts/move", (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  const direction = req.body?.direction === "up" ? "up" : "down";
  res.json({ ok: store.moveAccount(label, direction) });
});

api.post("/contracts", (req, res) => {
  const group = req.body?.group;
  const contracts = Number(req.body?.contracts);
  if (typeof group !== "string" || !isGroup(group)) {
    return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
  }
  if (!Number.isFinite(contracts) || contracts < 1) {
    return res.status(400).json({ ok: false, error: "contracts must be a whole number of at least 1" });
  }
  store.setContracts(group, contracts);
  pushEvent("info", `Contracts per trade for ${group} set to ${store.contractsFor(group)}.`, group);
  armNext(group); // pre-set the new size on the ticket
  res.json({ ok: true, contracts: store.contractsFor(group) });
});

api.post("/test-quantity", async (req, res) => {
  const group = req.body?.group;
  if (typeof group !== "string" || !isGroup(group)) {
    return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
  }
  const want = store.contractsFor(group);
  try {
    const confirmed = await enqueue(() => browser.setQuantity(want));
    pushEvent("info", `Contract-size test OK — Tradovate now shows ${confirmed} on the order ticket (no order placed).`, group);
    res.json({ ok: true, confirmed });
  } catch (err) {
    pushEvent("warn", `Contract-size test failed: ${(err as Error).message}`, group);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

api.post("/next", (req, res) => {
  const group = req.body?.group;
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  if (typeof group !== "string" || !isGroup(group)) {
    return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
  }
  const rotation = rotations[group];
  if (!rotation.isFlat) {
    return res.status(400).json({
      ok: false,
      error: "There's an open trade — the next account is chosen automatically when it closes.",
    });
  }
  const ok = rotation.setNext(label, store.accountsIn(group));
  if (ok) {
    const acct = store.find(label);
    pushEvent("info", `Next ${group} trade will go to ${acct?.name ?? label}.`, group);
    armNext(group);
  }
  res.json({ ok });
});

api.post("/accounts/reactivate", (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  const ok = store.reactivate(label);
  if (ok) pushEvent("info", `${label} was moved back into its rotation from the Passed column.`);
  res.json({ ok });
});

api.post("/browser/connect", async (_req, res) => {
  try {
    const status = await enqueue(() => browser.connect());
    pushEvent(
      status.loggedIn ? "info" : "warn",
      status.loggedIn
        ? "Tradovate browser connected and logged in."
        : "Browser opened, but not logged in yet — finish the login in the browser window on the bot PC.",
    );
    if (status.loggedIn) armNext(lastAlertGroup);
    res.json({ ok: true, browser: status });
  } catch (err) {
    pushEvent("error", `Could not open the Tradovate browser: ${(err as Error).message}`);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

api.post("/browser/disconnect", async (_req, res) => {
  await enqueue(() => browser.disconnect());
  pushEvent("info", "Tradovate browser closed.");
  res.json({ ok: true });
});

api.post("/tunnel/connect", async (_req, res) => {
  const status = await connectTunnel();
  res.json({ ok: status.state !== "error", tunnel: status, error: status.state === "error" ? status.error : undefined });
});

api.post("/tunnel/disconnect", async (_req, res) => {
  const status = await disconnectTunnel();
  res.json({ ok: true, tunnel: status });
});

api.post("/scan", async (_req, res) => {
  try {
    const rows = await enqueue(() => browser.readAllBalances());
    // Fill balances/charts in immediately instead of waiting for the next sweep.
    monitor.scanIngest(rows);
    const withDollars = rows.filter((r) => r.balance !== null).length;
    pushEvent(
      "info",
      `Scanned Tradovate: found ${rows.length} account(s)${withDollars ? `, ${withDollars} with balances` : ""}.`,
    );
    res.json({ ok: true, labels: rows.map((r) => r.label), balances: rows });
  } catch (err) {
    pushEvent("error", `Account scan failed: ${(err as Error).message}`);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.use("/api", api);
app.use(express.static(config.publicDir));

// ---------------------------------------------------------------------------

async function main() {
  app.listen(config.port, () => {
    log.info(`Dashboard + webhooks listening on http://localhost:${config.port}`);
    log.info(`Webhooks: /webhook/evals and /webhook/funded | mode=${store.mode} | running=${store.running}`);
    pushEvent("info", `Bot server started. Mode: ${store.mode.toUpperCase()}. Open the dashboard to manage it.`);
    // Bring remote access up automatically if it's configured, so a fresh
    // double-click of the startup shortcut needs no extra steps.
    autoStartTunnel();
    // Balance / new-account / eval-target monitor (idles until the Tradovate
    // browser is connected and logged in).
    monitor.start();
  });
}

const shutdown = async () => {
  log.info("Shutting down…");
  await disconnectTunnel().catch(() => {});
  await browser.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  log.error("Fatal startup error:", err);
  process.exit(1);
});
