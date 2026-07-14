import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { resolve } from "node:path";
import { config } from "./config.js";
import { AlertSchema, GROUPS, isCloseAlert, isGroup, type Group, type OrderRequest } from "./types.js";
import { SettingsStore } from "./store.js";
import { GroupRotation } from "./rotation.js";
import { TradovateBrowser } from "./browser.js";
import { BalanceLog } from "./balances.js";
import { Monitor } from "./monitor.js";
import { tradingDayKey } from "./tradingDay.js";
import { connectTunnel, disconnectTunnel, tunnelStatus, autoStartTunnel } from "./tunnel.js";
import { pushEvent, listEvents } from "./events.js";
import { notifyActionNeeded, notifyGoodNews } from "./notify.js";
import { log } from "./logger.js";

const store = new SettingsStore(config.settingsPath);
const browser = new TradovateBrowser(config);
/** Per-account last-known balance + short history. Read from MEMORY on the entry
 *  path (instant), written only when the bot reads a balance at arm/in-trade/exit. */
const balanceLog = new BalanceLog(config.balancesPath);
/** Trading-day label (6pm ET reset by default) shared by both rotations. */
const tradingDay = (at?: Date) => tradingDayKey(at ?? new Date(), config.tradingDayTz, config.tradingDayResetHour);
const rotations: Record<Group, GroupRotation> = {
  evals: new GroupRotation("evals", resolve(config.dataDir, "state-evals.json"), config.benchWinnersForDay, tradingDay),
  funded: new GroupRotation("funded", resolve(config.dataDir, "state-funded.json"), config.benchWinnersForDay, tradingDay),
};

/**
 * Serialize everything that touches the browser (orders from BOTH lanes, arming,
 * scans). Browser automation must never run two flows at once, and this keeps a
 * single, predictable order of operations.
 */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** Which lane fired most recently — the best guess for what fires next. */
let lastAlertGroup: Group = "evals";

/**
 * Pre-select the group's NEXT account so an entry webhook only has to click
 * Buy/Sell — the ONE dropdown touch that happens after a round-trip (or on
 * startup). Fire-and-forget; skipped in practice / when not logged in / not flat.
 */
function armNext(group: Group): void {
  if (store.mode !== "live" || !browser.status().loggedIn) return;
  const rotation = rotations[group];
  if (!rotation.isFlat) return;
  const next = rotation.peekNext(store.accountsIn(group));
  if (!next) return;
  void enqueue(async () => {
    await browser.armFor(next.tradovateLabel);
    // Read the armed account's balance now (idle — costs the entry click nothing).
    // This becomes the entry baseline used to judge win/loss at close.
    const eq = await browser.readSelectedEquity();
    if (eq != null) balanceLog.set(next.tradovateLabel, eq);
    // Select the account's saved ATM preset now (idle — off the entry path), so
    // the exchange holds its stop/target. If it fails, leave the existing ATM and
    // tell the user; the trade can still fire on whatever ATM is on the ticket.
    if (next.atmPreset) {
      try {
        await browser.selectAtmPreset(next.atmPreset);
      } catch (err) {
        pushEvent("warn", `Couldn't select ${next.name}'s ATM preset "${next.atmPreset}": ${(err as Error).message}`, group);
        notifyActionNeeded(`Couldn't pick ${next.name}'s ATM preset "${next.atmPreset}" on Tradovate — check it before trading. (${(err as Error).message})`);
      }
    }
  }).catch((err) => log.warn(`Pre-arm failed: ${(err as Error).message}`));
}

// ---------------------------------------------------------------------------
// Trade handling — deliberately minimal: switch account, click. Nothing else.
// ---------------------------------------------------------------------------

/**
 * Ensure we're on `label` WITHOUT touching the dropdown in the normal case.
 * If the bot is already there (armed) this is a pure no-op — the trade is then
 * just a click. It only opens the dropdown as a last-resort safety when the bot
 * somehow isn't pre-armed, and says so, so a click never hits the wrong account.
 */
async function ensureOn(label: string, name: string, group: Group): Promise<void> {
  if (browser.selectedAccount === label) return; // armed — do nothing
  pushEvent("warn", `Wasn't pre-armed on ${name} — switching to it first (this shouldn't normally happen).`, group);
  await browser.switchAccount(label);
}

async function executeEntry(label: string, name: string, order: OrderRequest, group: Group): Promise<void> {
  const sizeLabel = order.quantity != null ? `${order.quantity}x ` : "";
  if (store.mode === "practice") {
    pushEvent("trade", `PRACTICE — would ${order.action.toUpperCase()} ${sizeLabel}${order.symbol} on ${name} (${label}). No real order placed.`, group);
    return;
  }
  await ensureOn(label, name, group);
  // Set the size from the alert BEFORE the click. Cached, so a same-size trade
  // is a no-op; a change is one fast set that's verified (or the trade is
  // skipped). Omitted quantity = leave whatever size is on the ticket.
  if (order.quantity != null) await browser.setQuantity(order.quantity);
  await browser.clickOrder(order.action, label);
  pushEvent("trade", `LIVE — clicked ${order.action.toUpperCase()} ${sizeLabel}${order.symbol} on ${name} (${label}).`, group);
}

async function executeClose(label: string, name: string, symbol: string, group: Group): Promise<void> {
  if (store.mode === "practice") {
    pushEvent("trade", `PRACTICE — would CLOSE ${symbol} on ${name} (${label}). No real order placed.`, group);
    return;
  }
  await ensureOn(label, name, group);
  await browser.clickExit(label);
  pushEvent("trade", `LIVE — closed ${symbol} on ${name} (${label}).`, group);
}

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

async function handleEntry(group: Group, order: OrderRequest): Promise<string> {
  const rotation = rotations[group];
  const choice = rotation.selectAccountForEntry(store.accountsIn(group));
  if ("error" in choice) {
    pushEvent("warn", `Entry skipped: ${choice.error}`, group);
    return choice.error;
  }
  const acct = choice.account;

  // Instant, in-memory profit-target guard: if the last-known balance for this
  // account is already at/over target, retire it (no browser read) and try the
  // next one. Keeps a passed account from ever taking a fresh trade.
  const known = balanceLog.get(acct.tradovateLabel);
  if (known != null && known >= store.evalTarget) {
    store.markPassed(acct.tradovateLabel);
    pushEvent("info", `🏆 ${acct.name} is already at the ${money(store.evalTarget)} target — retired from rotation. Trying the next account.`, group);
    return handleEntry(group, order); // that account is now excluded; pick the next
  }

  await executeEntry(acct.tradovateLabel, acct.name, order, group);
  rotation.recordOpen(acct, order, known ?? undefined);
  return `Opened ${order.action} ${order.symbol} on ${acct.name}`;
}

async function handleClose(group: Group, symbol: string): Promise<string> {
  const rotation = rotations[group];
  if (rotation.isFlat) {
    pushEvent("warn", "A close alert arrived but no trade is open — ignoring it.", group);
    return "No open trade to close.";
  }
  const open = rotation.getState().openTrade!;
  await executeClose(open.tradovateLabel, open.accountName, symbol, group);

  // Read the settled balance AFTER the exit click (never on the entry path) to
  // log win/loss and the exit balance. Practice mode moves no money, so skip it.
  let exitBalance: number | undefined;
  if (store.mode === "live") {
    exitBalance = (await browser.readSettledEquity()) ?? undefined;
    if (exitBalance != null) balanceLog.set(open.tradovateLabel, exitBalance);
  }

  const { closed, next, won, pnl } = rotation.recordClose(store.accountsIn(group), { exitBalance });
  if (exitBalance != null && exitBalance >= store.evalTarget) {
    store.markPassed(closed.tradovateLabel);
    pushEvent("info", `🏆 ${closed.accountName} reached the ${money(store.evalTarget)} target — retired from rotation.`, group);
  }
  const wonMsg = won
    ? ` 🏅 WINNER${pnl != null ? ` (+${money(pnl)})` : ""} — resting for the rest of today.`
    : pnl != null
      ? ` (${pnl >= 0 ? "+" : "−"}${money(Math.abs(pnl))})`
      : "";
  const nextMsg = next ? `Next up: ${next.name}.` : "No accounts left in this group.";
  pushEvent("info", `Round-trip finished on ${closed.accountName}.${wonMsg} ${nextMsg}`, group);
  // Good news only: a WIN gets a happy ping. Routine trades stay silent.
  if (won) {
    notifyGoodNews(`🏅 Won a trade on ${closed.accountName}${pnl != null ? ` (+${money(pnl)})` : ""}. It's resting for the rest of today.`);
  }
  armNext(group); // get the browser sitting on the next account, ready to click
  return `Closed ${closed.symbol} on ${closed.accountName}.${wonMsg} ${nextMsg}`;
}

/**
 * Cut an open trade WITHOUT a webhook (the profit-target auto-close) and retire
 * the account. Assumes the trade's account is already the selected one (the
 * monitor only calls this for the selected account), so the exit is a pure
 * click. Must be called from inside `enqueue`.
 */
async function forceClose(group: Group, reason: string): Promise<void> {
  const rotation = rotations[group];
  const open = rotation.getState().openTrade;
  if (!open) return;
  pushEvent("warn", `🎯 ${open.accountName} hit the target — closing the trade automatically (${reason}).`, group);
  await browser.clickExit(open.tradovateLabel);
  const exitBalance = (await browser.readSettledEquity()) ?? undefined;
  if (exitBalance != null) balanceLog.set(open.tradovateLabel, exitBalance);
  const { closed, next } = rotation.recordClose(store.accountsIn(group), { won: true, exitBalance });
  store.markPassed(closed.tradovateLabel);
  const nextMsg = next ? `Next up: ${next.name}.` : "No accounts left in this group.";
  pushEvent("info", `🏆 ${closed.accountName} retired at the target. ${nextMsg}`, group);
  notifyGoodNews(`🎉 ${closed.accountName} hit the ${money(store.evalTarget)} target and was retired! ${nextMsg}`);
  armNext(group);
}

/**
 * The monitor's per-tick work: read ONLY the selected account's balance (the
 * open trade's account is the selected one), log it, and cut at the target.
 * Never switches accounts. No-op unless live + logged in + a trade is open on
 * the currently-selected account.
 */
async function monitorTick(): Promise<void> {
  if (store.mode !== "live" || !browser.status().loggedIn) return;
  const selected = browser.selectedAccount;
  if (!selected) return;
  const group = GROUPS.find((g) => rotations[g].getState().openTrade?.tradovateLabel === selected);
  if (!group) return;
  await enqueue(async () => {
    const open = rotations[group].getState().openTrade;
    if (!open || browser.selectedAccount !== open.tradovateLabel) return; // changed under us
    const equity = await browser.readSelectedEquity();
    if (equity == null) return;
    balanceLog.set(open.tradovateLabel, equity);
    if (equity >= store.evalTarget) await forceClose(group, `balance reached ${money(equity)}`);
  });
}

const monitor = new Monitor(monitorTick, {
  activeMs: config.monitorActiveSeconds * 1_000,
  isActive: () => GROUPS.some((g) => !rotations[g].isFlat),
});

/**
 * The health watch (every 45s, even when idle). Two silent failures this
 * catches BEFORE a trade is missed:
 *   1. A popup covering the screen → clears it.
 *   2. Tradovate logged out / left the trading screen → tries to log back in by
 *      itself; only buzzes the phone if it truly can't.
 * Cheap and serialized behind the trade queue, so it never contends with an
 * order. Recovery (a page reload) only runs while FLAT, never mid-trade.
 */
let healthTimer: ReturnType<typeof setInterval> | null = null;
function startHealthWatch(): void {
  if (healthTimer) return;
  healthTimer = setInterval(() => {
    if (!browser.status().connected) return;
    void enqueue(healthCheck).catch(() => {});
  }, 45_000);
}

async function healthCheck(): Promise<void> {
  if (!browser.status().connected) return;
  // Is the trading screen actually there? (Buy/Sell only exist when logged in.)
  const onTrader = await browser.refreshLoginState(4_000);
  if (onTrader) {
    await browser.dismissPopups().catch(() => {});
    return;
  }
  // The trading screen is gone — logged out, timed out, or navigated away.
  const anyTradeOpen = GROUPS.some((g) => !rotations[g].isFlat);
  if (anyTradeOpen) {
    // Never reload under an open trade — just raise the alarm loudly.
    pushEvent("error", "Tradovate isn't showing the trading screen while a trade is open — check it now.");
    notifyActionNeeded("Tradovate logged out / left the trading screen WHILE A TRADE IS OPEN. Check the bot computer and Tradovate right away.");
    return;
  }
  // Flat — safe to try fixing it ourselves.
  pushEvent("warn", "Tradovate isn't on the trading screen — trying to log back in automatically…");
  const status = await browser.recover().catch(() => null);
  if (status?.loggedIn) {
    pushEvent("info", "Recovered — Tradovate is logged back in.");
    armNext(lastAlertGroup);
  } else {
    pushEvent("error", "Couldn't log back into Tradovate automatically.");
    notifyActionNeeded("Tradovate logged out and I couldn't sign back in by myself. Please log in on the bot computer — trades won't fire until you do.");
  }
}

// ---------------------------------------------------------------------------
// App + dashboard authentication
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.disable("x-powered-by");

function authToken(): string {
  return createHmac("sha256", config.webhookSecret).update(config.dashboardPassword).digest("hex");
}

function isAuthed(req: Request): boolean {
  if (!config.dashboardPassword) return true;
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
// Webhooks (one per group)
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
  try {
    let waitedMs = 0;
    const message = await enqueue(() => {
      waitedMs = Date.now() - received;
      if (isCloseAlert(alert)) return handleClose(group, alert.symbol);
      const order: OrderRequest = {
        action: alert.action === "sell" ? "sell" : "buy",
        symbol: alert.symbol,
        tradeId: alert.tradeId,
        quantity: alert.quantity,
      };
      return handleEntry(group, order);
    });
    const totalMs = Date.now() - received;
    pushEvent("info", `⚡ Handled in ${totalMs}ms (waited ${waitedMs}ms for its turn).`, group);
    return res.json({ ok: true, message });
  } catch (err) {
    pushEvent("error", `Something went wrong handling a ${alert.action} alert: ${(err as Error).message}`, group);
    // A trade that didn't go through is the #1 "you're needed" case — it can
    // leave a position open or a signal missed. This buzzes the phone.
    notifyActionNeeded(
      `A ${alert.action.toUpperCase()} on ${group} didn't go through. Check the bot computer — a trade may need placing or closing by hand. (${(err as Error).message})`,
    );
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Dashboard API (cookie-protected when a password is set)
// ---------------------------------------------------------------------------

const api = express.Router();
api.use(requireAuth);

api.get("/status", (_req, res) => {
  const bal = balanceLog.snapshot();
  const decorate = (a: (typeof store.accounts)[number]) => {
    const rec = bal[a.tradovateLabel];
    const balance = rec?.balance ?? null;
    return {
      ...a,
      balance,
      updatedAt: rec?.updatedAt ?? null,
      history: rec?.history ?? [],
      toTarget: balance != null ? Math.max(0, store.evalTarget - balance) : null,
      restingToday: rotations[a.group].isBenchedToday(a.tradovateLabel),
    };
  };
  const groups: Record<string, unknown> = {};
  for (const group of GROUPS) {
    const rotation = rotations[group];
    const state = rotation.getState();
    groups[group] = {
      webhookPath: `/webhook/${group}`,
      accounts: store.allAccountsIn(group).map(decorate),
      next: rotation.peekNext(store.accountsIn(group))?.name ?? null,
      openTrade: state.openTrade,
      tradesToday: rotation.tradesToday(),
      log: rotation.todaysHistory(),
    };
  }
  res.json({
    ok: true,
    running: store.running,
    mode: store.mode,
    evalTarget: store.evalTarget,
    browser: browser.status(),
    tunnel: tunnelStatus(),
    groups,
    passed: store.passedAccounts().map(decorate),
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
  // Startup arm: go sit on the next account now, ready to click.
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

api.post("/accounts/reactivate", (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  const ok = store.reactivate(label);
  if (ok) {
    pushEvent("info", `${store.find(label)?.name ?? label} put back into rotation.`);
    armNext(lastAlertGroup);
  }
  res.json({ ok });
});

api.post("/accounts/atm-preset", (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  const preset = typeof req.body?.preset === "string" ? req.body.preset : "";
  const ok = store.setAtmPreset(label, preset);
  if (ok) {
    const acct = store.find(label);
    pushEvent(
      "info",
      preset.trim()
        ? `${acct?.name ?? label} will use ATM preset "${preset.trim()}".`
        : `${acct?.name ?? label} ATM preset cleared (uses whatever's on the Tradovate ticket).`,
    );
    armNext(acct?.group ?? lastAlertGroup); // re-arm so the new preset takes effect
  }
  res.json({ ok });
});

/** Calibration/test: select an ATM preset by name now, no order placed. */
api.post("/test-preset", async (req, res) => {
  const preset = typeof req.body?.preset === "string" ? req.body.preset.trim() : "";
  if (!preset) return res.json({ ok: true, set: false, message: "Type the ATM preset name to test." });
  if (!browser.status().loggedIn) {
    return res.json({ ok: true, set: false, message: "Connect the browser and log into Tradovate first." });
  }
  const started = Date.now();
  try {
    await enqueue(() => browser.selectAtmPreset(preset, true));
    const ms = Date.now() - started;
    pushEvent("info", `🎯 Selected ATM preset "${preset}" in ${ms}ms (test — no order).`);
    res.json({ ok: true, set: true, ms, preset });
  } catch (err) {
    pushEvent("warn", `Preset test couldn't select "${preset}": ${(err as Error).message}`);
    res.json({ ok: true, set: false, message: (err as Error).message });
  }
});

api.post("/accounts/unrest", (req, res) => {
  const group = req.body?.group;
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  if (typeof group !== "string" || !isGroup(group)) {
    return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
  }
  const ok = rotations[group].clearRest(label);
  if (ok) {
    pushEvent("info", `${store.find(label)?.name ?? label} taken off rest — it can trade again today.`, group);
    armNext(group);
  }
  res.json({ ok });
});

api.post("/next", (req, res) => {
  const group = req.body?.group;
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  if (typeof group !== "string" || !isGroup(group)) {
    return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
  }
  const rotation = rotations[group];
  if (!rotation.isFlat) {
    return res.status(400).json({ ok: false, error: "There's an open trade — the next account is chosen automatically when it closes." });
  }
  const ok = rotation.setNext(label, store.accountsIn(group));
  if (ok) {
    pushEvent("info", `Next ${group} trade will go to ${store.find(label)?.name ?? label}.`, group);
    armNext(group);
  }
  res.json({ ok });
});

/** Manually clear a stuck open trade (no order placed) and advance to the next
 *  account. Only fixes the bot's memory — it does NOT close any real position. */
api.post("/reset-trade", (req, res) => {
  const group = req.body?.group;
  if (typeof group !== "string" || !isGroup(group)) {
    return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
  }
  const rotation = rotations[group];
  const { was, next } = rotation.resetOpenTrade(store.accountsIn(group));
  const nextMsg = next ? `Next up: ${next.name}.` : "No accounts left in this group.";
  pushEvent(
    "warn",
    `Manually reset — marked ${was ? was.accountName : "this lane"} as closed (no order placed). ${nextMsg}`,
    group,
  );
  armNext(group); // sit on the next account, ready to click
  res.json({ ok: true, next: next?.name ?? null });
});

/** Speed test: fire a real buy-then-close at our own webhook and time each leg. */
api.post("/speedtest", async (req, res) => {
  const group = req.body?.group;
  if (typeof group !== "string" || !isGroup(group)) {
    return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
  }
  if (!store.running) return res.status(400).json({ ok: false, error: "The bot is paused — press Start first." });
  if (store.mode === "live" && req.body?.confirmLive !== true) {
    return res.status(400).json({ ok: false, error: "LIVE speed test needs confirmation (it places a real order)." });
  }
  const rotation = rotations[group];
  if (!rotation.isFlat) return res.status(400).json({ ok: false, error: "A trade is open in this group — try after it closes." });

  // The test is a normal round-trip: it advances the rotation and arms the next
  // account exactly like a real trade, so it never does an extra back-and-forth
  // switch in the browser.
  const base = `http://localhost:${config.port}`;
  const fire = async (payload: Record<string, unknown>) => {
    const started = Date.now();
    try {
      const r = await fetch(`${base}/webhook/${group}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
      return { ms: Date.now() - started, ok: r.ok, message: j.message ?? j.error ?? "" };
    } catch (err) {
      return { ms: Date.now() - started, ok: false, message: (err as Error).message };
    }
  };

  const secret = config.webhookSecret;
  const open = await fire({ secret, action: "buy", symbol: "SPEEDTEST", marketPosition: "long", tradeId: "speedtest" });
  const close = await fire({ secret, action: "sell", symbol: "SPEEDTEST", marketPosition: "flat" });
  // (handleClose already armed the next account — no extra switching here.)

  pushEvent(
    open.ok && close.ok ? "info" : "warn",
    `⏱ Speed test (${group}, ${store.mode}): open ${open.ms}ms, close ${close.ms}ms` +
      (open.ok && close.ok ? "" : ` — problem: ${!open.ok ? open.message : close.message}`),
    group,
  );
  res.json({ ok: true, openMs: open.ms, closeMs: close.ms, mode: store.mode, openOk: open.ok, closeOk: close.ok, openMsg: open.message, closeMsg: close.message });
});

/** Size test: set the order-ticket quantity (no order placed) and time it.
 *  Always returns 200 with a result object; on a miss it also returns a list of
 *  the page's editable fields so we can calibrate which one is the size box. */
api.post("/test-quantity", async (req, res) => {
  const qty = Math.floor(Number(req.body?.quantity));
  if (!Number.isFinite(qty) || qty < 1) {
    return res.json({ ok: true, set: false, message: "Enter a whole number of contracts (1 or more)." });
  }
  if (!browser.status().loggedIn) {
    return res.json({ ok: true, set: false, message: "Connect the browser and log into Tradovate first." });
  }
  const started = Date.now();
  try {
    await enqueue(() => browser.setQuantity(qty, true)); // force = always do the work
    const ms = Date.now() - started;
    pushEvent("info", `🔢 Set order size to ${qty} in ${ms}ms (test only — no order placed).`);
    res.json({ ok: true, set: true, ms, quantity: qty });
  } catch (err) {
    const fields = await enqueue(() => browser.inspectFields()).catch(() => []);
    pushEvent("warn", `Size test couldn't find the size box — showing the ${fields.length} fields it can see for calibration.`);
    res.json({ ok: true, set: false, quantity: qty, message: (err as Error).message, fields });
  }
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

api.post("/scan", async (_req, res) => {
  try {
    const labels = await enqueue(() => browser.listAccounts());
    pushEvent("info", `Scanned Tradovate: found ${labels.length} account(s).`);
    res.json({ ok: true, labels });
  } catch (err) {
    pushEvent("error", `Account scan failed: ${(err as Error).message}`);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

api.post("/tunnel/connect", async (_req, res) => {
  const status = await connectTunnel();
  res.json({ ok: status.state !== "error", tunnel: status, error: status.state === "error" ? status.error : undefined });
});

api.post("/tunnel/disconnect", async (_req, res) => {
  res.json({ ok: true, tunnel: await disconnectTunnel() });
});

app.use("/api", api);
app.use(express.static(config.publicDir));

// ---------------------------------------------------------------------------

async function main() {
  app.listen(config.port, () => {
    log.info(`Dashboard + webhooks listening on http://localhost:${config.port}`);
    log.info(`Webhooks: /webhook/evals and /webhook/funded | mode=${store.mode} | running=${store.running}`);
    // Note: no phone ping on a normal start. A clean restart that recovers on
    // its own isn't something you need to act on — so it stays quiet.
    pushEvent("info", `Bot server started. Mode: ${store.mode.toUpperCase()}. Open the dashboard to manage it.`);
    autoStartTunnel();
    monitor.start(); // watches the open trade's balance to cut at the target
    startHealthWatch(); // clears popups + catches/recovers a lost Tradovate login

    // Startup self-check: if the notes say a trade was open when we went down,
    // don't guess — this genuinely needs a human to verify, so it buzzes.
    for (const group of GROUPS) {
      const open = rotations[group].getState().openTrade;
      if (open) {
        pushEvent(
          "warn",
          `Heads-up: I just started and my notes say a trade is still open on ${open.accountName} (${open.symbol}). Please check Tradovate — if it isn't real, press "Mark closed / reset".`,
          group,
        );
        notifyActionNeeded(
          `The computer restarted while a trade was open on ${open.accountName} (${open.symbol}). Please check Tradovate — close it if needed, then press "Mark closed / reset".`,
        );
      }
    }

    // Self-healing: connect the Tradovate browser without a human click. The
    // saved session usually means it comes back logged in silently; only a real
    // login requirement (2FA) or a failure is worth a phone buzz.
    if (config.autoConnect) {
      void enqueue(() => browser.connect())
        .then((status) => {
          if (status.loggedIn) {
            pushEvent("info", "Tradovate browser connected and logged in automatically.");
            armNext(lastAlertGroup);
          } else {
            pushEvent("warn", "Browser opened but Tradovate needs a manual login — finish it in the browser window on the bot PC.");
            notifyActionNeeded("Tradovate needs you to log in on the bot computer (it couldn't sign in automatically). Trades won't fire until you do.");
          }
        })
        .catch((err) => {
          pushEvent("error", `Automatic browser connect failed: ${(err as Error).message}`);
          notifyActionNeeded(`I couldn't open the Tradovate browser on startup. Please check the bot computer. (${(err as Error).message})`);
        });
    }
  });
}

const shutdown = async () => {
  log.info("Shutting down…");
  monitor.stop();
  if (healthTimer) clearInterval(healthTimer);
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
