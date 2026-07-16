import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { resolve } from "node:path";
import { config, ROOT } from "./config.js";
import { GROUPS, isCloseAlert, isGroup, type Alert, type Group, type OrderRequest, type StoredAccount } from "./types.js";
import { PRIMARY_LOGIN_ID, SettingsStore } from "./store.js";
import { GroupRotation, laneStatePath, migrateLegacyLaneState, type OpenTrade } from "./rotation.js";
import { BalanceLog } from "./balances.js";
import { Monitor } from "./monitor.js";
import { tradingDayKey } from "./tradingDay.js";
import { connectTunnel, disconnectTunnel, tunnelStatus, autoStartTunnel } from "./tunnel.js";
import { pushEvent, listEvents } from "./events.js";
import { notifyActionNeeded, notifyGoodNews } from "./notify.js";
import { log } from "./logger.js";
import { registerAccountMutationRoutes } from "./accountMutationRoutes.js";
import { LoginManager, TradovateSessionAdapter, type EntryTiming, type LoginWorker } from "./sessions.js";
import { GroupDispatcher } from "./groupDispatch.js";
import { registerWebhookRoutes, type WebhookHandleResult } from "./webhookRoutes.js";
import { registerLoginRoutes } from "./loginRoutes.js";
import { shouldRetireAtBalance, usesEvaluationTarget } from "./tradePolicy.js";
import { resolveReadinessCredentialIds, runSimultaneousReadinessTest } from "./simultaneousReadiness.js";
import { CredentialLaneRegistry, laneKey, type CredentialLane, type LaneKey } from "./lanes.js";
import type { BrokerPosition } from "./brokerPosition.js";
import { PositionReconciler, type PositionObservation } from "./positionReconciler.js";
import { brokerStatusLabel, decideCloseAction, tradeFingerprint } from "./brokerTradePolicy.js";
import { connectedLoginNextStep, restorePersistedTradeLeases } from "./startupPositionRecovery.js";
import { flattenPositions, type FlattenTarget } from "./flattenPositions.js";
import { registerFlattenRoutes } from "./flattenRoutes.js";

const store = new SettingsStore(config.settingsPath);
const sessions = new LoginManager(
  store.logins,
  (definition) => new TradovateSessionAdapter(definition, config, ROOT),
  { fundedPriorityWindowMs: config.fundedPriorityWindowMs },
);
const dispatcher = new GroupDispatcher<string>();
/** Per-account last-known balance + short history. Read from MEMORY on the entry
 *  path (instant), written only when the bot reads a balance at arm/in-trade/exit. */
const balanceLog = new BalanceLog(config.balancesPath);
/** Trading-day label (6pm ET reset by default) shared by both rotations. */
const tradingDay = (at?: Date) => tradingDayKey(at ?? new Date(), config.tradingDayTz, config.tradingDayResetHour);
const laneRotations = new Map<LaneKey, GroupRotation>();
const positionReconciler = new PositionReconciler({ unknownAlertAfter: 3, unknownAlertEvery: 10 });
interface BrokerLaneStatus {
  state: string;
  checkedAt?: string;
  netPosition?: number;
  reason?: string;
  flatReads: number;
  unknownReads: number;
}
const brokerLaneStatus = new Map<LaneKey, BrokerLaneStatus>();
const brokerAccountStatus = new Map<string, BrokerPosition>();
interface PendingBrokerClose {
  requestedAt: string;
  reason: string;
  won?: boolean;
  retire?: boolean;
}
const pendingBrokerClose = new Map<LaneKey, PendingBrokerClose>();
const completingTrades = new Map<LaneKey, Promise<string | undefined>>();

function brokerAccountKey(loginId: string, label: string): string {
  return `${loginId}:${label}`;
}

function rememberBrokerPosition(loginId: string, label: string, position: BrokerPosition): BrokerPosition {
  brokerAccountStatus.set(brokerAccountKey(loginId, label), position);
  return position;
}

function currentLanes(): CredentialLane[] {
  return new CredentialLaneRegistry(store.logins, store.accounts).values();
}

function ensureLaneRotation(lane: CredentialLane): GroupRotation {
  const existing = laneRotations.get(lane.key);
  if (existing) return existing;
  const target = laneStatePath(config.dataDir, lane.key);
  if (lane.credentialId === PRIMARY_LOGIN_ID) {
    migrateLegacyLaneState(resolve(config.dataDir, `state-${lane.stage}.json`), target);
  }
  const rotation = new GroupRotation(lane.stage, target, config.benchWinnersForDay, tradingDay);
  laneRotations.set(lane.key, rotation);
  return rotation;
}

function laneFor(credentialId: string, stage: Group): CredentialLane {
  const lane = currentLanes().find((candidate) => candidate.credentialId === credentialId && candidate.stage === stage);
  if (!lane) throw new Error(`Missing ${stage} lane for credential ${credentialId}.`);
  return lane;
}

function primaryLane(stage: Group): CredentialLane {
  return laneFor(PRIMARY_LOGIN_ID, stage);
}

function accountsForLane(lane: CredentialLane, includeDisabled = false): StoredAccount[] {
  return store.accounts.filter((account) =>
    account.loginId === lane.credentialId
    && account.group === lane.stage
    && account.status === "active"
    && (includeDisabled || account.enabled));
}

for (const lane of currentLanes()) ensureLaneRotation(lane);

/** Legacy primary-lane aliases retained for existing dashboard controls. */
const rotations: Record<Group, GroupRotation> = {
  evals: ensureLaneRotation(primaryLane("evals")),
  funded: ensureLaneRotation(primaryLane("funded")),
};

// Restore the safety leases represented by persisted rotation state before any
// browser can reconnect or prepare another account.
restorePersistedTradeLeases(
  currentLanes(),
  (lane) => ensureLaneRotation(lane).getState().openTrade,
  (loginId) => sessions.get(loginId),
);

/**
 * Serialize everything that touches the browser (orders from BOTH lanes, arming,
 * scans). Browser automation must never run two flows at once, and this keeps a
 * single, predictable order of operations.
 */
/** Which lane fired most recently — the best guess for what fires next. */
let lastAlertGroup: Group = "evals";
const readinessErrors = new Map<string, string>();

function workerForAccount(account: Pick<StoredAccount, "loginId" | "name">): LoginWorker {
  const worker = sessions.get(account.loginId);
  if (!worker) throw new Error(`${account.name} references missing login ${account.loginId}.`);
  return worker;
}

function openTradeLoginForLane(lane: CredentialLane): string | undefined {
  const open = ensureLaneRotation(lane).getState().openTrade;
  if (!open) return undefined;
  return open.loginId ?? store.find(open.tradovateLabel)?.loginId ?? lane.credentialId;
}

function hasOpenTradeForLogin(loginId: string): boolean {
  return currentLanes().some((lane) => openTradeLoginForLane(lane) === loginId);
}

function hasOpenTradeForAccount(label: string): boolean {
  return currentLanes().some((lane) => ensureLaneRotation(lane).getState().openTrade?.tradovateLabel === label);
}

/**
 * Pre-select the group's NEXT account so an entry webhook only has to click
 * Buy/Sell — the ONE dropdown touch that happens after a round-trip (or on
 * startup). Fire-and-forget; skipped in practice / when not logged in / not flat.
 */
async function prepareLane(lane: CredentialLane, force = false): Promise<void> {
  const group = lane.stage;
  const rotation = ensureLaneRotation(lane);
  if (!rotation.isFlat) return;
  const next = rotation.peekNext(accountsForLane(lane));
  if (!next) {
    readinessErrors.delete(lane.key);
    return;
  }
  const worker = workerForAccount(next);
  if (hasOpenTradeForLogin(worker.definition.id)) {
    throw new Error(`${worker.definition.name} owns an open trade and cannot run background preparation.`);
  }
  if (!worker.status().loggedIn) throw new Error(`${worker.definition.name} is not connected and logged in.`);
  let armedBalance: number | undefined;
  await worker.prepare(group, next, {
    onBalance: (label, equity) => {
      armedBalance = equity;
      balanceLog.set(label, equity);
    },
    onPresetError: (error) => {
      pushEvent("warn", `Couldn't select ${next.name}'s ATM preset "${next.atmPreset}": ${error.message}`, group);
      notifyActionNeeded(`Couldn't pick ${next.name}'s ATM preset "${next.atmPreset}" on Tradovate — check it before trading. (${error.message})`);
    },
  }, force);
  if (armedBalance != null && shouldRetireAtBalance(group, armedBalance, store.evalTarget)) {
    store.markPassed(next.tradovateLabel);
    worker.invalidateReady();
    pushEvent("info", `${next.name} is already at the ${money(store.evalTarget)} evaluation target - retired before another signal could use it.`, group);
    await prepareLane(lane, true);
    return;
  }
  readinessErrors.delete(lane.key);
}

async function prepareGroup(group: Group, force = false): Promise<void> {
  return prepareLane(primaryLane(group), force);
}

function armLane(lane: CredentialLane, options: { force?: boolean } = {}): void {
  void prepareLane(lane, options.force === true).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    readinessErrors.set(lane.key, message);
    log.warn(`Pre-arm failed for ${lane.key}: ${message}`);
  });
}

function armNext(group: Group, options: { force?: boolean } = {}): void {
  armLane(primaryLane(group), options);
}

function armStageAll(group: Group, options: { force?: boolean } = {}): void {
  for (const lane of currentLanes().filter((candidate) => candidate.stage === group)) armLane(lane, options);
}

async function armLogin(loginId: string): Promise<void> {
  for (const lane of currentLanes().filter((candidate) => candidate.credentialId === loginId)) {
    const next = ensureLaneRotation(lane).peekNext(accountsForLane(lane));
    if (!next) continue;
    await prepareLane(lane).catch((error) => {
      readinessErrors.set(lane.key, error instanceof Error ? error.message : String(error));
    });
  }
}

async function armAll(): Promise<void> {
  await Promise.allSettled(sessions.values().map((worker) => armLogin(worker.definition.id)));
}

// ---------------------------------------------------------------------------
// Trade handling — account and ATM are already prepared; entry is qty + click.
// ---------------------------------------------------------------------------

async function executeEntry(
  label: string,
  name: string,
  order: OrderRequest,
  group: Group,
  options: { skipFundedWindow?: boolean } = {},
): Promise<EntryTiming | undefined> {
  const sizeLabel = order.quantity != null ? `${order.quantity}x ` : "";
  if (store.mode === "practice") {
    pushEvent("trade", `PRACTICE — would ${order.action.toUpperCase()} ${sizeLabel}${order.symbol} on ${name} (${label}). No real order placed.`, group);
    return undefined;
  }
  const account = store.find(label);
  if (!account) throw new Error(`Account ${label} is no longer configured.`);
  const worker = workerForAccount(account);
  const timing = await worker.enterPrepared(group, account, order, options);
  pushEvent("trade", `LIVE — clicked ${order.action.toUpperCase()} ${sizeLabel}${order.symbol} on ${name} (${label}) via ${worker.definition.name}.`, group);
  return timing;
}

async function executeClose(label: string, name: string, symbol: string, group: Group, lane = primaryLane(group)): Promise<void> {
  if (store.mode === "practice") {
    pushEvent("trade", `PRACTICE — would CLOSE ${symbol} on ${name} (${label}). No real order placed.`, group);
    return;
  }
  const loginId = openTradeLoginForLane(lane);
  const worker = loginId ? sessions.get(loginId) : undefined;
  if (!worker) throw new Error(`The open trade on ${name} references a missing login.`);
  await worker.close(group, label);
  pushEvent("trade", `LIVE — requested CLOSE ${symbol} on ${name} (${label}) via ${worker.definition.name}; waiting for broker POSITION 0.`, group);
}

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function observeBrokerPosition(
  lane: CredentialLane,
  open: OpenTrade,
  position: BrokerPosition,
): PositionObservation {
  const loginId = open.loginId ?? store.find(open.tradovateLabel)?.loginId ?? lane.credentialId;
  rememberBrokerPosition(loginId, open.tradovateLabel, position);
  const observation = positionReconciler.observe(lane.key, tradeFingerprint(open), position);
  const prior = brokerLaneStatus.get(lane.key);
  const state = brokerStatusLabel(position, observation.flatReads);
  brokerLaneStatus.set(lane.key, {
    state,
    checkedAt: position.checkedAt,
    ...(position.status === "open" ? { netPosition: position.netPosition } : {}),
    ...(position.status === "unknown" ? { reason: position.reason } : {}),
    flatReads: observation.flatReads,
    unknownReads: observation.unknownReads,
  });

  if (position.status === "open" && prior?.state !== state) {
    pushEvent("info", `Broker confirmed ${open.accountName} is ${state}.`, lane.stage);
  }
  if (observation.kind === "flat-candidate") {
    pushEvent("info", `Broker shows POSITION 0 on ${open.accountName}; confirming once more before rotating.`, lane.stage);
  }
  if (observation.kind === "unknown" && position.status === "unknown" && observation.unknownReads === 1) {
    pushEvent("warn", `Broker position is temporarily UNKNOWN for ${open.accountName}: ${position.reason}`, lane.stage);
  }
  if (observation.kind === "unknown" && position.status === "unknown" && observation.shouldAlert) {
    notifyActionNeeded(
      `ATLAS cannot verify the broker POSITION for ${open.accountName} after ${observation.unknownReads} checks. `
      + `The trade is still recorded and no flat state was assumed. (${position.reason})`,
    );
  }
  return observation;
}

async function completeRecordedTrade(
  lane: CredentialLane,
  expectedFingerprint: string,
  options: { source: string; won?: boolean; retire?: boolean },
): Promise<string | undefined> {
  const existing = completingTrades.get(lane.key);
  if (existing) return existing;

  const work = (async () => {
    const group = lane.stage;
    const rotation = ensureLaneRotation(lane);
    let open = rotation.getState().openTrade;
    if (!open || tradeFingerprint(open) !== expectedFingerprint) return undefined;

    const loginId = open.loginId ?? store.find(open.tradovateLabel)?.loginId ?? lane.credentialId;
    const worker = sessions.get(loginId);
    let exitBalance: number | undefined;
    if (store.mode === "live" && worker?.status().loggedIn) {
      exitBalance = (await worker.readSettledEquity().catch(() => null)) ?? undefined;
      if (exitBalance != null) balanceLog.set(open.tradovateLabel, exitBalance);
    }

    // Settled-equity reading yields the queue. Re-check identity before the one
    // rotation mutation so webhook/monitor/manual races remain exactly once.
    open = rotation.getState().openTrade;
    if (!open || tradeFingerprint(open) !== expectedFingerprint) return undefined;

    const { closed, next, won, pnl } = rotation.recordClose(accountsForLane(lane), {
      won: options.won,
      exitBalance,
    });
    worker?.clearOpenTrade(closed.tradovateLabel);
    pendingBrokerClose.delete(lane.key);
    brokerLaneStatus.set(lane.key, {
      state: "FLAT",
      checkedAt: new Date().toISOString(),
      flatReads: 2,
      unknownReads: 0,
    });
    rememberBrokerPosition(loginId, closed.tradovateLabel, {
      status: "flat",
      checkedAt: new Date().toISOString(),
    });

    if (options.retire || (usesEvaluationTarget(group) && exitBalance != null && exitBalance >= store.evalTarget)) {
      store.markPassed(closed.tradovateLabel);
      pushEvent("info", `${closed.accountName} reached the ${money(store.evalTarget)} target and was retired from rotation.`, group);
    }

    const wonMsg = won
      ? ` WINNER${pnl != null ? ` (+${money(pnl)})` : ""} - resting for the rest of today.`
      : pnl != null ? ` (${pnl >= 0 ? "+" : "-"}${money(Math.abs(pnl))})` : "";
    const nextMsg = next ? `Next up: ${next.name}.` : "No accounts left in this group.";
    pushEvent("info", `Broker confirmed flat on ${closed.accountName} (${options.source}).`, group);
    pushEvent("info", `Round-trip finished on ${closed.accountName}.${wonMsg} ${nextMsg}`, group);
    if (won) {
      notifyGoodNews(`Won a trade on ${closed.accountName}${pnl != null ? ` (+${money(pnl)})` : ""}. It's resting for the rest of today.`);
    }
    armLane(lane);
    return `Broker confirmed flat on ${closed.accountName}.${wonMsg} ${nextMsg}`;
  })();

  completingTrades.set(lane.key, work);
  try {
    return await work;
  } finally {
    if (completingTrades.get(lane.key) === work) completingTrades.delete(lane.key);
  }
}

async function handleEntry(
  group: Group,
  order: OrderRequest,
  lane = primaryLane(group),
  options: { skipFundedWindow?: boolean } = {},
): Promise<WebhookHandleResult> {
  const rotation = ensureLaneRotation(lane);
  const laneAccounts = accountsForLane(lane);
  const choice = rotation.selectAccountForEntry(laneAccounts);
  if ("error" in choice) {
    pushEvent("warn", `Entry skipped: ${choice.error}`, group);
    return { message: choice.error };
  }
  const acct = choice.account;

  // Instant, in-memory profit-target guard: if the last-known balance for this
  // account is already at/over target, retire it (no browser read) and try the
  // next one. Keeps a passed account from ever taking a fresh trade.
  const known = balanceLog.get(acct.tradovateLabel);
  if (usesEvaluationTarget(group) && known != null && known >= store.evalTarget) {
    store.markPassed(acct.tradovateLabel);
    pushEvent("info", `🏆 ${acct.name} is already at the ${money(store.evalTarget)} target — retired from rotation. Trying the next account.`, group);
    return handleEntry(group, order, lane, options); // that account is now excluded; pick the next
  }

  const timingMs = await executeEntry(acct.tradovateLabel, acct.name, order, group, options);
  rotation.recordOpen(acct, order, known ?? undefined);
  positionReconciler.clear(lane.key);
  pendingBrokerClose.delete(lane.key);
  brokerLaneStatus.set(lane.key, {
    state: store.mode === "practice" ? "SIMULATED" : "AWAITING BROKER",
    flatReads: 0,
    unknownReads: 0,
  });
  return { message: `Opened ${order.action} ${order.symbol} on ${acct.name}`, ...(timingMs ? { timingMs } : {}) };
}

async function handleClose(group: Group, symbol: string, lane = primaryLane(group)): Promise<string> {
  const rotation = ensureLaneRotation(lane);
  if (rotation.isFlat) {
    pushEvent("warn", "A close alert arrived but no trade is open — ignoring it.", group);
    return "No open trade to close.";
  }
  const open = rotation.getState().openTrade!;
  const fingerprint = tradeFingerprint(open);

  if (store.mode === "practice") {
    await executeClose(open.tradovateLabel, open.accountName, symbol, group, lane);
    return (await completeRecordedTrade(lane, fingerprint, { source: "practice close webhook" }))
      ?? "The simulated trade was already completed.";
  }

  const loginId = open.loginId ?? store.find(open.tradovateLabel)?.loginId ?? lane.credentialId;
  const worker = sessions.get(loginId);
  if (!worker) throw new Error(`The open trade on ${open.accountName} references a missing login.`);

  const position = await worker.readLanePosition(group, open.tradovateLabel).catch((error) => ({
    status: "unknown" as const,
    reason: error instanceof Error ? error.message : String(error),
    checkedAt: new Date().toISOString(),
  }));
  const observation = observeBrokerPosition(lane, open, position);
  if (observation.kind === "confirmed-flat") {
    return (await completeRecordedTrade(lane, fingerprint, { source: "broker was already flat when the close webhook arrived" }))
      ?? "The broker-flat trade was already reconciled.";
  }

  const action = decideCloseAction(position, pendingBrokerClose.has(lane.key));
  if (action === "already-requested") return `Exit was already requested on ${open.accountName}; waiting for broker POSITION 0.`;
  if (action === "wait-for-confirmation") {
    return position.status === "unknown"
      ? `Close received, but ${open.accountName}'s broker position is UNKNOWN. No flat state was assumed; ATLAS will retry.`
      : `Close received and broker shows POSITION 0 once on ${open.accountName}; confirming once more before rotating.`;
  }

  pendingBrokerClose.set(lane.key, {
    requestedAt: new Date().toISOString(),
    reason: "close webhook requested exit",
  });
  try {
    await executeClose(open.tradovateLabel, open.accountName, symbol, group, lane);
  } catch (error) {
    pendingBrokerClose.delete(lane.key);
    throw error;
  }
  return `Exit requested on ${open.accountName}; waiting for broker POSITION 0 before completing and rotating.`;
}

/**
 * Cut an open trade WITHOUT a webhook (the profit-target auto-close) and retire
 * the account. Assumes the trade's account is already the selected one (the
 * monitor only calls this for the selected account), so the exit is a pure
 * click. Must be called from inside `enqueue`.
 */
async function forceClose(group: Group, reason: string, lane = primaryLane(group)): Promise<void> {
  const rotation = ensureLaneRotation(lane);
  const open = rotation.getState().openTrade;
  if (!open) return;
  if (pendingBrokerClose.has(lane.key)) return;
  pushEvent("warn", `${open.accountName} hit the target — requesting an automatic exit (${reason}).`, group);
  const loginId = open.loginId ?? store.find(open.tradovateLabel)?.loginId;
  const worker = loginId ? sessions.get(loginId) : undefined;
  if (!worker) throw new Error(`The open trade on ${open.accountName} references a missing login.`);
  pendingBrokerClose.set(lane.key, {
    requestedAt: new Date().toISOString(),
    reason: `target exit: ${reason}`,
    won: true,
    retire: true,
  });
  try {
    await worker.close(group, open.tradovateLabel);
  } catch (error) {
    pendingBrokerClose.delete(lane.key);
    throw error;
  }
}

/**
 * The monitor's per-tick work: read ONLY the selected account's balance (the
 * open trade's account is the selected one), log it, and cut at the target.
 * Never switches accounts. No-op unless live + logged in + a trade is open on
 * the currently-selected account.
 */
async function monitorTick(): Promise<void> {
  if (store.mode !== "live") return;
  await Promise.allSettled(currentLanes().map((lane) => dispatcher.enqueue(lane.key, async () => {
    const group = lane.stage;
    const open = ensureLaneRotation(lane).getState().openTrade;
    if (!open) return;
    const loginId = open.loginId ?? store.find(open.tradovateLabel)?.loginId;
    const worker = loginId ? sessions.get(loginId) : undefined;
    if (!worker?.status().loggedIn) return;

    const position = await worker.readLanePosition(group, open.tradovateLabel).catch((error) => ({
      status: "unknown" as const,
      reason: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    }));
    const observation = observeBrokerPosition(lane, open, position);
    if (observation.kind === "confirmed-flat") {
      const pending = pendingBrokerClose.get(lane.key);
      await completeRecordedTrade(lane, tradeFingerprint(open), {
        source: pending?.reason ?? "ATM, liquidation, or external broker exit detected",
        won: pending?.won,
        retire: pending?.retire,
      });
      return;
    }
    if (position.status !== "open") return;

    const equity = await worker.readLaneEquity(group, open.tradovateLabel).catch((error) => {
      pushEvent("error", `${open.accountName} could not be verified for balance monitoring: ${(error as Error).message}`, group);
      return null;
    });
    if (equity == null) return;
    balanceLog.set(open.tradovateLabel, equity);
    if (usesEvaluationTarget(group) && equity >= store.evalTarget) {
      await forceClose(group, `balance reached ${money(equity)}`, lane);
    }
  })));
}

const monitor = new Monitor(monitorTick, {
  activeMs: config.monitorActiveSeconds * 1_000,
  isActive: () => currentLanes().some((lane) => !ensureLaneRotation(lane).isFlat),
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
    for (const worker of sessions.values()) {
      if (!worker.status().connected) continue;
      void healthCheck(worker).catch(() => {});
    }
  }, 45_000);
}

async function healthCheck(worker: LoginWorker): Promise<void> {
  if (!worker.status().connected) return;
  // Is the trading screen actually there? (Buy/Sell only exist when logged in.)
  const onTrader = await worker.refreshLoginState(4_000);
  if (onTrader) {
    await worker.dismissPopups().catch(() => {});
    return;
  }
  // The trading screen is gone — logged out, timed out, or navigated away.
  const anyTradeOpen = hasOpenTradeForLogin(worker.definition.id);
  if (anyTradeOpen) {
    // Do not reload under an open trade. The bounded click-only path can still
    // press Login / Continue / Access Simulation on the page already shown.
    pushEvent("warn", "Tradovate left the trading screen during an open trade — trying click-only login recovery without reloading…");
    const status = await worker.resumeExistingLogin().catch(() => null);
    if (status?.loggedIn) {
      pushEvent("info", "Recovered the Tradovate login during the open trade; resuming broker POSITION checks.");
      void monitorTick();
      return;
    }
    pushEvent("error", "Tradovate could not be recovered automatically while the trade is open.");
    notifyActionNeeded("Tradovate logged out / left the trading screen WHILE A TRADE IS OPEN and ATLAS could not complete the safe click-only login. Check the bot computer and Tradovate right away.");
    return;
  }
  // Flat — safe to try fixing it ourselves.
  pushEvent("warn", "Tradovate isn't on the trading screen — trying to log back in automatically…");
  const status = await worker.recover().catch(() => null);
  if (status?.loggedIn) {
    pushEvent("info", "Recovered — Tradovate is logged back in.");
    await armLogin(worker.definition.id);
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

app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "ATLAS",
  mode: store.mode,
  running: store.running,
  credentials: store.logins.length,
  accounts: store.accounts.length,
}));

async function handleWebhookGroup(group: Group, alert: Alert): Promise<WebhookHandleResult> {
  return handleWebhookLane(primaryLane(group), alert, { skipFundedWindow: false });
}

async function handleWebhookLane(
  lane: CredentialLane,
  alert: Alert,
  options: { skipFundedWindow: boolean },
): Promise<WebhookHandleResult> {
  const group = lane.stage;
  lastAlertGroup = group;
  const received = Date.now();
  const result = isCloseAlert(alert)
    ? { message: await handleClose(group, alert.symbol, lane) }
    : await handleEntry(group, {
      action: alert.action === "sell" ? "sell" : "buy",
      symbol: alert.symbol,
      tradeId: alert.tradeId,
      quantity: alert.quantity,
    }, lane, options);
  const totalMs = Date.now() - received;
  const clickMs = result.timingMs?.totalMs;
  pushEvent("info", `Handled ${lane.key} in ${totalMs}ms${clickMs != null ? ` (prepared entry path ${clickMs}ms)` : ""}.`, group);
  return result;
}

registerWebhookRoutes(app, {
  webhookSecret: config.webhookSecret,
  isRunning: () => store.running,
  dispatcher,
  lanes: currentLanes,
  handleLane: handleWebhookLane,
  cancelPendingLane: (lane) => sessions.get(lane.credentialId)?.cancelPendingEntry(lane.stage),
  pushEvent,
  notifyActionNeeded,
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
      toTarget: a.group === "evals" && balance != null ? Math.max(0, store.evalTarget - balance) : null,
      restingToday: laneRotations.get(laneKey(a.loginId, a.group))?.isBenchedToday(a.tradovateLabel) ?? false,
      brokerPosition: brokerAccountStatus.get(brokerAccountKey(a.loginId, a.tradovateLabel)) ?? null,
    };
  };
  const groups: Record<string, unknown> = {};
  for (const group of GROUPS) {
    const rotation = rotations[group];
    const state = rotation.getState();
    const nextAccount = rotation.peekNext(accountsForLane(primaryLane(group)));
    const nextWorker = nextAccount ? sessions.get(nextAccount.loginId) : undefined;
    groups[group] = {
      webhookPath: `/webhook/${group}`,
      accounts: accountsForLane(primaryLane(group), true).map(decorate),
      next: nextAccount?.name ?? null,
      loginId: nextAccount?.loginId ?? null,
      loginName: nextWorker?.definition.name ?? null,
      ready: nextAccount ? nextWorker?.isReady(group, nextAccount) === true : false,
      readinessError: readinessErrors.get(primaryLane(group).key) ?? null,
      openTrade: state.openTrade,
      brokerPosition: brokerLaneStatus.get(primaryLane(group).key) ?? {
        state: state.openTrade ? (store.mode === "practice" ? "SIMULATED" : "AWAITING BROKER") : "FLAT",
        flatReads: 0,
        unknownReads: 0,
      },
      tradesToday: rotation.tradesToday(),
      log: rotation.todaysHistory(),
    };
  }
  const credentials = sessions.values().map((worker) => ({
    ...worker.definition,
    status: worker.status(),
    webhookPath: `/webhook/${worker.definition.id}`,
    lanes: currentLanes()
      .filter((lane) => lane.credentialId === worker.definition.id)
      .map((lane) => {
        const rotation = ensureLaneRotation(lane);
        const state = rotation.getState();
        const nextAccount = rotation.peekNext(accountsForLane(lane));
        return {
          key: lane.key,
          stage: lane.stage,
          webhookPath: lane.webhookPath,
          globalWebhookPath: lane.globalWebhookPath,
          accounts: accountsForLane(lane, true).map(decorate),
          next: nextAccount?.name ?? null,
          nextLabel: nextAccount?.tradovateLabel ?? null,
          ready: nextAccount ? worker.isReady(lane.stage, nextAccount) : false,
          readiness: worker.status().readyByStage?.[lane.stage] ?? null,
          executionMode: worker.status().executionMode,
          capabilityReason: worker.status().capabilityReason ?? null,
          queue: worker.status().queue,
          readinessError: readinessErrors.get(lane.key) ?? null,
          openTrade: state.openTrade,
          brokerPosition: brokerLaneStatus.get(lane.key) ?? {
            state: state.openTrade ? (store.mode === "practice" ? "SIMULATED" : "AWAITING BROKER") : "FLAT",
            flatReads: 0,
            unknownReads: 0,
          },
          tradesToday: rotation.tradesToday(),
          log: rotation.todaysHistory(),
        };
      }),
  }));
  res.json({
    ok: true,
    running: store.running,
    mode: store.mode,
    evalTarget: store.evalTarget,
    browser: {
      connected: sessions.values().some((worker) => worker.status().connected),
      loggedIn: sessions.values().some((worker) => worker.status().loggedIn),
    },
    logins: sessions.values().map((worker) => ({
      ...worker.definition,
      status: worker.status(),
      accountCount: store.accounts.filter((account) => account.loginId === worker.definition.id).length,
    })),
    broadcastWebhookPath: "/webhook",
    globalWebhookPaths: { all: "/webhook", evals: "/webhook/evals", funded: "/webhook/funded" },
    publicWebhookBaseUrl: config.publicWebhookBaseUrl,
    tunnel: tunnelStatus(),
    groups,
    credentials,
    passed: store.passedAccounts().map(decorate),
    events: listEvents(60),
  });
});

api.post("/running", (req, res) => {
  const running = req.body?.running === true;
  store.setRunning(running);
  pushEvent("info", running ? "ATLAS STARTED — alerts will be handled." : "ATLAS PAUSED — alerts will be ignored.");
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
  if (mode === "live") void armAll();
  return res.json({ ok: true, mode });
});

registerAccountMutationRoutes(api, { store, hasOpenTradeForAccount, armNext: armStageAll, pushEvent });
registerLoginRoutes(api, {
  store,
  manager: sessions,
  hasOpenTradeForLogin,
  hasOpenTradeForAccount,
  armLogin,
  reconcileLogin: async () => { await monitorTick(); },
  armNext: armStageAll,
  pushEvent,
});

function flattenTarget(account: StoredAccount): FlattenTarget {
  const lane = currentLanes().find((candidate) =>
    candidate.credentialId === account.loginId && candidate.stage === account.group);
  const recorded = lane ? ensureLaneRotation(lane).getState().openTrade : undefined;
  return {
    loginId: account.loginId,
    group: account.group,
    label: account.tradovateLabel,
    name: account.name,
    recordedOpen: recorded?.tradovateLabel === account.tradovateLabel,
  };
}

async function runFlatten(targets: readonly FlattenTarget[]) {
  return flattenPositions(targets, {
    cancelPending: (target) => {
      sessions.get(target.loginId)?.cancelPendingEntry(target.group);
    },
    readPosition: async (target) => {
      const worker = sessions.get(target.loginId);
      if (!worker) {
        return rememberBrokerPosition(target.loginId, target.label, {
          status: "unknown",
          reason: `The saved Tradovate login ${target.loginId} is unavailable.`,
          checkedAt: new Date().toISOString(),
        });
      }
      if (!worker.status().loggedIn) {
        return rememberBrokerPosition(target.loginId, target.label, {
          status: "unknown",
          reason: `${worker.definition.name} is not connected and logged in.`,
          checkedAt: new Date().toISOString(),
        });
      }
      const position = await worker.readLanePosition(target.group, target.label);
      return rememberBrokerPosition(target.loginId, target.label, position);
    },
    requestExit: async (target) => {
      const worker = sessions.get(target.loginId);
      if (!worker?.status().loggedIn) throw new Error(`${target.name}'s Tradovate login is not connected and logged in.`);
      const lane = currentLanes().find((candidate) =>
        candidate.credentialId === target.loginId && candidate.stage === target.group);
      const open = lane ? ensureLaneRotation(lane).getState().openTrade : undefined;
      const ownsRecordedTrade = open?.tradovateLabel === target.label;
      if (lane && ownsRecordedTrade) {
        pendingBrokerClose.set(lane.key, {
          requestedAt: new Date().toISOString(),
          reason: "manual flatten control requested exit",
        });
      }
      try {
        await worker.close(target.group, target.label);
      } catch (error) {
        if (lane && ownsRecordedTrade) pendingBrokerClose.delete(lane.key);
        throw error;
      }
      pushEvent(
        "warn",
        `Manual flatten requested Exit at Mkt & Cxl on ${target.name} (${target.label}); waiting for two broker-flat confirmations.`,
        target.group,
      );
    },
    confirmedFlat: async (target) => {
      rememberBrokerPosition(target.loginId, target.label, {
        status: "flat",
        checkedAt: new Date().toISOString(),
      });
      const lane = currentLanes().find((candidate) =>
        candidate.credentialId === target.loginId && candidate.stage === target.group);
      const open = lane ? ensureLaneRotation(lane).getState().openTrade : undefined;
      if (lane && open?.tradovateLabel === target.label) {
        await completeRecordedTrade(lane, tradeFingerprint(open), { source: "manual flatten control" });
      } else {
        pushEvent("info", `Broker confirmed ${target.name} (${target.label}) is flat.`, target.group);
      }
    },
  });
}

registerFlattenRoutes(api, {
  getRunning: () => store.running,
  flattenAll: () => runFlatten(store.accounts.map(flattenTarget)),
  flattenOne: async ({ loginId, group, label }) => {
    const account = store.accounts.find((candidate) =>
      candidate.loginId === loginId && candidate.group === group && candidate.tradovateLabel === label);
    if (!account) throw new Error(`Account ${label} is not assigned to this Tradovate login and lane.`);
    const [result] = await runFlatten([flattenTarget(account)]);
    if (!result) throw new Error(`Account ${label} could not be inspected.`);
    return result;
  },
});

function requestedWorker(loginId: unknown): LoginWorker | undefined {
  if (typeof loginId === "string" && loginId.trim()) return sessions.get(loginId.trim());
  return sessions.values()[0];
}

/** Read-only calibration/status probe for Tradovate's dedicated POSITION field.
 * It verifies the requested account and never places, exits, or modifies an order. */
api.post("/browser/position", async (req, res) => {
  const group = req.body?.group;
  if (typeof group !== "string" || !isGroup(group)) {
    return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
  }
  const worker = requestedWorker(req.body?.loginId);
  if (!worker?.status().loggedIn) {
    return res.status(409).json({ ok: false, error: "Connect this Tradovate login before checking broker position." });
  }
  const lane = laneFor(worker.definition.id, group);
  const rotation = ensureLaneRotation(lane);
  const open = rotation.getState().openTrade;
  const requestedLabel = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  const next = rotation.peekNext(accountsForLane(lane));
  const label = requestedLabel || open?.tradovateLabel || next?.tradovateLabel || "";
  if (!label) return res.status(400).json({ ok: false, error: "No account is available for this position check." });

  const otherOpen = currentLanes()
    .map((candidate) => ensureLaneRotation(candidate).getState().openTrade)
    .find((candidate) => candidate && (candidate.loginId ?? store.find(candidate.tradovateLabel)?.loginId) === worker.definition.id);
  if (otherOpen && otherOpen.tradovateLabel !== label) {
    return res.status(409).json({
      ok: false,
      error: `This login owns a recorded trade on ${otherOpen.accountName}; only that account may be checked until it is broker-flat.`,
    });
  }

  const position = rememberBrokerPosition(
    worker.definition.id,
    label,
    await worker.readLanePosition(group, label),
  );
  pushEvent(
    position.status === "unknown" ? "warn" : "info",
    `No-order broker check for ${label}: ${brokerStatusLabel(position)}${position.status === "unknown" ? ` (${position.reason})` : ""}.`,
    group,
  );
  return res.json({ ok: true, placedOrder: false, loginId: worker.definition.id, group, label, position });
});

api.post("/accounts/atm-preset", (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  const preset = typeof req.body?.preset === "string" ? req.body.preset : "";
  if (hasOpenTradeForAccount(label)) {
    return res.status(409).json({ ok: false, error: "This account has an open trade. Its ATM preset cannot change until the trade is closed." });
  }
  const ok = store.setAtmPreset(label, preset);
  if (ok) {
    const acct = store.find(label);
    pushEvent(
      "info",
      preset.trim()
        ? `${acct?.name ?? label} will use ATM preset "${preset.trim()}".`
        : `${acct?.name ?? label} ATM preset cleared (uses whatever's on the Tradovate ticket).`,
    );
    if (acct) armLane(laneFor(acct.loginId, acct.group), { force: true });
  }
  res.json({ ok });
});

/** Calibration/test: select an ATM preset by name now, no order placed. */
api.post("/test-preset", async (req, res) => {
  const preset = typeof req.body?.preset === "string" ? req.body.preset.trim() : "";
  if (!preset) return res.json({ ok: true, set: false, message: "Type the ATM preset name to test." });
  const worker = requestedWorker(req.body?.loginId);
  if (!worker?.status().loggedIn) {
    return res.json({ ok: true, set: false, message: "Connect the browser and log into Tradovate first." });
  }
  const started = Date.now();
  try {
    await worker.testAtmPreset(preset);
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
  const credentialId = typeof req.body?.credentialId === "string" ? req.body.credentialId : PRIMARY_LOGIN_ID;
  const lane = laneFor(credentialId, group);
  const ok = ensureLaneRotation(lane).clearRest(label);
  if (ok) {
    pushEvent("info", `${store.find(label)?.name ?? label} taken off rest — it can trade again today.`, group);
    armLane(lane);
  }
  res.json({ ok });
});

api.post("/next", (req, res) => {
  const group = req.body?.group;
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  if (typeof group !== "string" || !isGroup(group)) {
    return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
  }
  const credentialId = typeof req.body?.credentialId === "string" ? req.body.credentialId : PRIMARY_LOGIN_ID;
  const lane = laneFor(credentialId, group);
  const rotation = ensureLaneRotation(lane);
  if (!rotation.isFlat) {
    return res.status(400).json({ ok: false, error: "There's an open trade — the next account is chosen automatically when it closes." });
  }
  const ok = rotation.setNext(label, accountsForLane(lane));
  if (ok) {
    pushEvent("info", `Next ${group} trade will go to ${store.find(label)?.name ?? label}.`, group);
    armLane(lane, { force: true });
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
  const credentialId = typeof req.body?.credentialId === "string" ? req.body.credentialId : PRIMARY_LOGIN_ID;
  const lane = laneFor(credentialId, group);
  const rotation = ensureLaneRotation(lane);
  const { was, next } = rotation.resetOpenTrade(accountsForLane(lane));
  if (was) {
    const worker = sessions.get(was.loginId ?? store.find(was.tradovateLabel)?.loginId ?? "");
    worker?.clearOpenTrade(was.tradovateLabel);
  }
  positionReconciler.clear(lane.key);
  pendingBrokerClose.delete(lane.key);
  brokerLaneStatus.set(lane.key, { state: "MANUALLY RESET", flatReads: 0, unknownReads: 0 });
  const nextMsg = next ? `Next up: ${next.name}.` : "No accounts left in this group.";
  pushEvent(
    "warn",
    `Manually reset — marked ${was ? was.accountName : "this lane"} as closed (no order placed). ${nextMsg}`,
    group,
  );
  armLane(lane); // sit on the next account, ready to click
  res.json({ ok: true, next: next?.name ?? null });
});

/** Speed test: fire a real buy-then-close at our own webhook and time each leg. */
api.post("/speedtest", async (req, res) => {
  const group = req.body?.group;
  if (typeof group !== "string" || !isGroup(group)) {
    return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
  }
  if (!store.running) return res.status(400).json({ ok: false, error: "ATLAS is paused — press Start first." });
  if (store.mode === "live" && req.body?.confirmLive !== true) {
    return res.status(400).json({ ok: false, error: "LIVE speed test needs confirmation (it places a real order)." });
  }
  const credentialId = typeof req.body?.credentialId === "string" ? req.body.credentialId : PRIMARY_LOGIN_ID;
  const lane = laneFor(credentialId, group);
  const rotation = ensureLaneRotation(lane);
  if (!rotation.isFlat) return res.status(400).json({ ok: false, error: "A trade is open in this group — try after it closes." });

  // The test is a normal round-trip: it advances the rotation and arms the next
  // account exactly like a real trade, so it never does an extra back-and-forth
  // switch in the browser.
  const base = `http://localhost:${config.port}`;
  const fire = async (payload: Record<string, unknown>) => {
    const started = Date.now();
    try {
      const r = await fetch(`${base}${lane.webhookPath}`, {
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
  const worker = requestedWorker(req.body?.loginId);
  if (!worker?.status().loggedIn) {
    return res.json({ ok: true, set: false, message: "Connect the browser and log into Tradovate first." });
  }
  const started = Date.now();
  try {
    await worker.testQuantity(qty);
    const ms = Date.now() - started;
    pushEvent("info", `🔢 Set order size to ${qty} in ${ms}ms (test only — no order placed).`);
    res.json({ ok: true, set: true, ms, quantity: qty });
  } catch (err) {
    const fields = await worker.inspectFields().catch(() => []);
    pushEvent("warn", `Size test couldn't find the size box — showing the ${fields.length} fields it can see for calibration.`);
    res.json({ ok: true, set: false, quantity: qty, message: (err as Error).message, fields });
  }
});

/** No-order concurrency check: edits both already-prepared quantity fields in parallel. */
api.post("/tests/simultaneous", async (req, res) => {
  const { evalCredentialId, fundedCredentialId } = resolveReadinessCredentialIds(req.body, PRIMARY_LOGIN_ID);
  const evalWorker = sessions.get(evalCredentialId);
  const fundedWorker = sessions.get(fundedCredentialId);
  if (!evalWorker) {
    return res.status(400).json({ ok: false, placedTrade: false, error: "The selected Evaluation login no longer exists." });
  }
  if (!fundedWorker) {
    return res.status(400).json({ ok: false, placedTrade: false, error: "The selected Funded login no longer exists." });
  }
  const evalLane = laneFor(evalCredentialId, "evals");
  const fundedLane = laneFor(fundedCredentialId, "funded");
  const evalAccount = ensureLaneRotation(evalLane).peekNext(accountsForLane(evalLane));
  const fundedAccount = ensureLaneRotation(fundedLane).peekNext(accountsForLane(fundedLane));
  if (!evalAccount) {
    return res.status(400).json({ ok: false, placedTrade: false, error: "The selected Evaluation login has no next Evaluation account. Scan or add an account to its Evaluation lane first." });
  }
  if (!fundedAccount) {
    return res.status(400).json({ ok: false, placedTrade: false, error: "The selected Funded login has no next Funded account. Scan or add an account to its Funded lane first." });
  }
  const evalQuantity = Math.max(1, Math.floor(Number(req.body?.evalQuantity) || 1));
  const fundedQuantity = Math.max(1, Math.floor(Number(req.body?.fundedQuantity) || 1));
  try {
    const result = await runSimultaneousReadinessTest({ evalAccount, fundedAccount, evalWorker, fundedWorker, evalQuantity, fundedQuantity });
    pushEvent(result.ok ? "info" : "warn", `No-order simultaneous readiness test finished in ${result.totalMs}ms. No trade was placed.`);
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    return res.status(409).json({ ok: false, placedTrade: false, error: error instanceof Error ? error.message : String(error) });
  }
});

api.post("/browser/connect", async (req, res) => {
  const worker = requestedWorker(req.body?.loginId);
  if (!worker) return res.status(404).json({ ok: false, error: "Unknown login" });
  try {
    const status = await worker.connect();
    pushEvent(
      status.loggedIn ? "info" : "warn",
      status.loggedIn
        ? "Tradovate browser connected and logged in."
        : "Browser opened, but not logged in yet — finish the login in the browser window on the bot PC.",
    );
    if (status.loggedIn) {
      if (hasOpenTradeForLogin(worker.definition.id)) void monitorTick();
      else await armLogin(worker.definition.id);
    }
    res.json({ ok: true, browser: status });
  } catch (err) {
    pushEvent("error", `Could not open the Tradovate browser: ${(err as Error).message}`);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

api.post("/browser/disconnect", async (req, res) => {
  const worker = requestedWorker(req.body?.loginId);
  if (!worker) return res.status(404).json({ ok: false, error: "Unknown login" });
  await worker.disconnect();
  pushEvent("info", "Tradovate browser closed.");
  res.json({ ok: true });
});

api.post("/scan", async (req, res) => {
  const worker = requestedWorker(req.body?.loginId);
  if (!worker) return res.status(404).json({ ok: false, error: "Unknown login" });
  try {
    const labels = await worker.discoverAccounts();
    pushEvent("info", `Scanned Tradovate: found ${labels.length} account(s).`);
    res.json({ ok: true, labels, loginId: worker.definition.id });
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
    pushEvent("info", `ATLAS server started. Mode: ${store.mode.toUpperCase()}. Open the dashboard to manage it.`);
    autoStartTunnel();
    monitor.start(); // watches the broker POSITION and balance for every recorded open trade
    startHealthWatch(); // clears popups + catches/recovers a lost Tradovate login

    // Restore persisted trade intent, then let the broker POSITION decide. A
    // restart is not itself an action-needed alert and never requires a reset.
    for (const lane of currentLanes()) {
      const open = ensureLaneRotation(lane).getState().openTrade;
      if (open) {
        brokerLaneStatus.set(lane.key, { state: "AWAITING BROKER", flatReads: 0, unknownReads: 0 });
        pushEvent(
          "info",
          `Restored the recorded trade on ${open.accountName} (${open.symbol}); reconnecting Tradovate to verify its actual POSITION.`,
          lane.stage,
        );
      }
    }

    // Self-healing: connect the Tradovate browser without a human click. The
    // saved session usually means it comes back logged in silently; only a real
    // login requirement (2FA) or a failure is worth a phone buzz.
    if (config.autoConnect) {
      for (const worker of sessions.values().filter((candidate) => candidate.definition.autoConnect)) {
        const ownsRecordedTrade = hasOpenTradeForLogin(worker.definition.id);
        void worker.connect()
          .then(async (status) => {
            if (status.loggedIn) {
              pushEvent("info", `${worker.definition.name} connected and logged in automatically.`);
              if (connectedLoginNextStep(ownsRecordedTrade) === "reconcile") {
                pushEvent("info", `${worker.definition.name} is verifying its restored trade against the broker POSITION field.`);
                void monitorTick();
              } else {
                await armLogin(worker.definition.id);
              }
            } else {
              pushEvent("warn", `${worker.definition.name} opened but needs a manual Tradovate login.`);
              notifyActionNeeded(`${worker.definition.name} needs you to log in on the bot computer. Trades assigned to it won't fire until you do.`);
            }
          })
          .catch((err: unknown) => {
            pushEvent("error", `Automatic connect failed for ${worker.definition.name}: ${(err as Error).message}`);
            notifyActionNeeded(`I couldn't open ${worker.definition.name} on startup. Please check the bot computer. (${(err as Error).message})`);
          });
      }
    }
  });
}

const shutdown = async () => {
  log.info("Shutting down…");
  monitor.stop();
  if (healthTimer) clearInterval(healthTimer);
  await disconnectTunnel().catch(() => {});
  await sessions.disconnectAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  log.error("Fatal startup error:", err);
  process.exit(1);
});
