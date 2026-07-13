import { resolve } from "node:path";
import { config, ROOT, type Config } from "./config.js";
import type { AccountDefinition, ArmedSignature, ConnectionDefinition, V4Alert, WorkerStatus } from "./models.js";
import { TradovateBrowser } from "./browser.js";

export interface ConnectionAdapter {
  connect(): Promise<void>;
  recover(): Promise<void>;
  disconnect(): Promise<void>;
  status(): WorkerStatus;
  discoverAccounts(): Promise<string[]>;
  setBracket(targetPerContract: number, stopPerContract: number, force?: boolean): Promise<void>;
  inspectFields(): Promise<Array<Record<string, string>>>;
  inspectAtmControls(): Promise<Array<Record<string, string | number | boolean>>>;
  prepare(account: AccountDefinition, quantity: number): Promise<void>;
  verifyPrepared(account: AccountDefinition): Promise<void>;
  enterPrepared(account: AccountDefinition, alert: V4Alert): Promise<void>;
  enter(account: AccountDefinition, alert: V4Alert): Promise<void>;
  close(account: AccountDefinition): Promise<void>;
  readBalance(account: AccountDefinition): Promise<number | null>;
  readSelectedBalance(): Promise<number | null>;
  readSettledBalance(account: AccountDefinition): Promise<number | null>;
}

type PreparationBrowser = Pick<TradovateBrowser, "switchAccount" | "setBracket" | "setQuantity">;
type EntryBrowser = PreparationBrowser & Pick<TradovateBrowser, "setQuantity" | "clickOrder">;

function requireBracket(account: AccountDefinition): void {
  if (!(account.targetPerContract > 0) || !(account.stopPerContract > 0)) {
    throw new Error(`Configure both take profit and stop loss dollars for ${account.name} before it can trade.`);
  }
}

/** Select and verify the next account's ATM values without placing an order. */
export async function prepareAccount(browser: PreparationBrowser, account: AccountDefinition, quantity = 1): Promise<void> {
  requireBracket(account);
  await browser.switchAccount(account.platformLabel);
  await browser.setBracket(account.targetPerContract, account.stopPerContract);
  await browser.setQuantity(quantity);
}

async function enterPrepared(browser: Pick<TradovateBrowser, "setQuantity" | "clickOrder">, account: AccountDefinition, alert: V4Alert): Promise<void> {
  await browser.clickOrder(alert.action as "buy" | "sell", account.platformLabel);
}

/** Prepare every account-specific ticket setting before the only order-producing click. */
export async function prepareEntry(browser: EntryBrowser, account: AccountDefinition, alert: V4Alert): Promise<void> {
  await prepareAccount(browser, account, alert.quantity ?? 1);
  await enterPrepared(browser, account, alert);
}

/** One queue per login: safe serialization inside a browser, parallelism across logins. */
export class ConnectionWorker {
  private tail: Promise<unknown> = Promise.resolve();
  private busy = false;
  private pendingTasks = 0;
  private lastError: string | undefined;
  private armed: ArmedSignature | undefined;

  constructor(readonly definition: ConnectionDefinition, private readonly adapter: ConnectionAdapter) {}

  run<T>(task: (adapter: ConnectionAdapter) => Promise<T>): Promise<T> {
    this.pendingTasks++;
    const execute = async () => {
      this.busy = true;
      try { const result = await task(this.adapter); this.lastError = undefined; return result; }
      catch (error) { this.lastError = (error as Error).message; throw error; }
      finally { this.busy = false; this.pendingTasks--; }
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.catch(() => undefined);
    return result;
  }

  status(): WorkerStatus { return { ...this.adapter.status(), busy: this.busy, lastError: this.lastError, armed: this.armed ? { ...this.armed } : undefined }; }

  isArmed(account: AccountDefinition, quantity = 1): boolean {
    return this.armed?.accountId === account.id
      && this.armed.platformLabel === account.platformLabel
      && this.armed.targetPerContract === account.targetPerContract
      && this.armed.stopPerContract === account.stopPerContract
      && this.armed.quantity === quantity;
  }

  invalidateArmed(): void { this.armed = undefined; }

  private markArmed(account: AccountDefinition, quantity: number, entryBalance: number | null): void {
    this.armed = {
      accountId: account.id,
      platformLabel: account.platformLabel,
      targetPerContract: account.targetPerContract,
      stopPerContract: account.stopPerContract,
      quantity,
      ...(entryBalance == null ? {} : { entryBalance }),
      armedAt: new Date().toISOString(),
    };
  }

  async prearm(account: AccountDefinition, quantity = 1): Promise<void> {
    this.invalidateArmed();
    await this.run(async (adapter) => {
      const entryBalance = await adapter.readBalance(account);
      await adapter.prepare(account, quantity);
      this.markArmed(account, quantity, entryBalance);
    });
  }

  async dryRun(account: AccountDefinition, quantity = 1): Promise<{ alreadyArmed: boolean; elapsedMs: number }> {
    const startedAt = Date.now();
    if (this.isArmed(account, quantity)) return { alreadyArmed: true, elapsedMs: Date.now() - startedAt };
    this.invalidateArmed();
    await this.run(async (adapter) => {
      const entryBalance = await adapter.readBalance(account);
      await adapter.prepare(account, quantity);
      this.markArmed(account, quantity, entryBalance);
    });
    return { alreadyArmed: false, elapsedMs: Date.now() - startedAt };
  }

  async enter(account: AccountDefinition, alert: V4Alert): Promise<{ balance: number | null; timingMs: { queueWait: number; execution: number; total: number } }> {
    const requestedAt = Date.now();
    const quantity = alert.quantity ?? 1;
    if (this.busy || this.pendingTasks > 0) throw new Error(`${this.definition.name} is busy with preparation or maintenance. The live signal was blocked instead of delayed.`);
    if (!this.isArmed(account, quantity)) throw new Error(`${account.name} is not ready for quantity ${quantity}. Prepare it with Make next before sending a live signal.`);
    return this.run(async (adapter) => {
      const queueWait = Date.now() - requestedAt;
      if (!this.isArmed(account, quantity)) {
        throw new Error(`${account.name} is not ready for quantity ${quantity}. Prepare it with Make next before sending a live signal.`);
      }
      const armed = this.armed!;
      const executionStartedAt = Date.now();
      try {
        await adapter.enterPrepared(account, alert);
      } catch (error) {
        this.invalidateArmed();
        throw error;
      }
      const execution = Date.now() - executionStartedAt;
      this.invalidateArmed();
      return { balance: armed.entryBalance ?? null, timingMs: { queueWait, execution, total: Date.now() - requestedAt } };
    });
  }

  connect(): Promise<void> { this.invalidateArmed(); return this.run((a) => a.connect()); }
  recover(): Promise<void> { this.invalidateArmed(); return this.run((a) => a.recover()); }
  disconnect(): Promise<void> { this.invalidateArmed(); return this.run((a) => a.disconnect()); }
}

class TradovateAdapter implements ConnectionAdapter {
  private readonly browser: TradovateBrowser;
  constructor(private readonly definition: ConnectionDefinition) {
    const browserConfig: Config = {
      ...config,
      tradovateUrl: definition.url,
      sessionDir: resolve(ROOT, definition.sessionDir),
      screenshotDir: resolve(config.screenshotDir, definition.id),
      accountIdPattern: new RegExp(definition.accountPattern),
    } as Config;
    this.browser = new TradovateBrowser(browserConfig);
  }
  async connect(): Promise<void> { await this.browser.connect(); }
  async recover(): Promise<void> { await this.browser.recover(); }
  async disconnect(): Promise<void> { await this.browser.disconnect(); }
  status(): WorkerStatus {
    const status = this.browser.status();
    return { connectionId: this.definition.id, ...status, busy: false, selectedAccount: this.browser.selectedAccount };
  }
  discoverAccounts(): Promise<string[]> { return this.browser.listAccounts(); }
  setBracket(targetPerContract: number, stopPerContract: number, force = false): Promise<void> {
    return this.browser.setBracket(targetPerContract, stopPerContract, force);
  }
  inspectFields(): Promise<Array<Record<string, string>>> { return this.browser.inspectFields(); }
  inspectAtmControls(): Promise<Array<Record<string, string | number | boolean>>> { return this.browser.inspectAtmControls(); }
  async prepare(account: AccountDefinition, quantity: number): Promise<void> { await prepareAccount(this.browser, account, quantity); }
  async verifyPrepared(account: AccountDefinition): Promise<void> {
    await this.browser.verifySelectedAccount(account.platformLabel);
    await this.browser.verifyBracket(account.targetPerContract, account.stopPerContract);
  }
  async enterPrepared(account: AccountDefinition, alert: V4Alert): Promise<void> { await enterPrepared(this.browser, account, alert); }
  async enter(account: AccountDefinition, alert: V4Alert): Promise<void> {
    await prepareEntry(this.browser, account, alert);
  }
  async close(account: AccountDefinition): Promise<void> {
    await this.browser.switchAccount(account.platformLabel);
    await this.browser.clickExit(account.platformLabel);
  }
  async readBalance(account: AccountDefinition): Promise<number | null> {
    await this.browser.switchAccount(account.platformLabel);
    return this.browser.readSelectedEquity();
  }
  readSelectedBalance(): Promise<number | null> { return this.browser.readSelectedEquity(); }
  async readSettledBalance(account: AccountDefinition): Promise<number | null> {
    await this.browser.switchAccount(account.platformLabel);
    return this.browser.readSettledEquity();
  }
}

class SimulatedAdapter implements ConnectionAdapter {
  private connected = false;
  private selected: string | null = null;
  constructor(private readonly definition: ConnectionDefinition) {}
  async connect(): Promise<void> { this.connected = true; }
  async recover(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; this.selected = null; }
  status(): WorkerStatus { return { connectionId: this.definition.id, connected: this.connected, loggedIn: this.connected, busy: false, selectedAccount: this.selected }; }
  async discoverAccounts(): Promise<string[]> { return []; }
  async setBracket(): Promise<void> {}
  async inspectFields(): Promise<Array<Record<string, string>>> { return []; }
  async inspectAtmControls(): Promise<Array<Record<string, string | number | boolean>>> { return []; }
  async prepare(account: AccountDefinition, _quantity: number): Promise<void> { requireBracket(account); this.selected = account.platformLabel; }
  async verifyPrepared(account: AccountDefinition): Promise<void> {
    requireBracket(account);
    if (this.selected !== account.platformLabel) throw new Error(`Selected account is ${this.selected ?? "unknown"}, not ${account.platformLabel}.`);
  }
  async enterPrepared(account: AccountDefinition): Promise<void> { this.selected = account.platformLabel; }
  async enter(account: AccountDefinition): Promise<void> { await this.prepare(account, 1); }
  async close(account: AccountDefinition): Promise<void> { this.selected = account.platformLabel; }
  async readBalance(): Promise<number | null> { return null; }
  async readSelectedBalance(): Promise<number | null> { return null; }
  async readSettledBalance(): Promise<number | null> { return null; }
}

export function createWorkers(definitions: ConnectionDefinition[]): Map<string, ConnectionWorker> {
  const workers = new Map<string, ConnectionWorker>();
  for (const definition of definitions) workers.set(definition.id, createWorker(definition));
  return workers;
}

export function createWorker(definition: ConnectionDefinition): ConnectionWorker {
  const adapter = definition.adapter === "simulated" ? new SimulatedAdapter(definition) : new TradovateAdapter(definition);
  return new ConnectionWorker(definition, adapter);
}
