# ATLAS Self-Healing Webhook Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each webhook-supplied quantity authoritative and automatically repair manual Tradovate account/ATM/quantity drift before Buy/Sell.

**Architecture:** Keep orchestration in `CredentialWorker.enterPrepared`, extend the adapter contract with forced quantity and bounded repair operations, and implement real-screen repair in `TradovateBrowser`. Preserve the final fail-closed check and all funded-first scheduling.

**Tech Stack:** TypeScript, Node.js, Playwright, Node test runner, Express.

## Global Constraints

- Every webhook quantity is force-written and read back before entry.
- Exact account, saved ATM, and webhook quantity must be visible before Buy/Sell.
- Manual drift gets one bounded repair; a second mismatch places no order.
- Funded priority, webhook routes, rotation, position reconciliation, and close handling remain unchanged.
- Webhooks without quantity retain existing displayed-quantity compatibility.

---

### Task 1: Define and test the worker safety sequence

**Files:**
- Modify: `src/sessions.ts`
- Test: `test/sessions.test.ts`

**Interfaces:**
- Consumes: `TradingSessionAdapter.verifyPreparedOrderState(group, label, atmPreset, quantity?)`
- Produces: `TradingSessionAdapter.setQuantity(quantity, force?)` and `repairPreparedOrderState(group, label, atmPreset, quantity?)`

- [ ] **Step 1: Write failing worker tests**

Add tests proving that an entry with quantity calls the force-write path, that a failed identity/ATM preflight calls repair before quantity and order, and that a second failed verification produces no order call.

```ts
test("webhook quantity is authoritative even when the ticket was already prepared", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const acct = account("E1", "evals", "one");
  await worker.prepare("evals", acct, callbacks);
  adapter.calls.length = 0;
  await worker.enterPrepared("evals", acct, { action: "buy", symbol: "MNQ", quantity: 3 });
  assert.equal(adapter.calls.includes("qty:3:force"), true);
});

test("entry repairs manual account or ATM drift before placing", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const acct = account("F1", "funded", "one");
  await worker.prepare("funded", acct, callbacks);
  adapter.selectedAccount = "E1";
  adapter.atmPreset = "25";
  adapter.calls.length = 0;
  await worker.enterPrepared("funded", acct, { action: "sell", symbol: "MNQ", quantity: 4 });
  assert.deepEqual(adapter.calls, ["repair:funded:F1:funded", "qty:4:force", "order:sell:F1"]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test --test-name-pattern "authoritative webhook quantity|repairs manual ticket drift|failed ticket repair" test/sessions.test.ts`

Expected: FAIL because force and repair are not represented in the adapter or entry sequence.

- [ ] **Step 3: Implement the minimal orchestration**

Extend the adapter contract:

```ts
setQuantity(quantity: number, force?: boolean): Promise<void>;
repairPreparedOrderState(
  group: Group,
  label: string,
  atmPreset: string,
  quantity?: number,
): Promise<void>;
```

In `enterPrepared`, preflight account/ATM, repair if necessary, force-write a supplied quantity, verify the exact final state, perform one bounded repair on mismatch, verify again, and only then click.

```ts
if (!await this.adapter.verifyPreparedOrderState(group, account.tradovateLabel, account.atmPreset)) {
  await this.adapter.repairPreparedOrderState(group, account.tradovateLabel, account.atmPreset);
}
if (order.quantity != null) await this.adapter.setQuantity(order.quantity, true);
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
```

- [ ] **Step 4: Run focused worker tests and verify GREEN**

Run: `node --import tsx --test test/sessions.test.ts`

Expected: all session tests pass.

### Task 2: Implement real-browser cache invalidation and repair

**Files:**
- Modify: `src/browser.ts`
- Modify: `src/sessions.ts`
- Test: `test/quantity.browser.test.ts`

**Interfaces:**
- Consumes: the Task 1 adapter contract
- Produces: `TradovateBrowser.repairSequentialPreparedOrderState(label, atmPreset, quantity?)`

- [ ] **Step 1: Write a failing browser regression test**

Set the fake browser cache to the desired webhook quantity, manually change the fixture's visible quantity, call `setQuantity(desired, true)`, and assert the visible value is replaced with the desired value.

```ts
test("forced webhook quantity replaces a manual visible change despite a matching cache", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    await page.goto(fixture);
    const browser = fake(page);
    browser.lastQty = 3;
    await page.evaluate(() => {
      const input = document.querySelector("order-ticket")!.shadowRoot!
        .querySelector('input[aria-label="Order Qty"]') as HTMLInputElement;
      input.value = "9";
    });
    await browser.setQuantity(3, true);
    assert.equal(await qtyValue(page), "3");
  } finally {
    await chrome.close();
  }
});
```

- [ ] **Step 2: Run the focused browser test and verify RED**

Run: `$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'; node --import tsx --test --test-name-pattern "forced webhook quantity" test/quantity.browser.test.ts`

Expected: FAIL until the adapter and repair path forward the force flag and invalidate stale UI caches.

- [ ] **Step 3: Implement browser repair**

Add a bounded repair method that clears `currentAccount`, `lastPreset`, and `lastQty`, adopts or selects the real target account, applies the saved ATM with `force=true`, and writes the supplied quantity with `force=true`. Forward the new adapter calls through `TradovateSessionAdapter`; keep the proven dual-ticket safety block fail-closed.

```ts
async repairSequentialPreparedOrderState(label: string, atmPreset: string, quantity?: number): Promise<void> {
  this.currentAccount = null;
  this.lastPreset = null;
  this.lastQty = null;
  await this.armFor(label);
  if (atmPreset.trim()) await this.selectAtmPreset(atmPreset, true);
  if (quantity != null) await this.setQuantity(quantity, true);
}
```

- [ ] **Step 4: Run browser and session tests**

Run: `$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'; node --import tsx --test test/quantity.browser.test.ts test/sessions.test.ts`

Expected: all focused tests pass.

### Task 3: Verify, deploy, and publish

**Files:**
- Verify: `src/browser.ts`, `src/sessions.ts`, `test/quantity.browser.test.ts`, `test/sessions.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2
- Produces: deployed and pushed ATLAS v3 update

- [ ] **Step 1: Run static and full regression checks**

Run: `npx tsc --noEmit`

Run: `node --check public/app.js`

Run: `$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm test`

Expected: exit 0 with no failed tests.

- [ ] **Step 2: Deploy while preserving live state**

Copy only tracked source/test/document changes into the live v3 directory, preserve `.env`, `data`, browser sessions, logs, screenshots, and backups, restart only the localhost:3400 ATLAS process, and confirm Practice/Paused before any diagnostic.

- [ ] **Step 3: Run safe live diagnostics**

Use the existing no-order quantity test to prove Tradovate accepts an exact forced quantity write, then run the no-order position reader for funded and evaluations. Place no order and restore the desired prepared state.

- [ ] **Step 4: Commit and push**

Stage only the approved files, commit with a terse self-healing entry message, push `claude/tradestation-takeover-qowymb`, and verify the remote SHA equals local HEAD.
