# V4 Per-Account Dollar Brackets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port V3 commit `b13f4f5` so each V4 account can require a verified Tradovate `$ Value` take-profit and stop-loss bracket before an entry click.

**Architecture:** Store bracket dollars-per-contract on `AccountDefinition`, port the fail-closed ATM driver into `TradovateBrowser`, and make each serialized connection adapter prepare the selected account's bracket before quantity and order entry. Expose account fields plus a connection-scoped no-trade calibration endpoint in the existing onboarding/control-center UI.

**Tech Stack:** TypeScript, Node.js, Express, Zod, Playwright, static HTML/CSS/JavaScript, Node test runner.

## Global Constraints

- Both bracket values are dollars per contract.
- Both positive activates the bracket; both zero leaves Tradovate's existing ATM unchanged; one-sided values are invalid.
- Never click Buy or Sell after a requested bracket fails verification.
- Force Tradovate ATM `Show in` to `$ Value` before writing numbers.
- Save only after exact read-back verification of both fields.
- Preserve `.env`, registry accounts, balances, rotation state, and `.sessions` during local deployment.

---

### Task 1: Account bracket data and registry persistence

**Files:**
- Modify: `v4/src/models.ts`
- Modify: `v4/src/registry.ts`
- Modify: `v4/src/server-v4.ts`
- Test: `v4/test/v4-registry.test.ts`

**Interfaces:**
- Produces: `AccountDefinition.targetPerContract: number`
- Produces: `AccountDefinition.stopPerContract: number`
- Extends: `Registry.onboardAccount` and `Registry.updateAccount`

- [ ] Write failing tests asserting old accounts load with zero defaults, valid pairs persist, and `30/0` or `0/20` updates throw.
- [ ] Run `node --import ./test/setup-env.mjs --import tsx --test test/v4-registry.test.ts` and confirm RED.
- [ ] Add nonnegative defaulted fields to `AccountSchema`, a shared pair validator, and pass values through create/update API inputs.
- [ ] Re-run the focused registry tests and confirm GREEN.
- [ ] Commit with `feat: store per-account dollar brackets`.

### Task 2: Fail-closed Tradovate ATM driver

**Files:**
- Modify: `v4/src/browser.ts`
- Create: `v4/test/bracket.browser.test.ts`
- Create: `v4/test/fixtures/mock-atm.html`

**Interfaces:**
- Produces: `TradovateBrowser.setBracket(targetPerContract, stopPerContract, force?): Promise<void>`

- [ ] Port the V3 mock ATM fixture and failing tests for exact TP/SL write, cache, and nonpositive rejection.
- [ ] Run the focused bracket test and confirm RED because `setBracket` is absent.
- [ ] Port V3's `lastBracket`, disconnect/recover resets, safe ATM opener, `$ Value` enforcement, exact number writer, Save-after-verification, cancel-on-failure, and screenshot diagnostics.
- [ ] Re-run the focused browser test and confirm GREEN or the existing no-Chromium skip.
- [ ] Run `npm.cmd run typecheck` and commit with `feat: verify Tradovate dollar brackets`.

### Task 3: Require brackets before order entry

**Files:**
- Modify: `v4/src/workers.ts`
- Test: `v4/test/v4-connections.test.ts`

**Interfaces:**
- Extends: `ConnectionAdapter.setBracket(account, force?): Promise<void>`
- Guarantees: `enter(account, alert)` orders operations as select account, bracket, quantity, click.

- [ ] Add a recording fake adapter/browser test proving bracket preparation happens before entry and bracket failure rejects without recording an order click.
- [ ] Run the focused connection test and confirm RED.
- [ ] Add `setBracket` to adapters; Tradovate delegates to the browser, simulated mode records no broker action; `enter` calls it only when both saved values are positive.
- [ ] Re-run focused tests and confirm GREEN.
- [ ] Commit with `feat: require bracket verification before entry`.

### Task 4: Bracket editing, display, and no-trade calibration

**Files:**
- Modify: `v4/public/onboarding.html`
- Modify: `v4/public/onboarding.js`
- Modify: `v4/public/app.js`
- Modify: `v4/src/server-v4.ts`
- Test: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Produces: `POST /api/connections/:id/test-bracket`

- [ ] Extend the UI contract test to require both per-contract fields, bracket display text, and the test-bracket endpoint/form; run it and confirm RED.
- [ ] Add bracket inputs to new/configured account cards and include them in create/update payloads.
- [ ] Display `make $X / lose $Y per contract` or `No dollar bracket` in each rotation row.
- [ ] Add the selected-login calibration form with positive target/stop inputs and a result area.
- [ ] Implement the endpoint through `worker.run(adapter => adapter.setBracket(..., true))`; on failure include `inspectFields()` output and never call entry.
- [ ] Re-run UI tests and typecheck; commit with `feat: manage and test V4 dollar brackets`.

### Task 5: Full verification and local browser update

**Files:**
- Modify if needed: `v4/README.md`
- Modify if needed: `v4/SETUP-GUIDE.md`

- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd test` and require zero failures.
- [ ] Run `git diff --check` and review the complete port against V3 commit `b13f4f5`.
- [ ] Merge the isolated feature branch into local `main` and repeat typecheck/tests on the merge result.
- [ ] Back up and restore the downloaded registry while updating the local V4 checkout; preserve `.env`, `.sessions`, balances, and rotation state.
- [ ] Restart port 3500, verify bracket fields/defaults through `/api/status`, refresh the in-app browser, and leave the V4 dashboard open.
