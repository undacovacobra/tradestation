# Fast Entry Post-Fill OCO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Fast Entry mode that fires the verified webhook quantity first and then creates and verifies linked OCO protection for the filled Tradovate position.

**Architecture:** Keep standard pre-armed ATM execution unchanged. Add pure instrument price planning, persisted protection lifecycle state, a fast-ready worker path, and a browser adapter that performs the uninterrupted Tradovate DOM OCO-one-time sequence. Coordinator background work owns protection and restart recovery.

**Tech Stack:** TypeScript, Node.js, Express, Playwright, Zod, Node test runner, vanilla browser JavaScript.

## Global Constraints

- Standard mode remains the default.
- Test webhooks never place orders.
- Fast Entry supports MNQ, NQ, MES, and ES only.
- Unsupported symbols are blocked before a market click.
- A partially-created OCO is never blindly duplicated.
- Broker position state remains authoritative for trade closure.

---

### Task 1: Instrument and Persistence Contracts

**Files:**
- Create: `v4/src/ocoPlan.ts`
- Modify: `v4/src/models.ts`
- Modify: `v4/src/registry.ts`
- Test: `v4/test/oco-plan.test.ts`
- Test: `v4/test/v4-registry.test.ts`

**Interfaces:**
- Produces: `planOcoPrices(symbol, action, entryPrice, targetDollars, stopDollars): OcoPricePlan`
- Produces: `Registry.executionStyle` and `Registry.setExecutionStyle(style)`
- Produces: open-trade protection fields `protectionState`, `protectionUpdatedAt`, and `protectionError`

- [ ] **Step 1: Write failing tests** for registry default/persistence and exact long/short MNQ/NQ/MES/ES price calculations, including outward tick rounding and unsupported symbols.
- [ ] **Step 2: Run** `npm.cmd test -- --test-name-pattern="OCO price|execution style"` and confirm failures are caused by missing contracts.
- [ ] **Step 3: Implement** the four explicit instrument profiles, price planning, Zod execution-style default, registry setter/getter, and protection state types.
- [ ] **Step 4: Run the focused tests** and `npm.cmd run typecheck`; expect exit code 0.
- [ ] **Step 5: Commit** with message `Add fast entry persistence and OCO price planning`.

### Task 2: Fast-Ready Entry Worker

**Files:**
- Modify: `v4/src/workers.ts`
- Modify: `v4/src/browser.ts`
- Test: `v4/test/v4-entry-preparation.test.ts`

**Interfaces:**
- Consumes: `Registry.executionStyle`
- Produces: `ConnectionAdapter.prepareFast(account)`, `protectOpenPosition(account, alert): Promise<ProtectionReceipt>`, `ConnectionWorker.prearmFast(account)`, and `ConnectionWorker.enterFast(account, alert)`

- [ ] **Step 1: Write failing tests** proving fast preparation selects the account and disables ATM without calling `setBracket`, and proving fast entry only sets quantity and clicks the order.
- [ ] **Step 2: Run** `npm.cmd test -- --test-name-pattern="fast preparation|fast entry"` and confirm the missing methods fail.
- [ ] **Step 3: Implement** distinct fast-ready signatures, browser ATM-off verification, and the fast entry worker path while leaving standard methods unchanged.
- [ ] **Step 4: Run focused tests and typecheck**; expect exit code 0.
- [ ] **Step 5: Commit** with message `Add fast-ready entry worker path`.

### Task 3: Post-Fill Protection Lifecycle

**Files:**
- Modify: `v4/src/poolRotation.ts`
- Modify: `v4/src/coordinator.ts`
- Modify: `v4/src/server-v4.ts`
- Test: `v4/test/v4-coordinator.test.ts`

**Interfaces:**
- Consumes: `ConnectionWorker.enterFast` and `ConnectionAdapter.protectOpenPosition`
- Produces: `PoolRotation.markProtection(state, error?)` and `TradeCoordinator.recoverProtection()`

- [ ] **Step 1: Write failing tests** proving entry returns after the click with persisted `pending`, protection runs later, success marks `protected`, failure marks `failed`, and the rotation remains locked.
- [ ] **Step 2: Run** `npm.cmd test -- --test-name-pattern="post-fill protection|pending protection|failed protection"` and verify expected failures.
- [ ] **Step 3: Implement** asynchronous per-worker protection scheduling, lifecycle persistence, startup reconciliation, and Telegram/action events for failures.
- [ ] **Step 4: Run focused tests and typecheck**; expect exit code 0.
- [ ] **Step 5: Commit** with message `Track and recover post-fill OCO protection`.

### Task 4: Tradovate DOM OCO-one-time Automation

**Files:**
- Modify: `v4/src/browser.ts`
- Create: `v4/test/fixtures/mock-dom-oco.html`
- Create: `v4/test/oco.browser.test.ts`

**Interfaces:**
- Consumes: `OcoPricePlan` and the absolute broker position
- Produces: `TradovateBrowser.protectOpenPosition(...)` returning verified order identifiers, prices, quantity, and elapsed time

- [ ] **Step 1: Create a failing browser fixture test** for OCO-one-time selection, exact side/price row dispatch, left TP click followed by right SL click, and shared OCO verification.
- [ ] **Step 2: Run** `npm.cmd test -- --test-name-pattern="OCO-one-time"`; expect failure before implementation or an explicit no-Chromium skip plus passing pure selector tests.
- [ ] **Step 3: Implement** DOM discovery, position/entry-price reading, exact quantity verification, uninterrupted OCO sequence, working-order inspection, and one safe retry only when zero protective orders exist.
- [ ] **Step 4: Run browser/pure tests and typecheck**; expect exit code 0.
- [ ] **Step 5: Commit** with message `Automate post-fill Tradovate OCO protection`.

### Task 5: Dashboard Controls and Status

**Files:**
- Modify: `v4/public/index.html`
- Modify: `v4/public/app.js`
- Modify: `v4/public/style.css`
- Modify: `v4/src/server-v4.ts`
- Test: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Consumes: status `executionStyle` and open-trade protection fields
- Produces: `POST /api/execution-style` and visible Standard/Fast Entry controls

- [ ] **Step 1: Write failing UI/source tests** for the selector, confirmation warning, `Protecting...`, `Protected`, and `Protection failed` states.
- [ ] **Step 2: Run** `npm.cmd test -- --test-name-pattern="Fast Entry|Protecting|execution style"` and verify expected failures.
- [ ] **Step 3: Implement** the endpoint, persistent selector, readiness copy, protection badges, and separate entry/protection activity timing.
- [ ] **Step 4: Run focused tests and typecheck**; expect exit code 0.
- [ ] **Step 5: Commit** with message `Expose Fast Entry controls and protection status`.

### Task 6: Full Verification and Deployment

**Files:**
- Modify only files required by failures found in verification.

**Interfaces:**
- Consumes: all prior tasks
- Produces: deployed local ATLAS build and updated `main`

- [ ] **Step 1: Run** `npm.cmd test` and confirm zero failures.
- [ ] **Step 2: Run** `npm.cmd run typecheck` and confirm exit code 0.
- [ ] **Step 3: Run** `git diff --check` and inspect `git status --short`.
- [ ] **Step 4: Confirm live pools are flat, copy V4 while preserving `.env`, `data`, `.sessions`, and `node_modules`, then restart the local service.
- [ ] **Step 5: Verify `/health`, `/api/status`, Standard/Fast Entry UI, and a no-order test webhook. Do not place a live or evaluation trade during verification.
- [ ] **Step 6: Push the verified commits to `origin/main` and leave the refreshed dashboard open.
