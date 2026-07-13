# Stage Bracket Defaults and Pre-Arming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply editable bracket defaults by account stage and pre-arm each newly selected next account before its webhook arrives.

**Architecture:** A shared bracket-default helper owns stage values and registry migration. Each connection worker owns one armed signature and exposes pre-arm/fast-entry methods. The coordinator triggers pre-arming after next-account changes and reports whether each pool's next account matches the connection's actual armed signature.

**Tech Stack:** TypeScript, Node.js, Express, Zod, browser JavaScript, Node test runner, Playwright.

## Global Constraints

- Evaluation default: $1,520 take profit and $1,000 stop loss per contract.
- Funded default: $4,000 take profit and $1,000 stop loss per contract.
- Preserve every valid positive custom bracket.
- Only one account can be armed per saved browser connection.
- Pre-arming must never click Buy, Sell, or Exit.
- Entry remains fail-closed when account or bracket preparation cannot be verified.

---

### Task 1: Shared defaults and registry migration

**Files:**
- Create: `v4/src/bracketDefaults.ts`
- Modify: `v4/src/registry.ts`
- Test: `v4/test/v4-registry.test.ts`

**Interfaces:**
- Produces: `bracketDefaults(stage: Stage): { targetPerContract: number; stopPerContract: number }`
- Produces: `isUnconfiguredBracket(account): boolean`

- [ ] **Step 1: Write failing registry tests** for new eval/funded defaults, `0/0` migration, and preservation of custom pairs.
- [ ] **Step 2: Run** `node --import ./test/setup-env.mjs --import tsx --test test/v4-registry.test.ts` and verify the new assertions fail with current `0/0` values.
- [ ] **Step 3: Implement the helper and migration.** Use exact constants `eval: {1520,1000}` and `funded: {4000,1000}`. In `Registry.load`, replace only parsed `0/0` pairs and atomically persist when any account changes. In `onboardAccount`, use defaults when the submitted pair is `0/0` or omitted.
- [ ] **Step 4: Run the focused registry tests** and verify they pass.
- [ ] **Step 5: Commit** `v4/src/bracketDefaults.ts`, `v4/src/registry.ts`, and `v4/test/v4-registry.test.ts` with message `Add stage bracket defaults`.

### Task 2: Editable onboarding defaults

**Files:**
- Modify: `v4/public/onboarding.js`
- Test: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Consumes: stage names `eval` and `funded` and server defaults `1520/1000`, `4000/1000`.
- Produces: `stageDefaults(stage)` and `wireStageDefaults(card)` browser helpers.

- [ ] **Step 1: Add failing UI source tests** asserting both stage pairs, a stage-change listener, and a custom-value guard appear in `onboarding.js`.
- [ ] **Step 2: Run** `node --import ./test/setup-env.mjs --import tsx --test test/v4-ui.test.ts` and verify failure.
- [ ] **Step 3: Implement form defaults.** New cards use stage defaults. Record the last auto-filled pair in card data attributes. On stage change, replace TP/SL only when current values still equal that recorded pair; otherwise preserve the user's edits.
- [ ] **Step 4: Run the focused UI tests** and verify pass.
- [ ] **Step 5: Commit** with message `Prefill brackets by account stage`.

### Task 3: Worker armed signature and fast entry

**Files:**
- Modify: `v4/src/models.ts`
- Modify: `v4/src/workers.ts`
- Test: `v4/test/v4-entry-preparation.test.ts`
- Test: `v4/test/v4-coordinator.test.ts`

**Interfaces:**
- Produces: `ArmedSignature { accountId, platformLabel, targetPerContract, stopPerContract, armedAt }`.
- Produces: `ConnectionAdapter.prepare(account): Promise<void>` which selects the account and sets its bracket without an order click.
- Produces: `ConnectionWorker.prearm(account): Promise<void>`, `ConnectionWorker.isArmed(account): boolean`, and armed fields in `status()`.

- [ ] **Step 1: Write failing worker tests** proving pre-arm calls switch then bracket but never quantity/order, a matching signature skips switch/bracket on entry, and a stale signature uses the full preparation path.
- [ ] **Step 2: Run the focused entry/coordinator tests** and verify failure.
- [ ] **Step 3: Implement adapter preparation and worker signature tracking.** Clear the signature before connect/recover/disconnect and before any task that changes selection outside the matching fast path. Record it only after switch and bracket both succeed. Entry with a matching signature sets quantity and clicks order; otherwise it performs full preparation, records the signature, and then enters.
- [ ] **Step 4: Run focused tests** and verify pass.
- [ ] **Step 5: Commit** with message `Add connection pre-arming`.

### Task 4: Coordinator triggers and armed status

**Files:**
- Modify: `v4/src/coordinator.ts`
- Modify: `v4/src/server-v4.ts`
- Test: `v4/test/v4-coordinator.test.ts`

**Interfaces:**
- Produces: `TradeCoordinator.prearmPool(poolId): Promise<void>`.
- Changes: `setNext`, `skipToday`, `resumeToday`, and post-close advancement return promises and pre-arm the resulting next account.
- Produces: pool status fields `armed`, `armedAccountId`, and `prearmError`.

- [ ] **Step 1: Write failing coordinator tests** for Make Next pre-arm, post-close pre-arm, separate connections, same-connection last-arm-wins, and fail-closed error status.
- [ ] **Step 2: Run coordinator tests** and verify failure.
- [ ] **Step 3: Implement `prearmPool`.** Select the eligible next account after rotation changes, require a connected/logged-in worker for real browser actions, queue `worker.prearm(account)`, and store a pool-specific error without advancing rotation or placing an order.
- [ ] **Step 4: Make the account-action route await coordinator actions.** After Connect succeeds, pre-arm every enabled pool whose next account uses that connection, sequentially so status reflects the one account actually armed.
- [ ] **Step 5: Run coordinator tests** and verify pass.
- [ ] **Step 6: Commit** with message `Prearm next accounts before webhooks`.

### Task 5: Visual armed state and warning

**Files:**
- Modify: `v4/public/app.js`
- Test: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Consumes: pool status `armed`, `armedAccountId`, and `prearmError`.

- [ ] **Step 1: Write failing UI tests** for `Armed`, `Pre-arm failed`, and the warning that manual Tradovate account/ATM changes require Make Next again.
- [ ] **Step 2: Run UI tests** and verify failure.
- [ ] **Step 3: Render armed state** beside the next account. Show the error text when present and the manual-change warning once in the Control Center.
- [ ] **Step 4: Run UI tests** and verify pass.
- [ ] **Step 5: Commit** with message `Show prearm readiness`.

### Task 6: Full verification and local deployment

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Run** `npm.cmd run typecheck` in `v4` and require exit code 0.
- [ ] **Step 2: Run** `$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm.cmd test` and require zero failures.
- [ ] **Step 3: Back up installed `v4/data/registry.json` and `balances.json` before updating the installed copy.
- [ ] **Step 4: Fast-forward the installed local repository to the completed branch, restart V4, and verify `/health` and `/api/status`.
- [ ] **Step 5: Confirm existing `0/0` accounts now show their correct stage defaults while any custom pairs remain unchanged.
- [ ] **Step 6: Reload `http://localhost:3500/` in the in-app browser and keep it open as the deliverable tab.

