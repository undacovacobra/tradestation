# ATLAS Broker-Position Reconciliation Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the verified Tradovate account ticket's numeric `POSITION` field authoritative for whether a live trade is open, automatically reconcile ATM/liquidation/external exits, and keep all execution clicks on the existing fast path.

**Architecture:** Add a fail-safe broker-position model and DOM detector at the browser boundary, expose it through the credential worker's serialized maintenance queue, and add an idempotent two-reading reconciler used by the server monitor and close-webhook flow. Persisted rotation remains the source of ATLAS intent; broker position becomes the source of actual open/flat truth. Practice mode remains simulated.

**Tech Stack:** TypeScript, Node.js, Express, Playwright, Node test runner, existing ATLAS rotation/session/dispatcher modules.

---

## Task 1: Add the broker-position model and parser

**Files:**
- Create: `src/brokerPosition.ts`
- Create: `test/brokerPosition.test.ts`

**Step 1: Write failing parser tests**

Cover `0`, `1`, `+1`, `-1`, comma formatting, whitespace, unrelated currency text, missing values, and ambiguous multiple candidates. Require explicit `unknown` instead of coercing malformed input to zero.

**Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test test/brokerPosition.test.ts`

Expected: failure because the module/functions do not exist.

**Step 3: Implement the minimal typed model and parser**

Define:

```ts
type BrokerPosition =
  | { status: "open"; netPosition: number; checkedAt: string }
  | { status: "flat"; checkedAt: string }
  | { status: "unknown"; reason: string; checkedAt: string };
```

Keep numeric parsing pure and independent from browser DOM traversal.

**Step 4: Run focused tests and verify GREEN**

Run: `node --import tsx --test test/brokerPosition.test.ts`

**Step 5: Commit checkpoint if a Git repository is available**

```bash
git add src/brokerPosition.ts test/brokerPosition.test.ts
git commit -m "feat: add fail-safe broker position model"
```

If this workspace is not a usable Git repository, record that and continue without manufacturing repository state.

## Task 2: Calibrate the Tradovate `POSITION` DOM detector

**Files:**
- Create: `test/fixtures/mock-position.html`
- Create: `test/position.browser.test.ts`
- Modify: `src/browser.ts`

**Step 1: Create a fixture matching the observed Tradovate ticket**

Include the calibrated flat shape (`POSITION`, `0`, `-.-- USD`) and fixture controls that switch to nonzero long and short values, missing label/value, duplicate ticket, and malformed value.

**Step 2: Write failing Chrome-backed detector tests**

Assert:

- `POSITION 0` returns flat.
- `POSITION 2` and `POSITION -3` return open with the correct signed quantity.
- `OPEN P/L 0.00` cannot independently produce flat.
- Missing, malformed, hidden, or ambiguous position displays return unknown.
- The detector uses the smallest visible ticket container and does not scrape an unrelated position value elsewhere on the page.

**Step 3: Run the focused browser test and verify RED**

Run: `node --import tsx --test test/position.browser.test.ts`

**Step 4: Implement `TradovateBrowser.readSelectedPosition()`**

Use one bounded in-page traversal. Locate visible text whose normalized content is exactly `POSITION`, inspect the smallest visible ancestor containing one unambiguous signed numeric value associated with that field, and pass the extracted string to the pure parser. Never infer flat from absence.

**Step 5: Run focused tests and verify GREEN**

Run: `node --import tsx --test test/position.browser.test.ts`

## Task 3: Expose account-verified position reads through credential workers

**Files:**
- Modify: `src/sessions.ts`
- Modify: `test/sessions.test.ts`

**Step 1: Add failing worker tests**

Test that `readLanePosition(group, label)`:

- Uses the funded/eval maintenance scheduler kind.
- Verifies the exact lane/account before trusting the value.
- May switch to the requested account only for a serialized read-only diagnostic in sequential mode.
- Returns unknown on verification failure.
- Does not clear the open-trade lease merely because it reads flat.

Also add tests for `restoreOpenTrade(group, label)` and idempotent `clearOpenTrade` so a restarted server can protect a persisted open trade while reconnecting.

**Step 2: Run the focused worker tests and verify RED**

Run: `node --import tsx --test test/sessions.test.ts`

**Step 3: Add adapter/worker plumbing**

Extend `TradingSessionAdapter` with selected/lane position reads, implement them in `TradovateSessionAdapter`, and serialize them in `CredentialWorker`. Position reads must not join the order's pre-click path.

**Step 4: Run focused tests and verify GREEN**

Run: `node --import tsx --test test/sessions.test.ts`

## Task 4: Build the two-reading, exactly-once reconciler

**Files:**
- Create: `src/positionReconciler.ts`
- Create: `test/positionReconciler.test.ts`

**Step 1: Write failing state-machine tests**

Cover:

- Open resets the zero counter.
- First zero produces `flat-candidate` only.
- Second consecutive zero produces one `confirmed-flat` action.
- Unknown retains the trade and resets confirmation.
- Repeated zero after completion is a no-op.
- A new trade identity cannot inherit the previous trade's zero counter.
- Unknown warning thresholds/rate limits are deterministic.

**Step 2: Run focused test and verify RED**

Run: `node --import tsx --test test/positionReconciler.test.ts`

**Step 3: Implement the minimal pure reconciler**

Key state by stable lane key plus a trade fingerprint (account, symbol, opened timestamp if available). Return actions to the server; do not mutate rotations inside the pure module.

**Step 4: Run focused tests and verify GREEN**

Run: `node --import tsx --test test/positionReconciler.test.ts`

## Task 5: Make server reconciliation broker-authoritative

**Files:**
- Modify: `src/server.ts`
- Modify: `src/types.ts` if the status snapshot needs broker fields
- Create or modify: `test/webhookRoutes.test.ts`
- Create: `test/brokerReconciliation.test.ts`

**Step 1: Write failing integration tests**

Prove:

- A close webhook does not call `recordClose` merely because it arrived.
- Broker already flat means no Exit click and exactly one reconciliation.
- Broker open means Exit is requested, but completion waits for two flat observations.
- ATM/liquidation-style flat observations complete and rotate without a close webhook.
- Settled equity above entry benches the winner; a loss remains eligible.
- Missing equity completes the broker-flat trade without inventing win/loss.
- Concurrent webhook and monitor observations cannot complete twice.
- Practice mode remains webhook-simulated and never reads live position.

**Step 2: Run focused integration tests and verify RED**

Run: `node --import tsx --test test/webhookRoutes.test.ts test/brokerReconciliation.test.ts`

**Step 3: Extract one idempotent completion function**

Move the shared `recordClose`, lease clearing, balance logging, winner/target handling, event logging, notification, and next-account arming into one lane-scoped function that re-checks the open-trade identity before mutating.

**Step 4: Integrate position reads into `monitorTick()`**

Read position before/alongside equity through the worker queue. Feed evidence into the pure reconciler. On confirmed flat, call the idempotent completion function without clicking Exit.

**Step 5: Change close-webhook handling**

For live mode, use broker evidence to decide whether an Exit click is necessary and leave completion to confirmed broker-flat reconciliation. Preserve current simulated behavior in practice mode.

**Step 6: Run focused tests and verify GREEN**

Run: `node --import tsx --test test/webhookRoutes.test.ts test/brokerReconciliation.test.ts`

## Task 6: Reconcile persisted open trades after restart

**Files:**
- Modify: `src/server.ts`
- Modify: `src/sessions.ts`
- Modify or create: `test/startupReconciliation.test.ts`

**Step 1: Write failing startup tests**

Assert that ATLAS restores worker leases from persisted rotation state, reconnects the saved Tradovate session without arming/switching to a next account, and lets the monitor determine open/flat. Confirm startup no longer requires manual reset solely because a close webhook was missed.

**Step 2: Run focused startup test and verify RED**

Run: `node --import tsx --test test/startupReconciliation.test.ts`

**Step 3: Implement safe startup restoration**

Restore open-trade leases before auto-connect. Connect the credential even when a persisted trade exists, skip normal next-account arming, and run an immediate broker-position reconciliation after login. Keep unknown fail-safe and notify only after the configured threshold.

**Step 4: Run focused startup test and verify GREEN**

Run: `node --import tsx --test test/startupReconciliation.test.ts`

## Task 7: Add status visibility and no-order calibration

**Files:**
- Modify: `src/server.ts`
- Modify: `public/index.html`
- Modify or create: `test/statusRoutes.test.ts`
- Modify or create: `test/dashboard.browser.test.ts`

**Step 1: Write failing status/UI tests**

Require lane status to expose broker state, signed net position, last check, unknown reason, and `SIMULATED` in practice. Add a no-order read-position diagnostic endpoint/button limited to status inspection.

**Step 2: Run focused tests and verify RED**

Run: `node --import tsx --test test/statusRoutes.test.ts test/dashboard.browser.test.ts`

**Step 3: Implement minimal dashboard/status changes**

Show `OPEN +N`, `OPEN -N`, `FLAT CHECK 1/2`, `FLAT`, `UNKNOWN`, or `SIMULATED`. Add activity detail without guessing whether an exit was specifically ATM versus liquidation.

**Step 4: Run focused tests and verify GREEN**

Run: `node --import tsx --test test/statusRoutes.test.ts test/dashboard.browser.test.ts`

## Task 8: Full verification and real Tradovate flat calibration

**Files:**
- Modify: `README.md`
- Modify: `.env.example` only if new thresholds are configurable

**Step 1: Document behavior and safety**

Document broker-authoritative completion, two-zero confirmation, unknown fail-safe behavior, practice-mode exemption, startup reconciliation, and the next-natural-trade calibration log.

**Step 2: Run static and full automated verification**

Run:

```bash
npm test
npm run typecheck
```

If no `typecheck` script exists, run `npx tsc --noEmit` and avoid changing package scripts unless needed.

**Step 3: Run full Chrome-backed tests**

Run the project browser tests with the configured browser runtime and confirm there are no regressions in ATM, account switching, quantity, popup, or ticket-capability behavior.

**Step 4: Inspect the authenticated Tradovate flat screen read-only**

With the real account verified, call the new no-order position diagnostic. Require a successful `flat` result sourced from the dedicated `POSITION 0` field. Do not place a real order for this test.

**Step 5: Request code review and resolve findings**

Use the `superpowers:requesting-code-review` checklist, fix high-confidence issues, and rerun affected tests.

## Task 9: Back up and install the verified build

**Files:**
- Source: working `v3-multilogin` tree
- Destination: `C:\Users\TheTr\OneDrive\Documents\v3`

**Step 1: Read the verification-before-completion skill**

Do not claim completion until fresh test, typecheck, localhost health, and browser-visible evidence has been collected.

**Step 2: Stop the temporary/live service cleanly**

Ensure no ATLAS process is writing files during backup/install. Do not terminate unrelated Node processes.

**Step 3: Create a timestamped backup**

Back up the current live source/config/public/test/docs files while preserving all user data, account settings, browser session directories, screenshots, logs, and secrets in place.

**Step 4: Install only verified application files**

Copy the verified source, public assets, tests, documentation, package metadata, and launch scripts. Do not overwrite `.env`, `data`, `.tradovate-session*`, screenshots, or existing backups.

**Step 5: Start live ATLAS and verify health**

Verify `http://localhost:3400/api/status` through the authenticated dashboard session and visibly inspect `http://localhost:3400/` in the in-app browser.

**Step 6: Verify safe final state**

Require:

- Mode: `Practice`.
- Bot: `Paused`.
- No order placed during calibration.
- Real Tradovate no-order diagnostic reports `POSITION 0` as flat for the verified selected account.
- Existing credentials, lanes, accounts, webhooks, ATM presets, and settings remain present.

**Step 7: Record remaining live calibration**

Explain that the next naturally occurring trade must produce an observed nonzero `POSITION` followed by two zeros. This is runtime confirmation, not a reason to hold or pause normal execution.
