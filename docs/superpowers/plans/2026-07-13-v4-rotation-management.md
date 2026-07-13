# V4 Rotation Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make configured browser-scanned accounts editable, display every rotation simultaneously, and add safe next-account, skip-today, resume-today, hold, and remove-from-rotation controls.

**Architecture:** Persist pool-specific daily exclusions in `PoolState`, keep long-lived account lifecycle fields in the registry, and expose both through the existing coordinator status/API layer. Keep the browser UI server-rendered from static JavaScript, but replace the selected-pool model with stacked pool panels and reuse one create/edit account form on onboarding.

**Tech Stack:** TypeScript, Node.js, Express, Zod, static HTML/CSS/JavaScript, Node test runner.

## Global Constraints

- The trading-day reset remains the configured 6:00 PM Eastern default.
- Internal account ids, connection ids, and platform labels are immutable after onboarding.
- “Remove from rotation” removes pool membership only; it never deletes the account definition.
- Existing `.env`, browser session directories, balances, registry accounts, and rotation state must be preserved during local deployment.
- Every backend behavior change follows red-green-refactor TDD.

---

### Task 1: Pool-specific skip-today state

**Files:**
- Modify: `v4/src/models.ts`
- Modify: `v4/src/poolRotation.ts`
- Test: `v4/test/v4-rotation.test.ts`

**Interfaces:**
- Produces: `PoolState.skippedDay: Record<string, string>`
- Produces: `PoolRotation.skipToday(accountId, accounts): void`
- Produces: `PoolRotation.resumeToday(accountId): void`
- Produces: `PoolRotation.isSkippedToday(accountId): boolean`

- [ ] **Step 1: Write failing tests**

Add tests that use a mutable `day` variable, skip `a1`, assert selection returns `a2`, resume and assert `a1` is selectable, then change the day and assert the prior skip no longer applies. Add a test that `setNext("a1", accounts)` rejects while `a1` is skipped.

```ts
let day = "2026-07-10";
const rotation = new PoolRotation("pool", resolve(dir, "state.json"), false, () => day);
rotation.skipToday("a1", accounts);
assert.equal(rotation.isSkippedToday("a1"), true);
assert.equal(rotation.select(accounts, new Set()).id, "a2");
rotation.resumeToday("a1");
assert.equal(rotation.select(accounts, new Set()).id, "a1");
rotation.skipToday("a1", accounts);
day = "2026-07-11";
assert.equal(rotation.isSkippedToday("a1"), false);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/v4-rotation.test.ts`

Expected: compile/test failure because the skip methods and `skippedDay` state do not exist.

- [ ] **Step 3: Implement the minimum rotation behavior**

Initialize `skippedDay` in `emptyState()`. `skipToday` validates membership and flat state, stores `this.today()`, clears `nextAccountId` when needed, and saves. `resumeToday` deletes the key and saves. `select` ignores accounts whose stored day matches `today()`. `setNext` rejects skipped accounts.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- test/v4-rotation.test.ts`

Expected: all rotation tests pass.

- [ ] **Step 5: Commit**

```powershell
git add v4/src/models.ts v4/src/poolRotation.ts v4/test/v4-rotation.test.ts
git commit -m "feat: add daily pool account skips"
```

### Task 2: Edit configured accounts and pool memberships

**Files:**
- Modify: `v4/src/registry.ts`
- Test: `v4/test/v4-registry.test.ts`

**Interfaces:**
- Produces: `Registry.updateAccount(id, { name, firm, stage, poolIds }): AccountDefinition`

- [ ] **Step 1: Write a failing persistence test**

Create two pools and one account, call `updateAccount`, then assert mutable fields changed, immutable fields did not change, the account was removed from the old pool, added to the requested pool, and the same state reloads from disk.

```ts
const updated = registry.updateAccount("a1", {
  name: "Renamed",
  firm: "New Firm",
  stage: "funded",
  poolIds: ["p2"],
});
assert.equal(updated.connectionId, "c1");
assert.equal(updated.platformLabel, "A1");
assert.deepEqual(registry.pool("p1")?.accountIds, []);
assert.deepEqual(registry.pool("p2")?.accountIds, ["a1"]);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/v4-registry.test.ts`

Expected: failure because `updateAccount` does not exist.

- [ ] **Step 3: Implement atomic validation and update**

Validate the account and all unique pool ids first. Parse the updated account through `AccountSchema`, replace only `name`, `firm`, and `stage`, remove the id from unrequested pools, append it to newly requested pools, validate references, and save once.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- test/v4-registry.test.ts`

Expected: all registry tests pass.

- [ ] **Step 5: Commit**

```powershell
git add v4/src/registry.ts v4/test/v4-registry.test.ts
git commit -m "feat: edit configured V4 accounts"
```

### Task 3: Coordinator and API management actions

**Files:**
- Modify: `v4/src/coordinator.ts`
- Modify: `v4/src/server-v4.ts`
- Test: `v4/test/v4-coordinator.test.ts`

**Interfaces:**
- Produces: `TradeCoordinator.skipToday(poolId, accountId): void`
- Produces: `TradeCoordinator.resumeToday(poolId, accountId): void`
- Produces: status account field `skippedToday: boolean`
- Produces: `PATCH /api/accounts/:accountId`
- Extends: pool account action endpoint with `skip-today` and `resume-today`

- [ ] **Step 1: Write failing coordinator tests**

Use a two-account pool fixture. Assert `skipToday` changes status and selection, `resumeToday` restores availability, and `setNext` rejects a skipped account. Assert open-trade protection rejects all management actions for the active account.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/v4-coordinator.test.ts`

Expected: failure because skip/resume methods and status fields do not exist.

- [ ] **Step 3: Implement coordinator methods and status projection**

Delegate skip/resume to the pool’s `PoolRotation`. Project `skippedToday` from the matching rotation for every account. Reuse `accountForOpenTrade` checks before mutations.

- [ ] **Step 4: Extend API routes**

Add `PATCH /api/accounts/:accountId`, reject if the account owns any open pool trade, call `registry.updateAccount`, and return the account plus its pool ids. Add `skip-today` and `resume-today` cases to the existing action route.

- [ ] **Step 5: Run coordinator tests and typecheck**

Run: `npm test -- test/v4-coordinator.test.ts`

Run: `npm run typecheck`

Expected: tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit**

```powershell
git add v4/src/coordinator.ts v4/src/server-v4.ts v4/test/v4-coordinator.test.ts
git commit -m "feat: expose safe rotation controls"
```

### Task 4: Editable scanned-account onboarding

**Files:**
- Modify: `v4/public/onboarding.js`
- Test: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Consumes: `PATCH /api/accounts/:accountId`
- Produces: `accountForm(connection, label, account?)` for new and configured accounts

- [ ] **Step 1: Write a failing static UI contract test**

Read `public/onboarding.js` and assert it contains the configured-account edit request, prechecked pool membership, and no read-only “Already configured” branch.

```ts
const source = readFileSync(resolve("public/onboarding.js"), "utf8");
assert.match(source, /method:\s*"PATCH"/);
assert.match(source, /Save changes/);
assert.doesNotMatch(source, /Already configured<\/span>/);
```

- [ ] **Step 2: Run the UI test and verify RED**

Run: `npm test -- test/v4-ui.test.ts`

Expected: assertions fail against the current read-only branch.

- [ ] **Step 3: Render configured accounts as editable forms**

Find the saved account by connection id and platform label. Pass it into `accountForm`; prefill name, firm, and stage; check pools containing the id; hide the immutable id input for configured accounts; label the card “Configured”; and change the button text to “Save changes.”

- [ ] **Step 4: Save new versus existing accounts**

Keep `POST /api/accounts/onboard` for new cards and use `PATCH /api/accounts/:id` for configured cards. On success, leave the card editable, refresh status, and display the updated pool list.

- [ ] **Step 5: Run the UI test and verify GREEN**

Run: `npm test -- test/v4-ui.test.ts`

Expected: onboarding UI contract passes.

- [ ] **Step 6: Commit**

```powershell
git add v4/public/onboarding.js v4/test/v4-ui.test.ts
git commit -m "feat: edit scanned V4 accounts"
```

### Task 5: All rotations visible with explicit controls

**Files:**
- Modify: `v4/public/index.html`
- Modify: `v4/public/app.js`
- Modify: `v4/public/style.css`
- Test: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Consumes: status `skippedToday`
- Consumes: `next`, `skip-today`, `resume-today`, `hold`, `activate`, and `remove` actions

- [ ] **Step 1: Extend the failing UI contract test**

Assert the dashboard has a `pool-list` container, maps every pool through `renderPool`, contains “Make next,” “Skip today,” “Resume today,” and “Remove from rotation,” and no longer contains `selectedPool`, `choosePool`, or `pool-tabs`.

- [ ] **Step 2: Run the UI test and verify RED**

Run: `npm test -- test/v4-ui.test.ts`

Expected: assertions fail because the current dashboard renders one selected pool.

- [ ] **Step 3: Render every pool panel**

Replace the tab and detail containers with one `#pool-list`. In `render()`, set its HTML to `data.pools.map(renderPool).join("")`. Give each lane input a pool-specific id so every stacked panel saves the correct lane.

- [ ] **Step 4: Make account controls explicit**

Rename “Set next” to “Make next.” Show “Skip today” or “Resume today” from `skippedToday`. Keep persistent Hold/Reactivate. Rename “Remove” to “Remove from rotation” and retain confirmation. Disable or omit next/skip/hold/remove controls for the open-trade account and show an explanatory badge.

- [ ] **Step 5: Style stacked panels and statuses**

Add vertical spacing for `.pool-list`, a distinct skipped row/badge treatment, and responsive wrapping for controls. Remove unused tab styles.

- [ ] **Step 6: Run the UI test and verify GREEN**

Run: `npm test -- test/v4-ui.test.ts`

Expected: dashboard UI contract passes.

- [ ] **Step 7: Commit**

```powershell
git add v4/public/index.html v4/public/app.js v4/public/style.css v4/test/v4-ui.test.ts
git commit -m "feat: show and manage every V4 rotation"
```

### Task 6: Full verification and local handoff

**Files:**
- Modify if needed: `v4/README.md`
- Modify if needed: `v4/SETUP-GUIDE.md`

**Interfaces:**
- Produces: verified repository and refreshed local dashboard

- [ ] **Step 1: Run full automated verification**

Run: `npm run typecheck`

Run: `npm test`

Expected: TypeScript exits 0 and all runnable tests pass with only the existing browser-environment skips.

- [ ] **Step 2: Check the final diff**

Run: `git diff --check HEAD~5..HEAD`

Run: `git status --short`

Expected: no whitespace errors and no unrelated files.

- [ ] **Step 3: Update the user’s local V4 safely**

Back up `v4/data/registry.json`, fast-forward the downloaded checkout, restore/migrate the registry, and preserve `.env` plus `.sessions`. Restart port 3500.

- [ ] **Step 4: Verify the live local API**

Request `/api/status` and confirm all existing accounts remain present, the evaluation target remains 53000, every pool is returned, and status includes `skippedToday`.

- [ ] **Step 5: Verify the visible browser flow**

Reload `http://localhost:3500/`, confirm every pool panel appears together, and verify the explicit management controls. Open onboarding, scan or inspect configured account rendering, and confirm editable fields/pool checkboxes appear. Leave the control center open.

- [ ] **Step 6: Commit documentation changes if any**

```powershell
git add v4/README.md v4/SETUP-GUIDE.md
git commit -m "docs: explain V4 rotation controls"
```
