# V4 Bracket, Balance, Removal, and Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make V4 persist exact Tradovate ATM values, permanently delete removed accounts, refresh every remaining balance despite individual failures, and display copyable full webhook URLs.

**Architecture:** Tradovate ATM field resolution will use visible row geometry and post-Save read-back verification. Registry and balance storage will expose explicit deletion operations. Balance refresh will isolate failures per account, while the dashboard constructs webhook URLs from its actual origin.

**Tech Stack:** TypeScript, Node.js, Express, Playwright, browser JavaScript, Node test runner.

## Global Constraints

- ATM mismatches fail closed and never mark an account Armed.
- Account removal is global and remains blocked for open trades.
- One failed balance read never prevents later accounts from refreshing.
- Webhook secrets never appear in displayed URLs.
- Every behavior change follows a failing-test-first cycle.

---

### Task 1: Exact ATM row selection and persisted verification

**Files:**
- Modify: `v4/src/browser.ts`
- Modify: `v4/test/fixtures/mock-atm.html`
- Modify: `v4/test/bracket.browser.test.ts`

**Interfaces:**
- Produces: `setDialogNumber(labelRe, value)` resolving the input aligned with the label.
- Produces: `readDialogNumber(labelRe): Promise<number | null>`.
- Changes: `setBracket` reopens and verifies saved TP/SL before caching `lastBracket`.

- [ ] **Step 1: Write failing browser tests.** Change the fixture to separate label and input columns, add a Save handler that persists React-like state, and add a clamp mode that changes the persisted TP after Save. Assert `setBracket(1520, 1000)` saves distinct fields and assert clamp mode rejects with a persisted mismatch.
- [ ] **Step 2: Run** `node --import ./test/setup-env.mjs --import tsx --test test/bracket.browser.test.ts` and confirm the distinct-field or persisted-mismatch assertion fails.
- [ ] **Step 3: Implement row-aligned field resolution.** In the page evaluation, collect visible inputs and choose the one with the smallest vertical-center distance to the matched label, requiring a reasonable row tolerance. Reuse the same resolver to read persisted values.
- [ ] **Step 4: After Save, reopen the dialog, read both values, close with Cancel, and throw unless both exactly equal the requested rounded values.** Set `lastBracket` only after this succeeds.
- [ ] **Step 5: Run the focused browser test and typecheck; require pass.**
- [ ] **Step 6: Commit** with message `Fix live ATM value persistence`.

### Task 2: Permanent account and balance deletion

**Files:**
- Modify: `v4/src/registry.ts`
- Modify: `v4/src/balances.ts`
- Modify: `v4/src/server-v4.ts`
- Modify: `v4/test/v4-registry.test.ts`
- Modify: `v4/test/balances.test.ts`

**Interfaces:**
- Produces: `Registry.removeAccount(accountId): AccountDefinition` removing the account from all pools and the registry.
- Produces: `BalanceLog.remove(accountId): void` removing cached balance/history.

- [ ] **Step 1: Write failing tests** proving global registry removal clears every pool and proving balance removal persists after reload.
- [ ] **Step 2: Run the two focused test files and confirm the new tests fail because the methods do not exist.**
- [ ] **Step 3: Implement the two removal methods atomically using the existing save paths.**
- [ ] **Step 4: Change the server `remove` action to call both methods after its open-trade guard.**
- [ ] **Step 5: Run focused tests and typecheck; require pass.**
- [ ] **Step 6: Commit** with message `Delete removed accounts completely`.

### Task 3: Resilient full balance refresh

**Files:**
- Modify: `v4/src/coordinator.ts`
- Modify: `v4/public/app.js`
- Modify: `v4/test/v4-coordinator.test.ts`
- Modify: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Changes: refresh results include `accountErrors: Array<{ accountId, platformLabel, error }>`.
- Consumes: pool account IDs as the authoritative refresh set.

- [ ] **Step 1: Write a failing coordinator test** with three pool accounts where the middle adapter read throws; assert the first and third balances are saved and the middle error is returned.
- [ ] **Step 2: Run the coordinator test and confirm current refresh stops after the middle account.**
- [ ] **Step 3: Build the per-connection refresh list from enabled accounts referenced by a pool, wrap each account read in its own try/catch, and continue.**
- [ ] **Step 4: Update the dashboard summary to list failed platform labels while retaining updated/not-updated counts.**
- [ ] **Step 5: Run coordinator and UI tests plus typecheck; require pass.**
- [ ] **Step 6: Commit** with message `Refresh balances past account failures`.

### Task 4: Full copyable pool webhook URLs and deletion copy

**Files:**
- Modify: `v4/public/app.js`
- Modify: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Produces: `poolWebhookUrl(poolId)` using `new URL('/webhook/' + poolId, window.location.origin).href`.
- Produces: `copyWebhook(poolId)` copying the exact rendered URL.

- [ ] **Step 1: Write failing UI source tests** for the origin-based URL helper, Clipboard API, Copy webhook text, Delete account text, and permanent-deletion confirmation.
- [ ] **Step 2: Run the UI test and confirm it fails.**
- [ ] **Step 3: Render the URL beneath the execution lane, add the copy button and result feedback, and rename the removal control to Delete account.**
- [ ] **Step 4: Run UI tests and typecheck; require pass.**
- [ ] **Step 5: Commit** with message `Show copyable pool webhooks`.

### Task 5: Full verification and deployment

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Run** `npm.cmd run typecheck` in `v4` and require exit code 0.
- [ ] **Step 2: Run** `$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm.cmd test` and require zero failures.
- [ ] **Step 3: Merge the verified branch into local `main`, rerun the full verification on merged main, and push `main` to GitHub.**
- [ ] **Step 4: Back up the installed `.env` and `v4/data`, fast-forward the installed copy, and restart port 3500.**
- [ ] **Step 5: Verify live status contains only the eight remaining accounts, run Refresh balances once, and require later accounts to update even if one read fails.**
- [ ] **Step 6: Use the no-trade bracket endpoint with 1520/1000, reopen the live ATM dialog, and visually confirm both persisted values exactly.**
- [ ] **Step 7: Reload the V4 Control Center and keep it open on the updated pool/webhook display.**

