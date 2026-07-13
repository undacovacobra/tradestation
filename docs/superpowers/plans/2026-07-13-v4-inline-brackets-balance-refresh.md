# V4 Inline Brackets and Balance Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every account's dollar bracket directly editable on the V4 dashboard, fail closed when it is unconfigured, safely locate Tradovate's unlabeled ATM gear, and make balance refresh visible and reliable.

**Architecture:** Keep bracket values in the existing account registry and add a narrow bracket-only API so dashboard edits cannot accidentally change pool membership. Entry preparation remains serialized per login and rejects an unconfigured account before touching Tradovate. Browser selection uses visible, row-anchored controls; balance refresh returns a structured per-login summary rendered by the dashboard.

**Tech Stack:** TypeScript, Node.js, Express, Zod, Playwright, static HTML/CSS/JavaScript, Node test runner.

## Global Constraints

- Clicking `Make next` changes only the rotation pointer; Tradovate is changed only during a real entry webhook.
- Every real entry requires positive TP and SL dollars per contract; `0/0` is unconfigured and blocks the order.
- Never click Buy/Sell after bracket preparation fails.
- The unlabeled ATM gear fallback must be anchored to the visible `ATM` row and must not click the `DAY/GTC` gear.
- Dashboard bracket edits are rejected while the account has an open trade.
- Preserve registry, balances, `.env`, pool state, and browser sessions during deployment.

---

### Task 1: Fail closed on unconfigured accounts

**Files:**
- Modify: `v4/src/workers.ts`
- Test: `v4/test/v4-entry-preparation.test.ts`

**Interfaces:**
- Consumes: `AccountDefinition.targetPerContract`, `AccountDefinition.stopPerContract`
- Guarantees: `prepareEntry(...)` throws before `switchAccount` when either value is not positive.

- [ ] Add a failing test that calls `prepareEntry` with `0/0`, expects `/configure.*take profit.*stop loss/i`, and asserts no browser method was called.
- [ ] Run `node --import ./test/setup-env.mjs --import tsx --test test/v4-entry-preparation.test.ts` and confirm RED because legacy entry behavior currently proceeds.
- [ ] Replace the zero-bracket legacy branch with an early descriptive throw, then keep the existing order `switchAccount -> setBracket -> setQuantity -> clickOrder`.
- [ ] Re-run the focused test and confirm GREEN.

### Task 2: Locate the unlabeled ATM gear safely

**Files:**
- Modify: `v4/test/fixtures/mock-atm.html`
- Modify: `v4/test/bracket.browser.test.ts`
- Modify: `v4/src/browser.ts`

**Interfaces:**
- Extends: `TradovateBrowser.openAtmSettings(): Promise<void>`
- Guarantees: the fallback marks and clicks only the nearest icon-only control to the right of an exact visible `ATM` label on the same row.

- [ ] Change the fixture so the ATM settings button has no title/ARIA/class hint, add an exact `ATM` label plus dropdown, and add a separate `DAY/GTC` decoy gear that increments `window.dayGearClicks`.
- [ ] Extend the browser test to assert `setBracket(1500, 1000, true)` opens/saves the dialog and `dayGearClicks === 0`; run it and confirm RED when Chromium is available.
- [ ] Add a read-only DOM search in `openAtmSettings` that finds the exact visible `ATM` label, climbs bounded ancestors, filters visible icon-only buttons aligned to the right, excludes order-action text, marks the closest safe candidate, clicks it, and immediately verifies `ATM Settings`.
- [ ] Re-run the focused browser test (or retain the existing no-Chromium skip) and run `npm.cmd run typecheck`.

### Task 3: Add bracket-only account API and inline controls

**Files:**
- Modify: `v4/src/registry.ts`
- Modify: `v4/src/server-v4.ts`
- Modify: `v4/public/app.js`
- Modify: `v4/public/style.css`
- Modify: `v4/test/v4-registry.test.ts`
- Modify: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Produces: `Registry.updateAccountBracket(id, targetPerContract, stopPerContract): AccountDefinition`
- Produces: `POST /api/accounts/:accountId/bracket`
- Produces: `saveBracket(accountId)` in the dashboard.

- [ ] Add failing registry tests proving bracket-only updates preserve name, firm, stage, connection, label, and pool membership while one-sided values are rejected.
- [ ] Add failing UI contract assertions for `TP $`, `SL $`, `Save bracket`, `/api/accounts/${accountId}/bracket`, and an `Unconfigured - trade blocked` status.
- [ ] Implement `updateAccountBracket` by parsing `{...current, targetPerContract, stopPerContract}` and saving without touching pools.
- [ ] Add the authenticated route; reject open-trade accounts through `coordinator.hasOpenTradeForAccount` and return the updated account.
- [ ] Render two compact number inputs and a save button per account; show configured dollars or the blocked warning; refresh status after success.
- [ ] Add `.bracket-controls` styles with compact widths and clear disabled/unconfigured colors.
- [ ] Run the focused registry/UI tests and typecheck; confirm GREEN.

### Task 4: Fix visible account selection and refresh feedback

**Files:**
- Modify: `v4/src/browser.ts`
- Modify: `v4/public/app.js`
- Modify: `v4/test/v4-ui.test.ts`
- Modify: `v4/test/fixtures/mock-tradovate.html`
- Modify: `v4/test/browser.test.ts`

**Interfaces:**
- Guarantees: `switchAccount(label)` clicks a visible exact menu entry, never a hidden duplicate.
- Produces: `summarizeBalanceRefresh(results)` returning a reader-facing summary.

- [ ] Add a browser fixture/test with hidden and visible duplicate account labels and assert only the visible item is clicked.
- [ ] Add a failing UI contract test requiring the refresh button to disable during work and render updated, deferred, and failed counts plus the first error.
- [ ] Replace `.getByText(label).last()` with an exact visible locator and preserve the existing failure screenshot/error behavior.
- [ ] Implement `summarizeBalanceRefresh`, bypass generic `post()` for this button, disable it during the request, and render a specific result before refreshing the dashboard.
- [ ] Run focused browser/UI tests and typecheck; confirm GREEN.

### Task 5: Verify, merge, deploy, and show

**Files:**
- Verify: all `v4` source and tests
- Deploy: `C:/Users/TheTr/Downloads/tradestation-v4-latest`

- [ ] Run `npm.cmd run typecheck`, `npm.cmd test`, and `git diff --check`; require zero failures.
- [ ] Commit implementation, merge into local `main`, and repeat typecheck/tests on the merge result.
- [ ] Back up the installed registry and balances, stop only the Node process listening on port 3500, fast-forward from local main, restore live data, and restart V4 hidden.
- [ ] Verify `/api/status` still reports 10 accounts and 2 pools, with all zero-bracket accounts visibly unconfigured.
- [ ] Refresh the in-app dashboard, verify inline TP/SL controls and balance-refresh feedback in the DOM, and leave the dashboard open as the deliverable.
