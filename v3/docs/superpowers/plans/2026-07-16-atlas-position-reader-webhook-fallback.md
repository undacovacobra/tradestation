# ATLAS Position Reader and Webhook Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make two-lane position reconciliation reliable under one Tradovate login, accept a close webhook after a bounded broker-reader failure, suppress repeated alerts, and expose a no-order end-to-end test button.

**Architecture:** Extend the browser evidence collector for Tradovate's separate top `Positions` counter, then expose one verified position/equity snapshot per account through the credential worker. A login-level cycle inspects funded before evaluation while different logins can overlap. Pure close-fallback state ties webhook evidence to the exact trade fingerprint and only becomes eligible after five seconds plus two unknown reads.

**Tech Stack:** Node.js 22, TypeScript, Express, Playwright, vanilla browser JavaScript, Node test runner.

## Global Constraints

- ATM orders remain the primary protection and monitoring must never modify them.
- No monitoring work may enter the Buy/Sell execution path.
- Funded is inspected before evaluation within one login.
- Every accepted position value must follow exact visible-account verification.
- Explicit broker-open evidence vetoes webhook fallback.
- Unknown evidence never pauses all of ATLAS.
- The diagnostic endpoint and button never click Buy, Sell, or Exit.

---

### Task 1: Read Tradovate's Separate Top Positions Counter

**Files:**
- Modify: `v3/test/fixtures/mock-position.html`
- Modify: `v3/test/position.browser.test.ts`
- Modify: `v3/src/browser.ts`

**Interfaces:**
- Consumes: `classifyBrokerPosition`, `classifyTopPositionSummary`, and `combineBrokerPositionSources` from `src/brokerPosition.ts`.
- Produces: `TradovateBrowser.readSelectedPosition(): Promise<BrokerPosition>` that recognizes a visible `Positions` label with one nearby signed whole-number value.

- [ ] **Step 1: Add a failing browser fixture and test**

Add fixture states whose DOM is:

```html
<section class="top-position-card">
  <span>Positions</span>
  <span class="positions-value">0</span>
</section>
```

Assert `0` is flat, `+2` is open long, `-3` is open short, and duplicate or malformed cards remain unknown.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'
node --import tsx --test test/position.browser.test.ts
```

Expected: the new separate-label test fails because only `Positions: + N/- N` is currently collected.

- [ ] **Step 3: Collect the smallest visible account-summary container**

In `readSelectedPosition`, collect exact visible `/^Positions:?$/i` labels. For each label, climb only until the smallest container has exactly one visible leaf matching:

```ts
/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/
```

Classify those values with `classifyBrokerPosition`, combine them with the formatted summary, then combine the result with ticket evidence. Multiple candidates remain ambiguous.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: all position browser tests pass with no skips.

- [ ] **Step 5: Commit the evidence-reader change**

```powershell
git add v3/src/browser.ts v3/test/fixtures/mock-position.html v3/test/position.browser.test.ts
git commit -m "Fix Tradovate top position counter reading"
```

---

### Task 2: Verify Account Selection and Batch Snapshots by Login

**Files:**
- Create: `v3/src/loginPositionCycle.ts`
- Create: `v3/test/loginPositionCycle.test.ts`
- Modify: `v3/src/sessions.ts`
- Modify: `v3/test/sessions.test.ts`
- Modify: `v3/src/server.ts`

**Interfaces:**
- Produces: `LaneSnapshot = { verifiedAccount: boolean; position: BrokerPosition; equity: number | null; checkedAt: string }`.
- Produces: `CredentialWorker.readLaneSnapshot(group: Group, label: string): Promise<LaneSnapshot>`.
- Produces: `runLoginPositionCycles<T, R>(targets, inspect): Promise<R[]>`, serial within a login, funded first, parallel across logins.

- [ ] **Step 1: Write failing worker and cycle tests**

Cover a stale cached selection where the first visible-account verification fails, `armFor(label)` is called, the second verification succeeds, and position plus equity are read once. Cover two targets on one login executing `funded` then `evals`, while targets on another login overlap.

```ts
const results = await runLoginPositionCycles(targets, async (target) => {
  calls.push(`${target.loginId}:${target.stage}`);
  return target.label;
});
assert.deepEqual(calls.slice(0, 2), ["primary:funded", "primary:evals"]);
```

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --import tsx --test test/sessions.test.ts test/loginPositionCycle.test.ts
```

Expected: imports/method assertions fail because the snapshot and cycle do not exist.

- [ ] **Step 3: Implement one verified snapshot task**

For sequential mode, verify the actual account first. On mismatch, call `armFor(label)` and verify again. If still unverified, return an unknown position without reading equity. Otherwise read position and equity inside the same queued task. For dual-ticket mode, verify the scoped lane once and read both scoped values.

- [ ] **Step 4: Implement and integrate login cycles**

Group monitor targets by `loginId`, sort each group funded-first, inspect each group serially, and `Promise.all` the independent login groups. Replace the monitor's separate `readLanePosition` and `readLaneEquity` calls with one snapshot.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all worker and login-cycle tests pass.

- [ ] **Step 6: Commit the login-level cycle**

```powershell
git add v3/src/loginPositionCycle.ts v3/src/sessions.ts v3/src/server.ts v3/test/loginPositionCycle.test.ts v3/test/sessions.test.ts
git commit -m "Reconcile positions per Tradovate login"
```

---

### Task 3: Add Fingerprint-Scoped Close-Webhook Fallback and Alert Suppression

**Files:**
- Create: `v3/src/closeWebhookFallback.ts`
- Create: `v3/test/closeWebhookFallback.test.ts`
- Modify: `v3/src/positionReconciler.ts`
- Modify: `v3/test/positionReconciler.test.ts`
- Modify: `v3/src/server.ts`
- Modify: `v3/test/brokerReconciliation.test.ts`

**Interfaces:**
- Produces: `CloseWebhookFallback.record(laneKey, fingerprint, receivedAt)`.
- Produces: `CloseWebhookFallback.observe(laneKey, fingerprint, position, unknownReads, now): "none" | "waiting" | "eligible" | "vetoed"`.
- Produces: `CloseWebhookFallback.clear(laneKey)`.
- Changes unknown alerts to one notification per continuous unknown episode.

- [ ] **Step 1: Write failing pure fallback tests**

Assert that eligibility requires the same fingerprint, at least 5,000 milliseconds, at least two unknown reads, and an unknown position. Assert explicit open returns `vetoed`, flat returns `waiting`, a new fingerprint cannot inherit evidence, and clear removes evidence.

- [ ] **Step 2: Write the failing alert-episode test**

Observe unknown position repeatedly and assert only the threshold observation has `shouldAlert: true`. Observe open, then unknown through the threshold, and assert exactly one new alert occurs for the recovered-then-failed episode.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
node --import tsx --test test/closeWebhookFallback.test.ts test/positionReconciler.test.ts test/brokerReconciliation.test.ts
```

Expected: the fallback import fails and the old repeating-alert assertion conflicts with the new episode behavior.

- [ ] **Step 4: Implement fallback state and one-alert episodes**

Store `{ fingerprint, receivedAtMs }` per lane. Do not store timers. Evaluate eligibility only from current monitor observations so no browser queue is blocked. Change `PositionReconciler` so `shouldAlert` is true once after `unknownAlertAfter` until a definite open/flat result resets the episode.

- [ ] **Step 5: Integrate close evidence and completion**

On every valid close webhook with a recorded live trade, record the current fingerprint before reading the broker. During monitor reconciliation, broker-flat completion remains primary; explicit open can request Exit; eligible unknown fallback calls `completeRecordedTrade` with source `close webhook fallback after broker position remained unavailable`. Clear evidence in every completion/reset path.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 3 command. Expected: all fallback, reconciler, and broker-policy tests pass.

- [ ] **Step 7: Commit the fallback**

```powershell
git add v3/src/closeWebhookFallback.ts v3/src/positionReconciler.ts v3/src/server.ts v3/test/closeWebhookFallback.test.ts v3/test/positionReconciler.test.ts v3/test/brokerReconciliation.test.ts
git commit -m "Use close webhooks as bounded position fallback"
```

---

### Task 4: Add the No-Order Position Reader Test Button

**Files:**
- Create: `v3/src/positionTestRoutes.ts`
- Create: `v3/test/positionTestRoutes.test.ts`
- Modify: `v3/src/server.ts`
- Modify: `v3/public/index.html`
- Modify: `v3/public/app.js`
- Modify: `v3/test/ui-position.test.ts`

**Interfaces:**
- Produces: `POST /api/test-position-reader` with `{ loginId }`.
- Response: `{ ok, placedOrder: false, loginId, results: Array<{ group, label, verifiedAccount, position, equity, elapsedMs }> }`.

- [ ] **Step 1: Write failing route and UI tests**

Assert the route rejects an unknown/disconnected login, calls the injected funded target before evaluation, returns `placedOrder: false`, and exposes unknown reasons. Assert the page contains `btn-test-position-reader` and its handler calls `/test-position-reader`.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --import tsx --test test/positionTestRoutes.test.ts test/ui-position.test.ts
```

Expected: the route module, button, and handler are absent.

- [ ] **Step 3: Implement the route using the production snapshot path**

Choose the recorded open account per lane, otherwise each lane's next account. Run the same login-cycle and `readLaneSnapshot` methods without calling reconciliation, rotation mutation, or any order method.

- [ ] **Step 4: Implement the dashboard modal**

Add `🔎 Test position reader` beside the existing diagnostic buttons. Reuse the login chooser. While running, show `Testing funded, then evaluations…`; then render one result row per lane with account, `OPEN/FLAT/UNKNOWN`, equity or `not read`, reason, and elapsed milliseconds.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: route and UI tests pass.

- [ ] **Step 6: Commit the diagnostic**

```powershell
git add v3/src/positionTestRoutes.ts v3/src/server.ts v3/public/index.html v3/public/app.js v3/test/positionTestRoutes.test.ts v3/test/ui-position.test.ts
git commit -m "Add no-order position reader diagnostic"
```

---

### Task 5: Full Verification, Deployment, and Push

**Files:**
- Modify: `v3/README.md`
- Modify: `v3/SETUP-GUIDE.md`

**Interfaces:**
- Documents broker-first/webhook-fallback behavior and the no-order test button.

- [ ] **Step 1: Update operator documentation**

Explain funded-first account switching, the separate top counter, five-second webhook fallback, one-alert behavior, and how to run the no-order test button.

- [ ] **Step 2: Run full verification**

```powershell
$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'
node --check public/app.js
npx tsc --noEmit
npm test
```

Expected: syntax and type checks exit zero; all tests pass with zero failures and zero skips.

- [ ] **Step 3: Verify scope and secrets**

```powershell
git diff --check HEAD~4..HEAD
git status --short
git diff --name-only HEAD~4..HEAD
```

Expected: only V3 source, tests, and docs are changed; `.env`, data, sessions, logs, screenshots, backups, and `node_modules` are absent.

- [ ] **Step 4: Commit documentation**

```powershell
git add v3/README.md v3/SETUP-GUIDE.md
git commit -m "Document reliable position reconciliation"
```

- [ ] **Step 5: Deploy verified tracked files**

Copy only tracked V3 files into `C:\Users\TheTr\OneDrive\Documents\v3`, preserving its `.env`, `data`, sessions, logs, screenshots, and dependencies. Re-run syntax, type, and full tests from the deployed folder.

- [ ] **Step 6: Push and verify GitHub**

```powershell
git push origin claude/tradestation-takeover-qowymb
git ls-remote origin refs/heads/claude/tradestation-takeover-qowymb
```

Expected: the remote branch SHA equals local `HEAD`.
