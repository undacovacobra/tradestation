import type { StoredAccount } from "./types.js";

export interface ArmingBrowser {
  armFor(label: string): Promise<void>;
  readSelectedEquity(): Promise<number | null>;
  selectAtmPreset(name: string): Promise<void>;
}

export interface ArmingCallbacks {
  onBalance(label: string, equity: number): void;
  onPresetError(error: Error): void;
}

export async function prepareNextAccount(
  browser: ArmingBrowser,
  account: StoredAccount,
  callbacks: ArmingCallbacks,
): Promise<void> {
  await browser.armFor(account.tradovateLabel);
  const equity = await browser.readSelectedEquity();
  if (equity != null) callbacks.onBalance(account.tradovateLabel, equity);
  if (!account.atmPreset) return;
  try {
    await browser.selectAtmPreset(account.atmPreset);
  } catch (error) {
    callbacks.onPresetError(error instanceof Error ? error : new Error(String(error)));
  }
}
