# ATLAS Flatten Positions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe global and per-account emergency flatten controls that verify real broker positions, close them, confirm flatness twice, preserve ATLAS's running state, and publish the verified V3 source.

**Architecture:** A focused `flattenPositions.ts` orchestrator owns target ordering, concurrency, broker verification, exit requests, and two-read flat confirmation through injected operations. `server.ts` builds saved-account targets, maintains per-account broker status, reconciles recorded trades, and exposes confirmation-protected endpoints. The dashboard renders the global and conditional individual controls with explicit warning modals.

**Tech Stack:** TypeScript, Node.js, Express, Playwright browser automation, vanilla JavaScript/CSS, Node test runner.

## Global Constraints

- Flattening must never call `store.setRunning` or otherwise change ATLAS's running/paused state.
- Cancel pending entry work for each targeted lane before broker inspection.
- Only a broker-confirmed nonzero position permits an exit click.
- Require two consecutive broker-flat reads before reporting a close.
- Process Funded before Evaluations within one login and allow different logins to overlap.
- Do not click any live flatten control during verification.

---

### Task 1: Flatten orchestration contract

**Files:**
- Create: `src/flattenPositions.ts`
- Create: `test/flattenPositions.test.ts`

**Interfaces:**
- Produces: `FlattenTarget`, `FlattenResult`, `FlattenOperations`, and `flattenPositions(targets, operations, options)`.
- `FlattenOperations` provides `cancelPending`, `readPosition`, `requestExit`, `confirmedFlat`, and injectable `wait` functions.

- [ ] **Step 1: Write failing orchestration tests**

```ts
test("Funded targets run first per login while different logins overlap", async () => {
  const result = await flattenPositions(targets, operations, { flatConfirmDelayMs: 0 });
  assert.deepEqual(perLoginCalls.one.slice(0, 2), ["funded:F1", "evals:E1"]);
  assert.ok(maxActiveLogins >= 2);
  assert.equal(result.every((item) => item.outcome === "closed"), true);
});

test("flat and unknown evidence never clicks Exit", async () => {
  const result = await flattenPositions(targets, operations, { flatConfirmDelayMs: 0 });
  assert.deepEqual(exitLabels, []);
  assert.deepEqual(result.map((item) => item.outcome), ["already-flat", "failed"]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test test/flattenPositions.test.ts`
Expected: FAIL because `src/flattenPositions.ts` does not exist.

- [ ] **Step 3: Implement the minimal orchestrator**

```ts
export async function flattenPositions(
  targets: readonly FlattenTarget[],
  operations: FlattenOperations,
  options: { flatConfirmDelayMs?: number } = {},
): Promise<FlattenResult[]> {
  const byLogin = groupTargetsFundedFirst(targets);
  const batches = await Promise.all([...byLogin.values()].map(async (batch) => {
    const results: FlattenResult[] = [];
    for (const target of batch) results.push(await flattenOne(target, operations, options));
    return results;
  }));
  return batches.flat();
}
```

- [ ] **Step 4: Run focused tests until GREEN**

Run: `node --import tsx --test test/flattenPositions.test.ts`
Expected: all orchestration tests pass.

### Task 2: Server integration and recorded-trade reconciliation

**Files:**
- Modify: `src/server.ts`
- Modify: `src/sessions.ts`
- Create: `test/flattenRoutes.test.ts`
- Modify: `test/sessions.test.ts`

**Interfaces:**
- Consumes: `flattenPositions(...)` from Task 1.
- Produces: `POST /api/positions/flatten-all` and `POST /api/positions/flatten-one`.
- Produces: account status decoration `{ brokerPosition: { status, netPosition?, reason?, checkedAt? } }`.

- [ ] **Step 1: Write failing endpoint and session tests**

```ts
test("flatten-all rejects a missing confirmation and preserves running state", async () => {
  const response = await requestFlattenAll({ confirm: false });
  assert.equal(response.status, 400);
  assert.equal(store.running, true);
});

test("flatten-one cancels queued entry work and verifies the exact account before Exit", async () => {
  const result = await worker.flattenPosition("funded", "F1");
  assert.deepEqual(adapter.calls, ["arm:F1", "verify-exit:F1", "exit:F1"]);
  assert.equal(result, undefined);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --import tsx --test test/flattenRoutes.test.ts test/sessions.test.ts`
Expected: FAIL because routes, status cache, and flatten integration are absent.

- [ ] **Step 3: Implement confirmation-protected endpoints and status cache**

```ts
api.post("/positions/flatten-all", async (req, res) => {
  if (req.body?.confirm !== "FLATTEN ALL") return res.status(400).json({ ok: false, error: "Explicit confirmation is required." });
  const runningBefore = store.running;
  const results = await runFlatten(savedFlattenTargets());
  res.json({ ok: results.every((item) => item.outcome !== "failed"), running: runningBefore, results });
});
```

For `flatten-one`, validate `loginId`, `group`, and `label` against the saved account registry, require `confirm === "FLATTEN ONE"`, then call the same orchestrator with one target. Update the account-position cache on every read. When a recorded trade reaches two flat confirmations, call `completeRecordedTrade` with its existing fingerprint; otherwise only update the cache.

- [ ] **Step 4: Run focused server/session tests until GREEN**

Run: `node --import tsx --test test/flattenPositions.test.ts test/flattenRoutes.test.ts test/sessions.test.ts`
Expected: all tests pass and no test observes a running-state mutation.

### Task 3: Dashboard controls and confirmation flow

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `test/ui-atlas.test.ts`
- Modify: `test/ui-position.test.ts`

**Interfaces:**
- Consumes: status-decorated per-account `brokerPosition` and the two flatten endpoints.
- Produces: `#btn-flatten-all` and `.credential-flatten-position` controls.

- [ ] **Step 1: Write failing UI contract tests**

```ts
assert.match(html, /id="btn-flatten-all"/);
assert.match(app, /brokerPosition\.status === "open"/);
assert.match(app, /\/positions\/flatten-all/);
assert.match(app, /confirm:\s*"FLATTEN ALL"/);
assert.match(app, /\/positions\/flatten-one/);
assert.match(app, /confirm:\s*"FLATTEN ONE"/);
```

- [ ] **Step 2: Run UI tests and verify RED**

Run: `node --import tsx --test test/ui-atlas.test.ts test/ui-position.test.ts`
Expected: FAIL because the controls and confirmation handlers do not exist.

- [ ] **Step 3: Implement red controls and confirmation modals**

```js
$("#btn-flatten-all").addEventListener("click", () => showModal(`
  <h2>Flatten every verified position?</h2>
  <div class="warn-box">This sends real Exit at Mkt &amp; Cxl clicks even in Practice mode. ATLAS will keep its current running or paused state.</div>
  <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn danger" id="confirm-flatten-all">Flatten all positions</button></div>
`));
```

Render the individual button only when `account.brokerPosition?.status === "open"`. Its modal names the account and submits `loginId`, `group`, `label`, and `confirm: "FLATTEN ONE"`.

- [ ] **Step 4: Run UI tests until GREEN**

Run: `node --import tsx --test test/ui-atlas.test.ts test/ui-position.test.ts`
Expected: all UI contract tests pass.

### Task 4: Complete verification, live install, and GitHub publish

**Files:**
- Modify: live V3 only after staging verification.
- Modify: tracked `v3/` tree in `undacovacobra/tradestation` only after live verification.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: verified live localhost build and a pushed GitHub branch/commit.

- [ ] **Step 1: Run all staging checks**

Run: `node --check public/app.js`; `npx tsc --noEmit`; `PW_CHROMIUM=<chrome> npm test`
Expected: syntax, typecheck, and every test pass with zero skips.

- [ ] **Step 2: Back up and install into live V3**

Copy only verified source/public/test/docs/package files. Preserve `.env`, `data/`, `.sessions/`, screenshots, logs, and backups. Restart only the Node process bound to port 3400, reconnect the existing Tradovate browser, and verify paused/running state is unchanged.

- [ ] **Step 3: Verify live without triggering an exit**

Run the full live suite and inspect the dashboard read-only. Confirm the global control exists, individual controls are absent while every account is flat, existing Eval/Funded layout and webhooks remain correct, and the real Tradovate window still reports its current position. Do not click either flatten control.

- [ ] **Step 4: Copy the complete verified V3 source into the clean Git checkout**

Exclude `.env`, `data/`, `.sessions/`, `node_modules/`, logs, screenshots, backups, and migration scratch output. Review `git status -sb`, `git diff --stat`, and the complete staged diff before committing.

- [ ] **Step 5: Commit and push**

Create `agent/atlas-v3-flatten-controls` from `main`, stage only `v3/`, commit `Add ATLAS V3 flatten position controls`, rerun V3 tests in the checkout, and push with tracking to `origin`. Open a draft PR if GitHub authentication supports it; otherwise report the pushed branch and the authentication blocker precisely.
