# ATLAS Operations and Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brand V4 as ATLAS, make login/account and webhook-test state obvious, restore actionable Telegram alerts, repair additional-login onboarding, and guarantee account-specific ATM correctness for concurrent evaluation and funded signals.

**Architecture:** Keep one serialized `ConnectionWorker` per saved login and allow separate workers to run concurrently. Extend the worker adapter with a preparation-verification operation used by dry runs and immediately before order clicks, expose configured accounts with their connection status, and keep UI feedback local to the control that initiated it. Route lifecycle failures through the existing deduplicated Telegram notifier without coupling notification delivery to trading success.

**Tech Stack:** TypeScript, Node.js test runner, Express, Playwright, browser-side JavaScript, CSS.

## Global Constraints

- No broker order may be placed by automated verification.
- Existing `.env`, registry, pool state, balance history, and saved browser sessions must be preserved during deployment.
- Evaluation and funded pools may trade concurrently only when their execution lanes differ.
- Browser operations serialize within one saved login and run concurrently across different saved logins.
- A failed account, bracket, quantity, or login verification must abort before the order click.

---

### Task 1: Worker preparation verification and concurrency guarantees

**Files:**
- Modify: `v4/src/workers.ts`
- Modify: `v4/src/browser.ts`
- Modify: `v4/src/models.ts`
- Test: `v4/test/v4-entry-preparation.test.ts`
- Test: `v4/test/v4-coordinator.test.ts`

**Interfaces:**
- Produces: `ConnectionAdapter.verifyPrepared(account: AccountDefinition): Promise<void>`
- Produces: `ConnectionWorker.dryRun(account: AccountDefinition): Promise<void>`
- Preserves: `ConnectionWorker.enter(account, alert): Promise<number | null>` as one serialized critical section.

- [ ] **Step 1: Write failing worker tests**

Add tests proving an armed entry verifies the selected account and persisted bracket before quantity/order, a failed verification blocks the order, one worker never interleaves simultaneous entries with different brackets, and separate workers reach their adapter entry sections concurrently.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- test/v4-entry-preparation.test.ts test/v4-coordinator.test.ts`

Expected: FAIL because `verifyPrepared` and `dryRun` do not exist and the current fast path clicks without a final verification.

- [ ] **Step 3: Implement the minimal worker and browser verification path**

Add adapter verification that force-reads the selected platform label and ATM dollar fields, comparing both against the account signature. Make `dryRun` prepare and verify inside the worker queue without setting quantity or clicking an order. Keep account selection, balance read, preparation verification, quantity, and order click inside one `run` call.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- test/v4-entry-preparation.test.ts test/v4-coordinator.test.ts`

Expected: PASS with no order call after any verification failure.

### Task 2: End-to-end dry-run webhook and Telegram lifecycle coverage

**Files:**
- Modify: `v4/src/coordinator.ts`
- Modify: `v4/src/server-v4.ts`
- Modify: `v4/src/models.ts`
- Test: `v4/test/v4-coordinator.test.ts`
- Test: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Changes: test alerts call `worker.dryRun(account)` and return `placedTrade: false` semantics.
- Produces: actionable failure events and `notifyActionNeeded` calls at webhook, recovery, pre-arm, and lifecycle boundaries.
- Produces: close results may carry `won?: boolean` for confirmed-win notifications.

- [ ] **Step 1: Write failing coordinator and server-source tests**

Add a coordinator test showing a test webhook prepares/verifies the selected account but does not call quantity/order or open pool state. Add source assertions for action-needed notifications on live webhook failures and health recovery failures, plus confirmed-win good-news handling.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- test/v4-coordinator.test.ts test/v4-ui.test.ts`

Expected: FAIL because test alerts currently return before touching the worker and lifecycle notification coverage is incomplete.

- [ ] **Step 3: Implement dry-run and lifecycle notifications**

Route test alerts through `worker.dryRun`. In `server-v4.ts`, push actionable events and call the existing deduplicated notifier for live webhook failures, failed recovery/login, preparation failures, restart-with-open-state, and monitor failures. Send good news only for confirmed wins and target retirement. Telegram promise failures remain isolated inside `notify.ts`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- test/v4-coordinator.test.ts test/v4-ui.test.ts`

Expected: PASS.

### Task 3: ATLAS dashboard identity, login-account strip, and pool-local test feedback

**Files:**
- Modify: `v4/public/index.html`
- Modify: `v4/public/onboarding.html`
- Modify: `v4/public/app.js`
- Modify: `v4/public/style.css`
- Modify: `v4/src/server-v4.ts`
- Test: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Status connection objects include `accounts: Array<{ id, name, platformLabel, stage, status }>`.
- Each pool renders `id="test-result-<poolId>"` and a pool-specific test button.

- [ ] **Step 1: Write failing UI source tests**

Assert ATLAS branding, the account-session strip, escaped configured account labels, unique per-pool result IDs, explicit `SUCCESS`/`FAILED` text, and per-pool button disabling.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `npm test -- test/v4-ui.test.ts`

Expected: FAIL because the current dashboard has V4 branding, count-only connection cards, and one global test result.

- [ ] **Step 3: Implement the dashboard changes**

Brand both pages as ATLAS. Enrich status connection objects with configured account summaries. Render a top session strip that distinguishes configured accounts from the currently selected account. Render and update test state beneath the matching pool button without losing it during the five-second status refresh.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run: `npm test -- test/v4-ui.test.ts`

Expected: PASS.

### Task 4: Reliable Add another login workflow

**Files:**
- Modify: `v4/public/onboarding.html`
- Modify: `v4/public/onboarding.js`
- Modify: `v4/public/style.css`
- Modify: `v4/src/server-v4.ts`
- Test: `v4/test/v4-ui.test.ts`
- Test: `v4/test/v4-connections.test.ts`

**Interfaces:**
- Client toggles both `hidden` and `.is-open`, focuses `#login-name`, and prevents duplicate submits.
- POST `/api/connections` returns HTTP 400 with an actionable message when name or firm is empty.

- [ ] **Step 1: Write failing client and server validation tests**

Assert explicit panel visibility state, focus/scroll behavior, required-field checks, disabled in-flight save state, new-connection selection, and backend rejection of blank login metadata.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- test/v4-ui.test.ts test/v4-connections.test.ts`

Expected: FAIL because the current button only flips `hidden` and the server relies on schema failure after constructing the connection.

- [ ] **Step 3: Implement the login workflow fix**

Add deterministic panel visibility, progressive status messages, client validation, in-flight guarding, backend validation, selection of the newly created login, and clear Connect → Login/MFA → Scan instructions.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- test/v4-ui.test.ts test/v4-connections.test.ts`

Expected: PASS.

### Task 5: Full verification and deployment

**Files:**
- Modify as needed: `v4/README.md`, `v4/SETUP-GUIDE.md`
- Preserve while deploying: installed `.env`, registry/state/balance/session data.

**Interfaces:**
- Produces: verified ATLAS build at `http://localhost:3500`.

- [ ] **Step 1: Run complete automated verification**

Run: `npm test`

Expected: all tests pass.

Run: `npm run typecheck`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 2: Review the diff and repository state**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors and only intentional ATLAS files changed.

- [ ] **Step 3: Commit the implementation**

Commit the tested source, tests, and documentation with an ATLAS-focused message.

- [ ] **Step 4: Update the installed copy safely**

Copy application files into the installed V4 directory without overwriting `.env`, registry data, pool state, balance history, or saved browser sessions. Restart only after confirming no V4-recorded open trade.

- [ ] **Step 5: Verify the local HTTP and browser experience**

Confirm `/api/status`, the ATLAS header, connection-account strip, pool-local webhook result, and Add another login panel. Exercise only the no-order dry-run route. Do not send a TradingView signal or click a broker order.
