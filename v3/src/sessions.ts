import { resolve } from "node:path";
import { TradovateBrowser } from "./browser.js";
import type { Config } from "./config.js";
import { prepareNextAccount, type ArmingCallbacks } from "./arming.js";
import type { BrokerPosition } from "./brokerPosition.js";
import type { Group, OrderRequest, SavedLogin, StoredAccount } from "./types.js";
import { CredentialPriorityScheduler, type CredentialTaskKind, type SchedulerSnapshot } from "./priorityScheduler.js";
import type { TicketCapabilities, TicketExecutionMode } from "./ticketCapabilities.js";

export interface AdapterStatus {
  connected: boolean;
  loggedIn: boolean;
  selectedAccount: string | null;
}

/** Broker-window boundary. Tradovate is the only implementation in this release. */
export interface TradingSessionAdapter {
  readonly selectedAccount: string | null;
  status(): AdapterStatus;
  connect(): Promise<unknown>;
  recover(): Promise<unknown>;
  resumeExistingLogin?(): Promise<unknown>;
  disconnect(): Promise<void>;
  discoverAccounts(): Promise<string[]>;
  armFor(label: string): Promise<void>;
  readSelectedEquity(): Promise<number | null>;
  readSelectedPosition(): Promise<BrokerPosition>;
  diagnosePosition?(): Promise<{ position: BrokerPosition; nearby: Array<Record<string, string>> }>;
  selectAtmPreset(name: string): Promise<void>;
  setQuantity(quantity: number, force?: boolean): Promise<void>;
  clickOrder(action: "buy" | "sell", label: string): Promise<void>;
  clickExit(label: string): Promise<void>;
  readSettledEquity(): Promise<number | null>;
  dismissPopups(): Promise<boolean>;
  refreshLoginState(timeout?: number): Promise<boolean>;
  inspectFields?(): Promise<Array<Record<string, string>>>;
  verifyActiveAccount?(label: string): Promise<boolean>;
  inspectCapabilities?(): Promise<TicketCapabilities>;
  armForLane?(group: Group, label: string): Promise<void>;
  readLaneEquity?(group: Group): Promise<number | null>;
  readLanePosition?(group: Group): Promise<BrokerPosition>;
  selectLaneAtmPreset?(group: Group, name: string): Promise<void>;
  setLaneQuantity?(group: Group, quantity: number): Promise<void>;
  clickLaneOrder?(group: Group, action: "buy" | "sell", label: string): Promise<void>;
  clickLaneExit?(group: Group, label: string): Promise<void>;
  verifyLaneAccount?(group: Group, label: string): Promise<boolean>;
  /** Fresh broker-DOM verification performed immediately before an entry. */
  verifyPreparedOrderState(group: Group, label: string, atmPreset: string, quantity?: number): Promise<boolean>;
  /** Rebuild the live ticket after a person or the broker changes prepared state. */
  repairPreparedOrderState(group: Group, label: string, atmPreset: string, quantity?: number): Promise<void>;
  /** Fresh broker-DOM account verification performed immediately before Exit. */
  verifyExitState(group: Group, label: string): Promise<boolean>;
}

export interface ReadySignature {
  group: Group;
  accountLabel: string;
  atmPreset: string;
  preparedAt: string;
}

export interface SessionStatus extends AdapterStatus {
  loginId: string;
  busy: boolean;
  pending: number;
  ready?: ReadySignature;
  readyByStage?: Partial<Record<Group, ReadySignature & { physical: boolean }>>;
  executionMode: TicketExecutionMode;
  capabilityReason?: string;
  queue: SchedulerSnapshot;
  lastError?: string;
}

export interface EntryTiming {
  queueWaitMs: number;
  executionMs: number;
  totalMs: number;
}

interface PlannedLane {
  account: StoredAccount;
  callbacks: ArmingCallbacks;
  signature: ReadySignature;
}

/** One authenticated context, two logical lanes, and one priority scheduler. */
export class CredentialWorker {
  private readonly scheduler: CredentialPriorityScheduler;
  private busy = false;
  private pending = 0;
  private readonly desired = new Map<Group, PlannedLane>();
  private readonly ready = new Map<Group, ReadySignature>();
  private lastError: string | undefined;
  private readonly openTrades = new Map<Group, string>();
  private readonly entryGeneration = new Map<Group, number>();
  private executionMode: TicketExecutionMode = "sequential";
  private capabilityReason = "Dual-ticket capability has not been proven; using the safe sequential fallback.";
  private capabilityInspection: Promise<void> | undefined;

  constructor(
    readonly definition: SavedLogin,
    private readonly adapter: TradingSessionAdapter,
    options: { fundedPriorityWindowMs?: number } = {},
  ) {
    this.scheduler = new CredentialPriorityScheduler({ fundedWindowMs: options.fundedPriorityWindowMs });
  }

  status(): SessionStatus {
    const readyByStage: Partial<Record<Group, ReadySignature & { physical: boolean }>> = {};
    for (const [group, plan] of this.desired) {
      readyByStage[group] = { ...plan.signature, physical: this.ready.has(group) };
    }
    const legacyReady = this.ready.values().next().value as ReadySignature | undefined;
    return {
      ...this.adapter.status(),
      loginId: this.definition.id,
      busy: this.busy,
      pending: this.pending,
      ...(legacyReady ? { ready: { ...legacyReady } } : {}),
      ...(Object.keys(readyByStage).length ? { readyByStage } : {}),
      executionMode: this.executionMode,
      capabilityReason: this.capabilityReason,
      queue: this.scheduler.snapshot(),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  isReady(group: Group, account: StoredAccount): boolean {
    const status = this.adapter.status();
    return status.connected
      && status.loggedIn
      && this.ready.get(group)?.accountLabel === account.tradovateLabel
      && this.ready.get(group)?.atmPreset === account.atmPreset
      && (this.executionMode === "dual-ticket" || status.selectedAccount === account.tradovateLabel);
  }

  invalidateReady(group?: Group): void {
    if (group) {
      this.ready.delete(group);
      this.desired.delete(group);
    } else {
      this.ready.clear();
      this.desired.clear();
    }
  }

  private async ensureCapabilities(): Promise<void> {
    if (this.capabilityInspection) return this.capabilityInspection;
    this.capabilityInspection = (async () => {
      if (!this.adapter.inspectCapabilities) return;
      const result = await this.adapter.inspectCapabilities();
      const hasScopedOperations = Boolean(
        this.adapter.armForLane
        && this.adapter.readLaneEquity
        && this.adapter.readLanePosition
        && this.adapter.selectLaneAtmPreset
        && this.adapter.setLaneQuantity
        && this.adapter.clickLaneOrder
        && this.adapter.clickLaneExit
        && this.adapter.verifyLaneAccount,
      );
      this.executionMode = result.mode === "dual-ticket" && hasScopedOperations ? "dual-ticket" : "sequential";
      this.capabilityReason = result.mode === "dual-ticket" && !hasScopedOperations
        ? "The ticket probe passed but the browser adapter lacks complete lane-scoped operations."
        : result.reason;
    })().catch((error) => {
      this.executionMode = "sequential";
      this.capabilityReason = `Ticket capability probe failed: ${error instanceof Error ? error.message : String(error)}`;
    });
    return this.capabilityInspection;
  }

  private enqueue<T>(kind: CredentialTaskKind, task: () => Promise<T>, options: { skipFundedWindow?: boolean } = {}): Promise<T> {
    this.pending++;
    const execute = async () => {
      this.busy = true;
      try {
        const result = await task();
        this.lastError = undefined;
        return result;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.busy = false;
        this.pending--;
      }
    };
    return this.scheduler.enqueue(kind, execute, options);
  }

  runMaintenance<T>(task: () => Promise<T>, group?: Group): Promise<T> {
    const kind: CredentialTaskKind = group === "funded"
      ? "funded-maintenance"
      : group === "evals" ? "eval-maintenance" : "diagnostic";
    return this.enqueue(kind, task);
  }

  private async preparePhysical(group: Group, account: StoredAccount, callbacks: ArmingCallbacks): Promise<void> {
    let presetError: Error | undefined;
    if (this.executionMode === "dual-ticket") {
      await this.adapter.armForLane!(group, account.tradovateLabel);
      const balance = await this.adapter.readLaneEquity!(group);
      if (balance != null) callbacks.onBalance(account.tradovateLabel, balance);
      if (account.atmPreset.trim()) {
        try {
          await this.adapter.selectLaneAtmPreset!(group, account.atmPreset);
        } catch (error) {
          presetError = error instanceof Error ? error : new Error(String(error));
          callbacks.onPresetError(presetError);
        }
      }
    } else {
      await prepareNextAccount(this.adapter, account, {
        onBalance: callbacks.onBalance,
        onPresetError: (error) => {
          presetError = error;
          callbacks.onPresetError(error);
        },
      });
    }
    if (presetError) throw presetError;
    if (this.executionMode === "sequential") this.ready.clear();
    this.ready.set(group, {
      group,
      accountLabel: account.tradovateLabel,
      atmPreset: account.atmPreset,
      preparedAt: new Date().toISOString(),
    });
  }

  async prepare(
    group: Group,
    account: StoredAccount,
    callbacks: ArmingCallbacks,
    force = false,
  ): Promise<void> {
    await this.ensureCapabilities();
    if (this.isReady(group, account)) return;
    const kind: CredentialTaskKind = group === "funded" ? "funded-maintenance" : "eval-maintenance";
    await this.enqueue(kind, async () => {
      if (this.openTrades.size > 0) {
        throw new Error(
          `${this.definition.name} has an open trade and cannot run background preparation until it closes.`,
        );
      }
      await this.preparePhysical(group, account, callbacks);
      this.desired.set(group, {
        account,
        callbacks,
        signature: {
        group,
        accountLabel: account.tradovateLabel,
        atmPreset: account.atmPreset,
        preparedAt: new Date().toISOString(),
        },
      });
    });
  }

  async enterPrepared(
    group: Group,
    account: StoredAccount,
    order: OrderRequest,
    options: { skipFundedWindow?: boolean; prepareIfNeeded?: ArmingCallbacks } = {},
  ): Promise<EntryTiming> {
    const generation = this.entryGeneration.get(group) ?? 0;
    await this.ensureCapabilities();
    if ((this.entryGeneration.get(group) ?? 0) !== generation) {
      throw new Error(`Pending ${group} entry cancelled because a close signal arrived first.`);
    }
    const requestedAt = Date.now();
    const initialStatus = this.adapter.status();
    if (!initialStatus.connected || !initialStatus.loggedIn) {
      throw new Error(`${this.definition.name} is not connected and logged in. The live signal was blocked.`);
    }
    const kind: CredentialTaskKind = group === "funded" ? "funded-entry" : "eval-entry";
    return this.enqueue(kind, async () => {
      if ((this.entryGeneration.get(group) ?? 0) !== generation) {
        throw new Error(`Pending ${group} entry cancelled because a close signal arrived first.`);
      }
      const queueWaitMs = Date.now() - requestedAt;
      const queuedStatus = this.adapter.status();
      if (!queuedStatus.connected || !queuedStatus.loggedIn) {
        throw new Error(`${this.definition.name} is not connected and logged in. The live signal was blocked.`);
      }

      let plan = this.desired.get(group);
      if (!plan
        || plan.signature.accountLabel !== account.tradovateLabel
        || plan.signature.atmPreset !== account.atmPreset) {
        const callbacks = options.prepareIfNeeded ?? {
          onBalance: () => {},
          onPresetError: () => {},
        };
        if (this.openTrades.size > 0 && this.executionMode === "sequential" && !this.adapter.verifyActiveAccount) {
          throw new Error(`${this.definition.name} cannot safely switch away from an open position in sequential mode.`);
        }
        await this.preparePhysical(group, account, callbacks);
        plan = {
          account,
          callbacks,
          signature: {
            group,
            accountLabel: account.tradovateLabel,
            atmPreset: account.atmPreset,
            preparedAt: new Date().toISOString(),
          },
        };
        this.desired.set(group, plan);
        if ((this.entryGeneration.get(group) ?? 0) !== generation) {
          throw new Error(`Pending ${group} entry cancelled because a close signal arrived first.`);
        }
      }
      if (!this.isReady(group, account)) {
        if (this.executionMode === "dual-ticket") throw new Error(`${account.name} is not physically ready on ${this.definition.name}.`);
        if (this.openTrades.size > 0 && !this.adapter.verifyActiveAccount) {
          throw new Error(`${this.definition.name} cannot safely switch away from an open position in sequential mode.`);
        }
        await this.preparePhysical(group, account, plan.callbacks);
      }
      const executionStarted = Date.now();
      try {
        if (!await this.adapter.verifyPreparedOrderState(group, account.tradovateLabel, account.atmPreset)) {
          await this.adapter.repairPreparedOrderState(group, account.tradovateLabel, account.atmPreset);
        }
        if (order.quantity != null) {
          if (this.executionMode === "dual-ticket") await this.adapter.setLaneQuantity!(group, order.quantity);
          else await this.adapter.setQuantity(order.quantity, true);
        }
        if (!await this.adapter.verifyPreparedOrderState(group, account.tradovateLabel, account.atmPreset, order.quantity)) {
          await this.adapter.repairPreparedOrderState(
            group,
            account.tradovateLabel,
            account.atmPreset,
            order.quantity,
          );
          if (!await this.adapter.verifyPreparedOrderState(group, account.tradovateLabel, account.atmPreset, order.quantity)) {
            throw new Error(`Final broker verification failed for ${account.name} after automatic repair. No order was placed.`);
          }
        }
        if (this.executionMode === "dual-ticket") {
          await this.adapter.clickLaneOrder!(group, order.action, account.tradovateLabel);
        } else {
          await this.adapter.clickOrder(order.action, account.tradovateLabel);
        }
        // Acquire the open-trade lease before releasing this session queue. A
        // prepare already waiting behind entry must never switch the account.
        this.openTrades.set(group, account.tradovateLabel);
      } finally {
        this.ready.delete(group);
        this.desired.delete(group);
      }
      return {
        queueWaitMs,
        executionMs: Date.now() - executionStarted,
        totalMs: Date.now() - requestedAt,
      };
    }, options);
  }

  clearOpenTrade(accountLabel: string): void {
    for (const [group, label] of this.openTrades) if (label === accountLabel) this.openTrades.delete(group);
  }

  /** Restore the safety lease represented by persisted rotation state after a
   * restart. Reading broker state never clears this; reconciliation does. */
  restoreOpenTrade(group: Group, accountLabel: string): void {
    this.openTrades.set(group, accountLabel);
  }

  cancelPendingEntry(group: Group): number {
    this.entryGeneration.set(group, (this.entryGeneration.get(group) ?? 0) + 1);
    const kind: CredentialTaskKind = group === "funded" ? "funded-entry" : "eval-entry";
    return this.scheduler.cancel(kind, new Error(`Pending ${group} entry cancelled because a close signal arrived first.`));
  }

  async testPreparedQuantity(group: Group, account: StoredAccount, quantity: number): Promise<EntryTiming> {
    const requestedAt = Date.now();
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Quantity must be a positive whole number.");
    if (!this.isReady(group, account)) throw new Error(`${account.name} is not ready on ${this.definition.name}.`);
    const kind: CredentialTaskKind = group === "funded" ? "funded-maintenance" : "eval-maintenance";
    return this.enqueue(kind, async () => {
      const queueWaitMs = Date.now() - requestedAt;
      if (!this.isReady(group, account)) throw new Error(`${account.name} is not ready on ${this.definition.name}.`);
      const executionStarted = Date.now();
      if (this.executionMode === "dual-ticket") await this.adapter.setLaneQuantity!(group, quantity);
      else await this.adapter.setQuantity(quantity, true);
      return { queueWaitMs, executionMs: Date.now() - executionStarted, totalMs: Date.now() - requestedAt };
    });
  }

  async connect(): Promise<AdapterStatus> {
    this.invalidateReady();
    this.capabilityInspection = undefined;
    await this.enqueue("diagnostic", () => this.adapter.connect());
    await this.ensureCapabilities();
    return this.status();
  }
  async recover(): Promise<AdapterStatus> {
    if (this.openTrades.size > 0) throw new Error(`${this.definition.name} cannot reload while it owns an open trade.`);
    this.invalidateReady();
    this.capabilityInspection = undefined;
    await this.enqueue("diagnostic", () => this.adapter.recover());
    await this.ensureCapabilities();
    return this.status();
  }
  async resumeExistingLogin(): Promise<AdapterStatus> {
    if (!this.adapter.resumeExistingLogin) throw new Error(`${this.definition.name} does not support click-only login recovery.`);
    await this.enqueue("diagnostic", () => this.adapter.resumeExistingLogin!());
    return this.status();
  }
  disconnect(): Promise<void> { this.invalidateReady(); return this.enqueue("diagnostic", () => this.adapter.disconnect()); }
  discoverAccounts(): Promise<string[]> { return this.enqueue("diagnostic", () => this.adapter.discoverAccounts()); }
  testAtmPreset(name: string): Promise<void> { this.invalidateReady(); return this.enqueue("diagnostic", () => this.adapter.selectAtmPreset(name)); }
  testQuantity(quantity: number): Promise<void> { return this.enqueue("diagnostic", () => this.adapter.setQuantity(quantity, true)); }
  inspectFields(): Promise<Array<Record<string, string>>> { return this.enqueue("diagnostic", () => this.adapter.inspectFields?.() ?? Promise.resolve([])); }
  async close(group: Group, label: string): Promise<void> {
    await this.enqueue("close", async () => {
      if (this.executionMode === "dual-ticket") {
        if (!await this.adapter.verifyExitState(group, label)) {
          throw new Error(`Final broker verification failed before Exit: ${label} is not the confirmed owning account.`);
        }
        await this.adapter.clickLaneExit!(group, label);
      } else {
        if (this.adapter.selectedAccount !== label) {
          await this.adapter.armFor(label);
        }
        if (!await this.adapter.verifyExitState(group, label)) {
          throw new Error(`Final broker verification failed before Exit: ${label} is not the confirmed owning account.`);
        }
        await this.adapter.clickExit(label);
      }
      // The click is only a close request. Keep the safety lease until the
      // broker POSITION field confirms flat and server reconciliation clears it.
      this.invalidateReady();
    });
  }
  clickExit(label: string): Promise<void> {
    const group = [...this.openTrades].find(([, openLabel]) => openLabel === label)?.[0] ?? "evals";
    return this.close(group, label);
  }
  readSelectedEquity(): Promise<number | null> { return this.enqueue("diagnostic", () => this.adapter.readSelectedEquity()); }
  readLaneEquity(group: Group, label: string): Promise<number | null> {
    const kind: CredentialTaskKind = group === "funded" ? "funded-maintenance" : "eval-maintenance";
    return this.enqueue(kind, async () => {
      if (this.executionMode === "dual-ticket") {
        if (!await this.adapter.verifyLaneAccount!(group, label)) {
          throw new Error(`The ${group} ticket is no longer showing ${label}.`);
        }
        return this.adapter.readLaneEquity!(group);
      }
      if (this.adapter.selectedAccount !== label) await this.adapter.armFor(label);
      const verified = await (this.adapter.verifyActiveAccount?.(label) ?? Promise.resolve(this.adapter.selectedAccount === label));
      if (!verified) throw new Error(`Could not verify ${label} before reading its balance.`);
      return this.adapter.readSelectedEquity();
    });
  }
  readLanePosition(group: Group, label: string): Promise<BrokerPosition> {
    const kind: CredentialTaskKind = group === "funded" ? "funded-maintenance" : "eval-maintenance";
    return this.enqueue(kind, async () => {
      const checkedAt = new Date().toISOString();
      if (this.executionMode === "dual-ticket") {
        if (!await this.adapter.verifyLaneAccount!(group, label)) {
          return { status: "unknown", reason: `Could not verify ${label} before reading its broker position.`, checkedAt };
        }
        return this.adapter.readLanePosition!(group);
      }
      if (this.adapter.selectedAccount !== label) await this.adapter.armFor(label);
      const verified = await (this.adapter.verifyActiveAccount?.(label) ?? Promise.resolve(this.adapter.selectedAccount === label));
      if (!verified) {
        return { status: "unknown", reason: `Could not verify ${label} before reading its broker position.`, checkedAt };
      }
      return this.adapter.readSelectedPosition();
    });
  }
  diagnoseLanePosition(group: Group, label: string): Promise<{ position: BrokerPosition; nearby: Array<Record<string, string>> }> {
    const kind: CredentialTaskKind = group === "funded" ? "funded-maintenance" : "eval-maintenance";
    return this.enqueue(kind, async () => {
      const checkedAt = new Date().toISOString();
      const unknown = { position: { status: "unknown" as const, reason: `Could not verify ${label} before reading its broker position.`, checkedAt }, nearby: [] as Array<Record<string, string>> };
      if (!this.adapter.diagnosePosition) {
        return { position: await this.readLanePosition(group, label), nearby: [] as Array<Record<string, string>> };
      }
      if (this.executionMode === "dual-ticket") {
        if (!await this.adapter.verifyLaneAccount!(group, label)) return unknown;
        return this.adapter.diagnosePosition();
      }
      if (this.adapter.selectedAccount !== label) await this.adapter.armFor(label);
      const verified = await (this.adapter.verifyActiveAccount?.(label) ?? Promise.resolve(this.adapter.selectedAccount === label));
      if (!verified) return unknown;
      return this.adapter.diagnosePosition();
    });
  }
  readSettledEquity(): Promise<number | null> { return this.enqueue("diagnostic", () => this.adapter.readSettledEquity()); }
  dismissPopups(): Promise<boolean> { return this.enqueue("diagnostic", () => this.adapter.dismissPopups()); }
  refreshLoginState(timeout?: number): Promise<boolean> { return this.enqueue("diagnostic", () => this.adapter.refreshLoginState(timeout)); }
  verifyActiveAccount(label: string): Promise<boolean> {
    return this.enqueue("diagnostic", () => this.adapter.verifyActiveAccount?.(label) ?? Promise.resolve(this.adapter.selectedAccount === label));
  }
}

/** Backward-compatible name while server call sites move to credential wording. */
export class LoginWorker extends CredentialWorker {}

export class TradovateSessionAdapter implements TradingSessionAdapter {
  private readonly browser: TradovateBrowser;
  private independentTicketsBlocked = false;

  constructor(definition: SavedLogin, baseConfig: Config, root: string) {
    const browserConfig: Config = {
      ...baseConfig,
      sessionDir: resolve(root, definition.sessionDir),
      screenshotDir: resolve(baseConfig.screenshotDir, definition.id),
    };
    this.browser = new TradovateBrowser(browserConfig);
  }

  get selectedAccount(): string | null { return this.browser.selectedAccount; }
  status(): AdapterStatus { return { ...this.browser.status(), selectedAccount: this.browser.selectedAccount }; }
  connect() { return this.browser.connect(); }
  recover() { return this.browser.recover(); }
  resumeExistingLogin() { return this.browser.resumeExistingLogin(); }
  disconnect() { return this.browser.disconnect(); }
  discoverAccounts() { return this.browser.listAccounts(); }
  armFor(label: string) { return this.browser.armFor(label); }
  readSelectedEquity() { return this.browser.readSelectedEquity(); }
  readSelectedPosition() { return this.browser.readSelectedPosition(); }
  diagnosePosition() { return this.browser.diagnosePosition(); }
  selectAtmPreset(name: string) { return this.browser.selectAtmPreset(name); }
  setQuantity(quantity: number, force = false) { return this.browser.setQuantity(quantity, force); }
  clickOrder(action: "buy" | "sell", label: string) { return this.browser.clickOrder(action, label); }
  clickExit(label: string) { return this.browser.clickExit(label); }
  readSettledEquity() { return this.browser.readSettledEquity(); }
  dismissPopups() { return this.browser.dismissPopups(); }
  refreshLoginState(timeout?: number) { return this.browser.refreshLoginState(timeout); }
  inspectFields() { return this.browser.inspectFields(); }
  verifyActiveAccount(label: string) { return this.browser.verifyActiveAccount(label); }
  async inspectCapabilities(): Promise<TicketCapabilities> {
    const capability = await this.browser.inspectCapabilities();
    if (capability.mode === "dual-ticket") {
      this.independentTicketsBlocked = true;
      return {
        mode: "sequential",
        reason: "Two independent tickets were found but equity is global. Live clicks are blocked until only one ticket is open or balance ownership becomes lane-safe.",
      };
    }
    return capability;
  }
  armForLane(group: Group, label: string) { return this.browser.armForLane(group, label); }
  readLaneEquity(group: Group) { return this.browser.readLaneEquity(group); }
  selectLaneAtmPreset(group: Group, name: string) { return this.browser.selectLaneAtmPreset(group, name); }
  setLaneQuantity(group: Group, quantity: number) { return this.browser.setLaneQuantity(group, quantity); }
  clickLaneOrder(group: Group, action: "buy" | "sell", label: string) { return this.browser.clickLaneOrder(group, action, label); }
  clickLaneExit(group: Group, label: string) { return this.browser.clickLaneExit(group, label); }
  verifyLaneAccount(group: Group, label: string) { return this.browser.verifyLaneAccount(group, label); }
  verifyPreparedOrderState(group: Group, label: string, atmPreset: string, quantity?: number) {
    if (this.independentTicketsBlocked) return Promise.resolve(false);
    return this.browser.verifySequentialPreparedOrderState(label, atmPreset, quantity);
  }
  repairPreparedOrderState(_group: Group, label: string, atmPreset: string, quantity?: number) {
    if (this.independentTicketsBlocked) {
      return Promise.reject(new Error("Automatic ticket repair is blocked because two independent tickets are open."));
    }
    return this.browser.repairSequentialPreparedOrderState(label, atmPreset, quantity);
  }
  verifyExitState(_group: Group, label: string) {
    if (this.independentTicketsBlocked) return Promise.resolve(false);
    return this.browser.verifySequentialExitState(label);
  }
}

export type SessionAdapterFactory = (definition: SavedLogin) => TradingSessionAdapter;

export class LoginManager {
  private readonly workers = new Map<string, LoginWorker>();

  constructor(
    definitions: readonly SavedLogin[],
    private readonly factory: SessionAdapterFactory,
    private readonly options: { fundedPriorityWindowMs?: number } = {},
  ) {
    for (const definition of definitions) if (definition.enabled) this.add(definition);
  }

  get(id: string): LoginWorker | undefined { return this.workers.get(id); }
  values(): LoginWorker[] { return [...this.workers.values()]; }

  add(definition: SavedLogin): LoginWorker {
    if (this.workers.has(definition.id)) throw new Error(`Login already active: ${definition.id}`);
    if (definition.platform !== "tradovate") throw new Error(`Unsupported platform: ${String(definition.platform)}`);
    const worker = new LoginWorker(definition, this.factory(definition), this.options);
    this.workers.set(definition.id, worker);
    return worker;
  }

  async remove(id: string): Promise<void> {
    const worker = this.workers.get(id);
    if (!worker) throw new Error(`Unknown login: ${id}`);
    await worker.disconnect();
    this.workers.delete(id);
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(this.values().map((worker) => worker.disconnect()));
  }
}
