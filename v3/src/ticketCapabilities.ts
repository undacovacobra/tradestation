import type { Locator, Page } from "playwright";
/** Dual-ticket isolation is inherently a two-ticket (eval + funded) proof; it is
 *  deliberately decoupled from the global set of rotation groups. */
type DualStage = "evals" | "funded";

export type TicketExecutionMode = "dual-ticket" | "sequential";

export interface TicketSnapshot {
  account: string;
  atmPreset: string;
  quantity: number;
}

export interface TicketPreparation {
  account: string;
  atmPreset: string;
  quantity?: number;
}

interface TicketBinding {
  root: Locator;
  account: Locator;
  atm: Locator;
  quantity: Locator;
  buy: Locator;
  sell: Locator;
  exit: Locator;
}

export interface TicketCapabilities {
  mode: TicketExecutionMode;
  reason: string;
  controller?: DualTicketController;
}

async function fieldValue(locator: Locator): Promise<string> {
  return (await locator.inputValue()).trim();
}

async function chooseExact(locator: Locator, value: string): Promise<void> {
  await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
  const actual = await fieldValue(locator);
  if (actual !== value) throw new Error(`Expected "${value}" but read back "${actual}".`);
}

async function alternateOption(locator: Locator, current: string): Promise<string | undefined> {
  const values = await locator.locator("option").evaluateAll((options) => options.map((option) => {
    const item = option as HTMLOptionElement;
    return (item.value || item.textContent || "").trim();
  }));
  return values.find((value) => value && value !== current);
}

export class DualTicketController {
  constructor(private readonly bindings: Record<DualStage, TicketBinding>) {}

  async read(stage: DualStage): Promise<TicketSnapshot> {
    const binding = this.bindings[stage];
    const quantity = Number(await fieldValue(binding.quantity));
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`${stage} ticket quantity could not be verified.`);
    return {
      account: await fieldValue(binding.account),
      atmPreset: await fieldValue(binding.atm),
      quantity,
    };
  }

  async prepare(stage: DualStage, preparation: TicketPreparation): Promise<TicketSnapshot> {
    const binding = this.bindings[stage];
    await chooseExact(binding.account, preparation.account);
    await chooseExact(binding.atm, preparation.atmPreset);
    if (preparation.quantity != null) {
      if (!Number.isInteger(preparation.quantity) || preparation.quantity < 1) {
        throw new Error("Quantity must be a positive whole number.");
      }
      await binding.quantity.fill(String(preparation.quantity));
    }
    const snapshot = await this.read(stage);
    if (snapshot.account !== preparation.account || snapshot.atmPreset !== preparation.atmPreset) {
      throw new Error(`${stage} ticket did not retain its exact account and ATM preset.`);
    }
    if (preparation.quantity != null && snapshot.quantity !== preparation.quantity) {
      throw new Error(`${stage} ticket did not retain quantity ${preparation.quantity}.`);
    }
    return snapshot;
  }

  async clickOrder(stage: DualStage, action: "buy" | "sell"): Promise<void> {
    await this.bindings[stage][action].click();
  }

  async clickExit(stage: DualStage): Promise<void> {
    await this.bindings[stage].exit.click();
  }
}

async function discoverBindings(page: Page): Promise<TicketBinding[]> {
  // Fail closed: only ticket roots with a full, root-scoped control set qualify.
  // `data-atlas-*` makes fixtures deterministic; the other roots permit a live
  // Tradovate module to qualify only when its controls can be scoped exactly.
  const roots = page.locator(
    '[data-atlas-ticket], order-ticket, [aria-label*="Order Ticket" i], [data-module*="order" i]',
  );
  const bindings: TicketBinding[] = [];
  for (let index = 0; index < await roots.count(); index++) {
    const root = roots.nth(index);
    if (!await root.isVisible().catch(() => false)) continue;
    const account = root.locator('[data-atlas-account], select[aria-label*="account" i]').first();
    const atm = root.locator('[data-atlas-atm], select[aria-label*="atm" i], select[aria-label*="preset" i]').first();
    const quantity = root.locator('[data-atlas-quantity], input[aria-label*="qty" i], input[aria-label*="quantity" i]').first();
    const buy = root.locator('[data-atlas-buy], button:has-text("Buy Mkt"), [role="button"]:has-text("Buy Mkt")').first();
    const sell = root.locator('[data-atlas-sell], button:has-text("Sell Mkt"), [role="button"]:has-text("Sell Mkt")').first();
    const exit = root.locator('[data-atlas-exit], button:has-text("Exit at Mkt"), [role="button"]:has-text("Exit at Mkt")').first();
    const controls = [account, atm, quantity, buy, sell, exit];
    const present = (await Promise.all(controls.map((control) => control.count()))).every((count) => count > 0);
    const visible = present && (await Promise.all(controls.map((control) => control.isVisible().catch(() => false)))).every(Boolean);
    if (visible) {
      bindings.push({ root, account, atm, quantity, buy, sell, exit });
    }
  }
  return bindings;
}

/**
 * Proves two order tickets are independently controllable without touching an
 * order button. Every temporary account/ATM/quantity mutation is restored.
 */
export async function inspectTicketCapabilities(page: Page): Promise<TicketCapabilities> {
  const found = await discoverBindings(page);
  if (found.length < 2) {
    return { mode: "sequential", reason: "Two complete independently scoped Order Ticket modules were not found." };
  }
  const evals = found[0]!;
  const funded = found[1]!;
  const controller = new DualTicketController({ evals, funded });
  const stableRead = async (stage: DualStage): Promise<TicketSnapshot> => {
    await page.waitForTimeout(75);
    const first = await controller.read(stage);
    await page.waitForTimeout(75);
    const second = await controller.read(stage);
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error(`${stage} ticket did not remain stable during the isolation proof.`);
    return second;
  };
  let originalEvals: TicketSnapshot | undefined;
  let originalFunded: TicketSnapshot | undefined;
  let failure: Error | undefined;
  try {
    originalEvals = await stableRead("evals");
    originalFunded = await stableRead("funded");
    const evalAccount = await alternateOption(evals.account, originalEvals.account);
    const fundedAccount = await alternateOption(funded.account, originalFunded.account);
    const evalAtm = await alternateOption(evals.atm, originalEvals.atmPreset);
    const fundedAtm = await alternateOption(funded.atm, originalFunded.atmPreset);
    if (!evalAccount || !fundedAccount || !evalAtm || !fundedAtm) {
      throw new Error("Both tickets need alternate account and ATM values for an isolation proof.");
    }

    await chooseExact(evals.account, evalAccount);
    if ((await stableRead("funded")).account !== originalFunded.account) {
      throw new Error("The funded account changed when the evaluation ticket changed; tickets are not independent.");
    }
    await chooseExact(funded.account, fundedAccount);
    if ((await stableRead("evals")).account !== evalAccount) {
      throw new Error("The evaluation account changed when the funded ticket changed; tickets are not independent.");
    }

    await chooseExact(evals.atm, evalAtm);
    if ((await stableRead("funded")).atmPreset !== originalFunded.atmPreset) {
      throw new Error("The funded ATM changed when the evaluation ticket changed; tickets are not independent.");
    }
    await chooseExact(funded.atm, fundedAtm);
    if ((await stableRead("evals")).atmPreset !== evalAtm) {
      throw new Error("The evaluation ATM changed when the funded ticket changed; tickets are not independent.");
    }

    await evals.quantity.fill(String(originalEvals.quantity + 1));
    if ((await stableRead("funded")).quantity !== originalFunded.quantity) {
      throw new Error("The funded quantity changed when the evaluation ticket changed; tickets are not independent.");
    }
    await funded.quantity.fill(String(originalFunded.quantity + 2));
    if ((await stableRead("evals")).quantity !== originalEvals.quantity + 1) {
      throw new Error("The evaluation quantity changed when the funded ticket changed; tickets are not independent.");
    }

  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  if (originalEvals && originalFunded) {
    try {
      // Restore sequentially. Some real widgets share React update cycles even
      // when their final values are independent; concurrent restoration can
      // race and leave one quantity changed.
      await controller.prepare("evals", originalEvals);
      await controller.prepare("funded", originalFunded);
      const restoredEvals = await controller.read("evals");
      const restoredFunded = await controller.read("funded");
      if (JSON.stringify(restoredEvals) !== JSON.stringify(originalEvals)
        || JSON.stringify(restoredFunded) !== JSON.stringify(originalFunded)) {
        throw new Error("Ticket values could not be restored exactly after the isolation probe.");
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  }

  return failure
    ? { mode: "sequential", reason: failure.message }
    : { mode: "dual-ticket", reason: "Two ticket roots passed the no-order isolation probe.", controller };
}
