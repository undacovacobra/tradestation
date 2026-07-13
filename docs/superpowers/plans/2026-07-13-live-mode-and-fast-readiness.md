# ATLAS Live Mode and Fast Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe dashboard-controlled live execution and reduce an armed webhook to dynamic quantity verification followed by a Buy/Sell click with measurable latency.

**Architecture:** Persist Practice/Live in the registry behind a confirmation API. Treat each saved login as one execution session with an exact armed signature containing account, bracket, cached balance, and preparation time; require and verify the strategy quantity supplied by every entry webhook. Independent sessions remain concurrent while shared-session conflicts are made explicit.

**Tech Stack:** TypeScript, Express, Playwright, Zod, Node test runner, browser JavaScript.

## Global Constraints

- Test webhooks never call an order-producing method or create open-trade state.
- An armed live webhook performs no account switch, ATM dialog work, balance read, or fixed wait; its only setup step is setting and verifying the dynamic webhook quantity.
- Practice remains the default and Live requires deliberate confirmation.
- One saved login is one execution session and can instantly prepare one lane at a time.
- Internal armed-entry target is under 500 ms; already-armed local test target is under 250 ms.

---

### Task 1: Persistent Practice/Live control

**Files:**
- Modify: `v4/src/registry.ts`
- Modify: `v4/src/server-v4.ts`
- Modify: `v4/public/index.html`
- Modify: `v4/public/app.js`
- Modify: `v4/public/style.css`
- Test: `v4/test/v4-registry.test.ts`
- Test: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Produces: `Registry.setMode(mode: "practice" | "live"): RegistryData`
- Produces: `POST /api/mode` with `{ mode, confirmLive }`

- [ ] Write failing registry and UI contract tests for mode persistence, confirmation, and visible Live warning.
- [ ] Run `npm test -- --test-name-pattern="mode|Live"` and confirm the new assertions fail.
- [ ] Implement `Registry.setMode`, the confirmed API, event logging, and the Practice/Live control.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Exact pre-armed execution session

**Files:**
- Modify: `v4/src/models.ts`
- Modify: `v4/src/workers.ts`
- Modify: `v4/src/coordinator.ts`
- Modify: `v4/src/browser.ts`
- Test: `v4/test/v4-entry-preparation.test.ts`
- Test: `v4/test/v4-coordinator.test.ts`

**Interfaces:**
- Extends: `ArmedSignature` with `quantity`, `entryBalance`, and `preparedAt`
- Produces: `ConnectionWorker.prearm(account, quantity)`
- Produces: `ConnectionWorker.enter(account, alert)` returning cached balance and timing data
- Produces: `ConnectionWorker.dryRun(account, quantity)` returning `alreadyArmed` and `elapsedMs`

- [ ] Replace existing fast-path expectations with failing tests proving pre-arm reads balance and prepares quantity once.
- [ ] Add failing tests proving armed entry calls only `enterPrepared`, while unarmed or quantity-mismatched live entry is blocked.
- [ ] Add a failing test proving an already-armed dry run performs no adapter calls.
- [ ] Run the focused entry and coordinator tests and confirm failure for the intended reasons.
- [ ] Implement exact signatures, cached balance, strict live readiness, and safe no-op tests.
- [ ] Remove immediate pre-order `readBalance` and `verifyPrepared` calls from the armed path.
- [ ] Reduce the order-click failure timeout and keep popup recovery outside successful-path waits.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Pool quantity, conflict visibility, and latency reporting

**Files:**
- Modify: `v4/src/models.ts`
- Modify: `v4/src/registry.ts`
- Modify: `v4/src/coordinator.ts`
- Modify: `v4/src/server-v4.ts`
- Modify: `v4/public/app.js`
- Modify: `v4/public/style.css`
- Test: `v4/test/v4-coordinator.test.ts`
- Test: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Extends: `PoolDefinition` with `quantity` defaulting to `1`
- Produces: `POST /api/pools/:id/quantity`
- Extends: pool status with an actionable readiness reason
- Extends: `TradeResult` with `timingMs`

- [ ] Write failing tests for quantity persistence, shared-session conflict messaging, and timing fields.
- [ ] Run the focused tests and confirm the new behavior is absent.
- [ ] Implement pool quantity editing and automatic idle re-arm.
- [ ] Add READY/NOT READY presentation, execution-session conflict copy, and test preparation duration.
- [ ] Record queue wait, click execution, and total request timing in results and Recent activity.
- [ ] Run the focused tests and confirm they pass.

### Task 4: Full verification, deployment, and publication

**Files:**
- Modify: `v4/README.md`
- Modify: `v4/SETUP-GUIDE.md`
- Deploy: live V4 installation while preserving `.env`, registry, balances, pool state, and sessions

**Interfaces:**
- Documents: one execution session per simultaneously tradable lane and Tradovate order confirmations disabled

- [ ] Update the operating guide with Live activation, readiness, duplicate-session setup, and latency interpretation.
- [ ] Run `npm test`, `npm run typecheck`, and `git diff --check` with zero failures.
- [ ] Verify both pools are flat before restarting the live installation.
- [ ] Deploy source and public assets without replacing user data or saved browser sessions.
- [ ] Verify the live dashboard mode control, readiness state, safe test result, and timing display.
- [ ] Commit the implementation and push `main`.
