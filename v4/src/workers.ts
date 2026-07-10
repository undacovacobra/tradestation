import { resolve } from "node:path";
import { config, ROOT, type Config } from "./config.js";
import type { AccountDefinition, ConnectionDefinition, V4Alert, WorkerStatus } from "./models.js";
import { TradovateBrowser } from "./browser.js";

export interface ConnectionAdapter {
  connect(): Promise<void>;
  recover(): Promise<void>;
  disconnect(): Promise<void>;
  status(): WorkerStatus;
  discoverAccounts(): Promise<string[]>;
  enter(account: AccountDefinition, alert: V4Alert): Promise<void>;
  close(account: AccountDefinition): Promise<void>;
}

/** One queue per login: safe serialization inside a browser, parallelism across logins. */
export class ConnectionWorker {
  private tail: Promise<unknown> = Promise.resolve();
  private busy = false;
  private lastError: string | undefined;

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

  status(): WorkerStatus { return { ...this.adapter.status(), busy: this.busy, lastError: this.lastError }; }
  connect(): Promise<void> { return this.run((a) => a.connect()); }
  recover(): Promise<void> { return this.run((a) => a.recover()); }
  disconnect(): Promise<void> { return this.run((a) => a.disconnect()); }
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
  async enter(account: AccountDefinition, alert: V4Alert): Promise<void> {
    await this.browser.switchAccount(account.platformLabel);
    if (alert.quantity != null) await this.browser.setQuantity(alert.quantity);
    await this.browser.clickOrder(alert.action as "buy" | "sell", account.platformLabel);
  }
  async close(account: AccountDefinition): Promise<void> {
    await this.browser.switchAccount(account.platformLabel);
    await this.browser.clickExit(account.platformLabel);
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
  async enter(account: AccountDefinition): Promise<void> { this.selected = account.platformLabel; }
  async close(account: AccountDefinition): Promise<void> { this.selected = account.platformLabel; }
}

export function createWorkers(definitions: ConnectionDefinition[]): Map<string, ConnectionWorker> {
  const workers = new Map<string, ConnectionWorker>();
  for (const definition of definitions) {
    const adapter = definition.adapter === "simulated" ? new SimulatedAdapter(definition) : new TradovateAdapter(definition);
    workers.set(definition.id, new ConnectionWorker(definition, adapter));
  }
  return workers;
}
