# ATLAS Login Pools and Cross-Login No-Order Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose multi-login and lane assignment controls in the visible credentials section and let the no-order test select independent Evaluation and Funded Tradovate credentials.

**Architecture:** Reuse the existing login and account mutation APIs. Add a small pure request-selection helper for the simultaneous endpoint, then update the dashboard to present modal-driven credential creation, scanning, lane-local manual assignment, and cross-login readiness testing.

**Tech Stack:** TypeScript, Express, browser JavaScript, CSS, Node test runner.

## Global Constraints

- Preserve the recognizable V3 layout and current webhook routes.
- The no-order test must never click Buy, Sell, or Exit.
- Same-session sequential mode must remain fail-safe unless dual-ticket independence is proven.
- Existing `credentialId` clients remain compatible.
- Work in the isolated staging copy and install to live V3 only after full verification and backup.

---

### Task 1: Cross-login request selection

**Files:**
- Modify: `src/simultaneousReadiness.ts`
- Modify: `src/server.ts`
- Test: `test/simultaneousReadiness.test.ts`

**Interfaces:**
- Produces: `resolveReadinessCredentialIds(body, fallbackId): { evalCredentialId: string; fundedCredentialId: string }`
- Consumes: request fields `evalCredentialId`, `fundedCredentialId`, and legacy `credentialId`.

- [ ] **Step 1: Add failing pure tests**

```ts
test("readiness credential selection preserves different evaluation and funded logins", () => {
  assert.deepEqual(resolveReadinessCredentialIds({ evalCredentialId: "eval-login", fundedCredentialId: "funded-login" }, "primary"), {
    evalCredentialId: "eval-login",
    fundedCredentialId: "funded-login",
  });
});

test("readiness credential selection keeps the legacy one-credential request compatible", () => {
  assert.deepEqual(resolveReadinessCredentialIds({ credentialId: "legacy" }, "primary"), {
    evalCredentialId: "legacy",
    fundedCredentialId: "legacy",
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test test/simultaneousReadiness.test.ts`

Expected: FAIL because `resolveReadinessCredentialIds` is not exported.

- [ ] **Step 3: Implement the pure selector and stage-specific route lookup**

```ts
export function resolveReadinessCredentialIds(body: unknown, fallbackId: string) {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const legacy = typeof value.credentialId === "string" && value.credentialId.trim() ? value.credentialId.trim() : fallbackId;
  return {
    evalCredentialId: typeof value.evalCredentialId === "string" && value.evalCredentialId.trim() ? value.evalCredentialId.trim() : legacy,
    fundedCredentialId: typeof value.fundedCredentialId === "string" && value.fundedCredentialId.trim() ? value.fundedCredentialId.trim() : legacy,
  };
}
```

Use `laneFor(evalCredentialId, "evals")` and `laneFor(fundedCredentialId, "funded")`. Return separate actionable errors when either selected lane has no next account, and reject unknown saved credentials before running the test.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --import tsx --test test/simultaneousReadiness.test.ts`

Expected: all readiness tests pass.

### Task 2: Visible credential and lane management

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Test: `test/ui-multilogin.test.ts`
- Test: `test/ui-atlas.test.ts`

**Interfaces:**
- Adds visible controls `#btn-add-login` and `#btn-scan-assign`.
- Adds `.lane-add-account` in each rendered lane card.
- Reuses `POST /api/logins`, `GET /api/logins/:id/accounts`, and `POST /api/accounts/add`.

- [ ] **Step 1: Add failing UI regression tests**

Require the two credential toolbar buttons, `.lane-add-account`, the phrases `Scan & assign`, and modal submissions that call the existing login/account APIs with an explicit stage and login ID. Require the obsolete bottom `#add-login-form` to be absent.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `node --import tsx --test test/ui-atlas.test.ts test/ui-multilogin.test.ts`

Expected: FAIL because the toolbar and lane-local add controls do not exist.

- [ ] **Step 3: Implement the toolbar and modals**

Replace the bottom credential form with:

```html
<div class="credential-tools">
  <div><strong>Add or import Tradovate accounts</strong><small>Add a login, connect it, then scan and assign its accounts.</small></div>
  <button id="btn-add-login" class="btn small primary">+ Add Tradovate login</button>
  <button id="btn-scan-assign" class="btn small">Scan &amp; assign accounts</button>
</div>
```

Add modal handlers that submit to `/logins` and `/accounts/add`. Add one lane-local button whose stage comes from `lane.stage` and whose default login comes from `credential.id`. Rename per-credential scanning to `Scan & assign`.

- [ ] **Step 4: Add compact responsive styling**

Style `.credential-tools`, `.lane-footer`, and the account modal fields with wrapping, `min-width: 0`, and the existing V3 color variables. Do not widen the page or reintroduce horizontal overflow.

- [ ] **Step 5: Run UI tests and verify GREEN**

Run: `node --import tsx --test test/ui-atlas.test.ts test/ui-multilogin.test.ts`

Expected: all UI tests pass.

### Task 3: Cross-login no-order modal

**Files:**
- Modify: `public/app.js`
- Test: `test/ui-multilogin.test.ts`

**Interfaces:**
- Sends `{ evalCredentialId, fundedCredentialId, evalQuantity: 1, fundedQuantity: 1 }` to `/tests/simultaneous`.
- Renders success and expected errors inside `#simultaneous-result`.

- [ ] **Step 1: Add failing UI tests**

Require `#sim-eval-login`, `#sim-funded-login`, both stage-specific request keys, a `try/catch` modal result path, and no `chooseLogin(...runCredentialReadinessTest)` call for the global button.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test test/ui-multilogin.test.ts`

Expected: FAIL because the current button chooses only one credential and expected errors fall through to `alert`.

- [ ] **Step 3: Implement the two-selector modal**

Build selector options from `status.credentials`, default each selector to the first credential whose corresponding lane has a next account, submit both IDs, and render either timings or the actionable server error in the modal. Keep the explicit `No trade was placed` text.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --import tsx --test test/ui-multilogin.test.ts`

Expected: all multi-login UI tests pass.

### Task 4: Full verification and live installation

**Files:**
- Verify all modified staging files.
- Back up and copy them to `C:/Users/TheTr/OneDrive/Documents/v3`.

- [ ] **Step 1: Run staging verification**

Run:

```powershell
node --check public\app.js
npx.cmd tsc --noEmit
$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm.cmd test
```

Expected: syntax and type checks exit 0; all tests pass with zero skips.

- [ ] **Step 2: Confirm live safety state and create a timestamped backup**

Confirm the dashboard is Paused and Practice mode before copying the verified files. Back up every live file that will be replaced.

- [ ] **Step 3: Install and verify exact file hashes**

Copy only the reviewed modified runtime/test/docs files. Compare SHA-256 hashes between staging and live.

- [ ] **Step 4: Run the full live verification**

Run the same syntax, type, and Chrome-backed full test suite from the live V3 directory.

- [ ] **Step 5: Verify the browser workflow**

Refresh `http://localhost:3400/`, confirm the toolbar is visible, the Evaluation and Funded lane add actions open correctly, the no-order modal has two selectors and no native alert, the page has no horizontal overflow at desktop and 680px widths, and the console has no errors. Leave the refreshed tab open in Practice and Paused state.
