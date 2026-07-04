import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { resolve } from "node:path";
import { config } from "./config.js";
import { AlertSchema, GROUPS, isCloseAlert, isGroup, type Group, type OrderRequest } from "./types.js";
import { SettingsStore } from "./store.js";
import { GroupRotation } from "./rotation.js";
import { TradovateBrowser } from "./browser.js";
import { connectTunnel, disconnectTunnel, tunnelStatus, autoStartTunnel } from "./tunnel.js";
import { pushEvent, listEvents } from "./events.js";
import { log } from "./logger.js";

const store = new SettingsStore(config.settingsPath);
const browser = new TradovateBrowser(config);
const rotations: Record<Group, GroupRotation> = {
  evals: new GroupRotation("evals", resolve(config.dataDir, "state-evals.json")),
  funded: new GroupRotation("funded", resolve(config.dataDir, "state-funded.json")),
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
  void enqueue(() => browser.armFor(next.tradovateLabel)).catch((err) =>
    log.warn(`Pre-arm failed: ${(err as Error).message}`),
  );
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
  if (store.mode === "practice") {
    pushEvent("trade", `PRACTICE — would ${order.action.toUpperCase()} ${order.symbol} on ${name} (${label}). No real order placed.`, group);
    return;
  }
  await ensureOn(label, name, group);
  await browser.clickOrder(order.action, label);
  pushEvent("trade", `LIVE — clicked ${order.action.toUpperCase()} ${order.symbol} on ${name} (${label}).`, group);
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

async function handleEntry(group: Group, order: OrderRequest): Promise<string> {
  const rotation = rotations[group];
  const choice = rotation.selectAccountForEntry(store.accountsIn(group));
  if ("error" in choice) {
    pushEvent("warn", `Entry skipped: ${choice.error}`, group);
    return choice.error;
  }
  const acct = choice.account;
  await executeEntry(acct.tradovateLabel, acct.name, order, group);
  rotation.recordOpen(acct, order);
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
  const { closed, next } = rotation.recordClose(store.accountsIn(group));
  const nextMsg = next ? `Next up: ${next.name}.` : "No accounts left in this group.";
  pushEvent("info", `Round-trip finished on ${closed.accountName}. ${nextMsg}`, group);
  armNext(group); // get the browser sitting on the next account, ready to click
  return `Closed ${closed.symbol} on ${closed.accountName}. ${nextMsg}`;
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
      };
      return handleEntry(group, order);
    });
    const totalMs = Date.now() - received;
    pushEvent("info", `⚡ Handled in ${totalMs}ms (waited ${waitedMs}ms for its turn).`, group);
    return res.json({ ok: true, message });
  } catch (err) {
    pushEvent("error", `Something went wrong handling a ${alert.action} alert: ${(err as Error).message}`, group);
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Dashboard API (cookie-protected when a password is set)
// ---------------------------------------------------------------------------

const api = express.Router();
api.use(requireAuth);

api.get("/status", (_req, res) => {
  const groups: Record<string, unknown> = {};
  for (const group of GROUPS) {
    const rotation = rotations[group];
    const state = rotation.getState();
    groups[group] = {
      webhookPath: `/webhook/${group}`,
      accounts: store.allAccountsIn(group),
      next: rotation.peekNext(store.accountsIn(group))?.name ?? null,
      openTrade: state.openTrade,
      tradesToday: rotation.tradesToday(),
    };
  }
  res.json({
    ok: true,
    running: store.running,
    mode: store.mode,
    browser: browser.status(),
    tunnel: tunnelStatus(),
    groups,
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
    pushEvent("info", `Bot server started. Mode: ${store.mode.toUpperCase()}. Open the dashboard to manage it.`);
    autoStartTunnel();
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
