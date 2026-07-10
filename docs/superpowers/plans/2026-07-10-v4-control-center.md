# V4 Control Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a visual V4 Control Center with dynamic Tradovate logins, ordered cross-login pool management, last-known balances, and evaluation-only automatic close at $53,000.

**Architecture:** A dynamic `ConnectionManager` replaces the startup-only worker map. Registry mutations persist connections and account order atomically; the coordinator owns pool state and consumes a persisted balance log. A target monitor reads only an open trade's selected account, while manual sweeps operate only on flat logins.

**Tech Stack:** TypeScript, Node.js, Express, Zod, Playwright/Chromium, native Node test runner, browser-native HTML/CSS/JavaScript.

## Global Constraints

- Keep V2 and V3 untouched.
- Support Tradovate logins only in this release; preserve the adapter boundary for TopstepX.
- External webhooks remain secret-protected; direct-loopback administration remains trusted.
- Evaluation pool target is exactly `53000`; funded pool has no target.
- Never switch an open-trade login to another account for maintenance.
- Never advance pool state after a failed close.
- Preserve the user's `.env`, eight scanned evaluation accounts, pool order, and session folders.

---

### Task 1: Registry model and dynamic connection lifecycle

**Files:**
- Modify: `v4/src/models.ts`
- Modify: `v4/src/registry.ts`
- Create: `v4/src/connectionManager.ts`
- Modify: `v4/src/workers.ts`
- Test: `v4/test/v4-registry.test.ts`
- Create: `v4/test/v4-connections.test.ts`

**Interfaces:**
- Produces: `PoolDefinition.balanceTarget?: number`, `Registry.addConnection`, `Registry.removeConnection`, pool/account mutation methods, and `ConnectionManager.get/add/remove/values`.

- [ ] Write failing tests proving a connection can be added and persisted, duplicate IDs are rejected, referenced connections cannot be removed, and a manager makes a new worker available without restart.
- [ ] Run `npm.cmd test -- --test-name-pattern="connection|pool order|account status"`; expect failures for missing APIs.
- [ ] Add `balanceTarget`, registry mutations, `createWorker(definition)`, and `ConnectionManager` with one worker queue per login.
- [ ] Re-run the focused tests; expect all selected tests to pass.
- [ ] Commit the task files with message `Add dynamic V4 connection management`.

### Task 2: Balance persistence and adapter capabilities

**Files:**
- Modify: `v4/src/balances.ts`
- Modify: `v4/src/workers.ts`
- Modify: `v4/src/models.ts`
- Test: `v4/test/balances.test.ts`
- Modify: `v4/test/v4-coordinator.test.ts`

**Interfaces:**
- Produces: `ConnectionAdapter.readBalance(account)`, `readSelectedBalance()`, `readSettledBalance(account)`, and account-ID-keyed `BalanceLog` records.

- [ ] Write failing tests for account-ID balance persistence, bounded history, and coordinator entry/close balance capture.
- [ ] Run the focused balance/coordinator tests and verify expected failures.
- [ ] Implement Tradovate balance reads through the serialized worker; simulated adapters return `null`.
- [ ] Store `entryBalance` on the open trade and settled balances after close without changing pool state when a close throws.
- [ ] Re-run focused tests; expect all selected tests to pass.
- [ ] Commit with message `Add V4 balance lifecycle`.

### Task 3: Evaluation target monitor and safe refresh

**Files:**
- Modify: `v4/src/coordinator.ts`
- Create: `v4/src/targetMonitor.ts`
- Modify: `v4/src/server-v4.ts`
- Modify: `v4/src/notify.ts`
- Modify: `v4/test/v4-coordinator.test.ts`

**Interfaces:**
- Produces: `TradeCoordinator.monitorBalanceTargets()`, `refreshBalances()`, and `TargetMonitor.start/stop`.

- [ ] Write failing tests for close at `53000` and above, no close below target, no funded close, no maintenance switch on a trading login, and failed-close state preservation.
- [ ] Run the selected tests and verify failures are caused by missing target behavior.
- [ ] Implement target checks through pool queues and login workers. On success mark the evaluation account passed; on failure preserve open state and notify.
- [ ] Add a non-overlapping monitor interval using `MONITOR_ACTIVE_SECONDS`.
- [ ] Re-run selected tests; expect all to pass.
- [ ] Commit with message `Add evaluation balance target monitor`.

### Task 4: Local administration and detailed status API

**Files:**
- Modify: `v4/src/server-v4.ts`
- Modify: `v4/src/events.ts`
- Modify: `v4/src/coordinator.ts`
- Test: `v4/test/v4-registry.test.ts`

**Interfaces:**
- Produces endpoints for connections, balance refresh, account order/status/pool membership, set-next, detailed status, and recent events.

- [ ] Write failing registry/coordinator tests for set-next, reorder, hold/reactivate, mark-passed, and pool removal.
- [ ] Run focused tests; expect missing-method failures.
- [ ] Implement mutations with open-trade safety checks and presentation-ready status data.
- [ ] Add loopback-admin endpoints while leaving `/webhook` and `/webhook/:poolId` authentication unchanged.
- [ ] Run focused tests and `npm.cmd run typecheck`; expect success.
- [ ] Commit with message `Add V4 Control Center API`.

### Task 5: Unlimited-login onboarding UI

**Files:**
- Modify: `v4/public/onboarding.html`
- Modify: `v4/public/onboarding.js`
- Modify: `v4/public/style.css`

**Interfaces:**
- Consumes: connection creation and existing connect/scan/onboard endpoints.
- Produces: Add Login wizard and live connection selector refresh.

- [ ] Add a hidden Add Login form with name, firm, Tradovate environment, pattern, and auto-connect inputs.
- [ ] Submit locally, refresh the selector, select the new login, and expose Open Browser and Scan actions.
- [ ] Add clear success, validation, login-required, and scan-empty states.
- [ ] Run typecheck and an HTTP/static-page smoke test.
- [ ] Commit with message `Add unlimited Tradovate login onboarding`.

### Task 6: Visual Control Center

**Files:**
- Replace: `v4/public/index.html`
- Replace: `v4/public/app.js`
- Modify: `v4/public/style.css`

**Interfaces:**
- Consumes: detailed `/api/status` and local account/pool/refresh endpoints.
- Produces: approved layout A with connection rail, pool summaries, ordered table, balances, target progress, controls, and activity.

- [ ] Build the connection rail and top summary using status data.
- [ ] Build pool selection and the ordered account table with a clear NEXT row and last-known timestamps.
- [ ] Wire refresh balances, set-next, move, hold/reactivate, mark-passed, and remove-from-pool actions with confirmations where destructive.
- [ ] Show open positions, webhook/lane configuration, errors, and recent activity without exposing secrets.
- [ ] Verify responsive behavior at desktop and narrow widths in Chromium.
- [ ] Commit with message `Build V4 visual Control Center`.

### Task 7: Migration, documentation, and complete verification

**Files:**
- Modify: `v4/data/registry.json`
- Modify: `v4/README.md`
- Modify: `v4/.env.example`

**Interfaces:**
- Produces: evaluation `balanceTarget: 53000`, funded target absent, usage documentation, and safe local migration.

- [ ] Add the target to the sample evaluation pool and document the login wizard, target behavior, last-known balances, and safety rules.
- [ ] Run `npm.cmd run typecheck`; expect exit 0.
- [ ] Run `npm.cmd test`; expect every runnable test to pass, with browser-only skips reported explicitly.
- [ ] Run `git diff --check`; expect no errors.
- [ ] Start V4 with the user's preserved registry, verify `/health`, `/api/status`, onboarding, and Control Center over HTTP.
- [ ] Inspect both pages in the in-app browser and confirm no secret input, all eight evaluation accounts, target `53000`, and funded target off.
- [ ] Commit, push `agent/tradestation-v4`, update draft PR #2, migrate the downloaded copy, and restart its hidden server.
