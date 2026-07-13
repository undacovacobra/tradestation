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
  prepare(account: AccountDefinition): Promise<void>;
  verifyPrepared(account: AccountDefinition): Promise<void>;
  enterPrepared(account: AccountDefinition, alert: V4Alert): Promise<void>;
  enter(account: AccountDefinition, alert: V4Alert): Promise<void>;
  close(account: AccountDefinition): Promise<void>;
  readBalance(account: AccountDefinition): Promise<number | null>;
  readSelectedBalance(): Promise<number | null>;
  readSettledBalance(account: AccountDefinition): Promise<number | null>;
}

type PreparationBrowser = Pick<TradovateBrowser, "switchAccount" | "setBracket">;
type EntryBrowser = PreparationBrowser & Pick<TradovateBrowser, "setQuantity" | "clickOrder">;

function requireBracket(account: AccountDefinition): void {
  if (!(account.targetPerContract > 0) || !(account.stopPerContract > 0)) {
    throw new Error(`Configure both take profit and stop loss dollars for ${account.name} before it can trade.`);
  }
}

/** Select and verify the next account's ATM values without placing an order. */
export async function prepareAccount(browser: PreparationBrowser, account: AccountDefinition): Promise<void> {
  requireBracket(account);
  await browser.switchAccount(account.platformLabel);
  await browser.setBracket(account.targetPerContract, account.stopPerContract);
}

async function enterPrepared(browser: Pick<TradovateBrowser, "setQuantity" | "clickOrder">, account: AccountDefinition, alert: V4Alert): Promise<void> {
  if (alert.quantity != null) await browser.setQuantity(alert.quantity);
  await browser.clickOrder(alert.action as "buy" | "sell", account.platformLabel);
}

/** Prepare every account-specific ticket setting before the only order-producing click. */
export async function prepareEntry(browser: EntryBrowser, account: AccountDefinition, alert: V4Alert): Promise<void> {
  await prepareAccount(browser, account);
  await enterPrepared(browser, account, alert);
}

/** One queue per login: safe serialization inside a browser, parallelism across logins. */
export class ConnectionWorker {
  private tail: Promise<unknown> = Promise.resolve();
  private busy = false;
  private lastError: string | undefined;
  private armed: ArmedSignature | undefined;

  constructor(readonly definition: ConnectionDefinition, private readonly adapter: ConnectionAdapter) {}

  run<T>(task: (adapter: ConnectionAdapter) => Promise<T>): Promise<T> {
    const execute = async () => {
      this.busy = true;
      try { const result = await task(this.adapter); this.lastError = undefined; return result; }
      catch (error) { this.lastError = (error as Error).message; throw error; }
      finally { this.busy = false; }
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.catch(() => undefined);
    return result;
  }

  status(): WorkerStatus { return { ...this.adapter.status(), busy: this.busy, lastError: this.lastError, armed: this.armed ? { ...this.armed } : undefined }; }

  isArmed(account: AccountDefinition): boolean {
    return this.armed?.accountId === account.id
      && this.armed.platformLabel === account.platformLabel
      && this.armed.targetPerContract === account.targetPerContract
      && this.armed.stopPerContract === account.stopPerContract;
  }

  invalidateArmed(): void { this.armed = undefined; }

  private markArmed(account: AccountDefinition): void {
    this.armed = {
      accountId: account.id,
      platformLabel: account.platformLabel,
      targetPerContract: account.targetPerContract,
      stopPerContract: account.stopPerContract,
      armedAt: new Date().toISOString(),
    };
  }

  async prearm(account: AccountDefinition): Promise<void> {
    this.invalidateArmed();
    await this.run(async (adapter) => {
      await adapter.prepare(account);
      this.markArmed(account);
    });
  }

  async dryRun(account: AccountDefinition): Promise<void> {
    this.invalidateArmed();
    await this.run(async (adapter) => {
      await adapter.prepare(account);
      await adapter.verifyPrepared(account);
      this.markArmed(account);
    });
  }

  async enter(account: AccountDefinition, alert: V4Alert): Promise<number | null> {
    return this.run(async (adapter) => {
      const balance = await adapter.readBalance(account);
      const wasArmed = this.isArmed(account);
      if (!wasArmed) {
        this.invalidateArmed();
        await adapter.prepare(account);
        this.markArmed(account);
      }
      try {
        // prepare() already persists and reopens ATM to verify it. Only an
        // older pre-arm needs another read immediately before the order.
        if (wasArmed) await adapter.verifyPrepared(account);
        await adapter.enterPrepared(account, alert);
      } catch (error) {
        this.invalidateArmed();
        throw error;
      }
      return balance;
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
  async prepare(account: AccountDefinition): Promise<void> { await prepareAccount(this.browser, account); }
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
  async prepare(account: AccountDefinition): Promise<void> { requireBracket(account); this.selected = account.platformLabel; }
  async verifyPrepared(account: AccountDefinition): Promise<void> {
    requireBracket(account);
    if (this.selected !== account.platformLabel) throw new Error(`Selected account is ${this.selected ?? "unknown"}, not ${account.platformLabel}.`);
  }
  async enterPrepared(account: AccountDefinition): Promise<void> { this.selected = account.platformLabel; }
  async enter(account: AccountDefinition): Promise<void> { await this.prepare(account); }
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
