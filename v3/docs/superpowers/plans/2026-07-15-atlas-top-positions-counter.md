# ATLAS Top Positions Counter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Tradovate's selected-account `Positions: +N / -N` summary as a fail-safe corroborating/fallback broker-position source during ATLAS monitoring.

**Architecture:** Pure parsing and source-combination rules live in `brokerPosition.ts`. `TradovateBrowser.readSelectedPosition()` gathers one visible order-ticket value and one visible top summary in a single bounded page read, then combines them. The existing credential verification, maintenance queue, two-flat reconciler, and post-entry monitor timing remain unchanged.

**Tech Stack:** TypeScript, Playwright, Node test runner, existing ATLAS browser/session/reconciler modules.

## Global Constraints

- The selected account must be verified before either source is trusted.
- Missing, hidden, malformed, ambiguous, or conflicting evidence is never assumed flat.
- Two consecutive flat observations remain required for completion.
- Monitoring changes must not enter the Buy/Sell execution path.
- No diagnostic or test may place, modify, cancel, or exit an order.

---

### Task 1: Parse and combine the top Positions counter

**Files:**
- Modify: `src/brokerPosition.ts`
- Modify: `src/browser.ts`
- Modify: `test/brokerPosition.test.ts`
- Modify: `test/fixtures/mock-position.html`
- Modify: `test/position.browser.test.ts`

**Interfaces:**
- Produces: `classifyTopPositionSummary(candidates, checkedAt): BrokerPosition`
- Produces: `combineBrokerPositionSources(ticket, summary): BrokerPosition`
- Consumes: existing `TradovateBrowser.readSelectedPosition(): Promise<BrokerPosition>`

- [ ] **Step 1: Write failing pure parser/combiner tests**

```ts
assert.equal(classifyTopPositionSummary(["Positions: + 0/- 0"], at).status, "flat");
assert.deepEqual(classifyTopPositionSummary(["Positions: + 2/- 0"], at), { status: "open", netPosition: 2, checkedAt: at });
assert.deepEqual(classifyTopPositionSummary(["Positions: + 0/- 3"], at), { status: "open", netPosition: -3, checkedAt: at });
assert.equal(classifyTopPositionSummary(["Positions: + 1/- 1"], at).status, "unknown");
assert.equal(combineBrokerPositionSources(ticketFlat, summaryOpen).status, "unknown");
```

- [ ] **Step 2: Write failing Chrome fixture tests**

Add visible summary fixtures for flat, long, short, and ticket/summary conflict. Prove the summary works when the ticket value is absent and that conflicting sources return `unknown`.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'
node --import tsx --test test/brokerPosition.test.ts test/position.browser.test.ts
```

Expected: FAIL because the summary parser/combiner does not exist and the browser ignores the summary.

- [ ] **Step 4: Implement the minimal pure rules**

Parse only the exact normalized form `Positions: +N / -N`. Both zero is flat; exactly one nonzero side is open with a signed count; both sides nonzero, malformed input, or multiple candidates is unknown. Combine sources by accepting agreement, using either unambiguous source when the other is unavailable, and returning unknown on conflict.

- [ ] **Step 5: Gather both sources in one browser evaluation**

Extend the existing bounded DOM traversal to return `{ ticketCandidates, summaryCandidates }`. Require the summary element to be visible and its full normalized text to match the exact counter form. Pass both classifications through `combineBrokerPositionSources`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 3 command. Expected: all focused tests pass with zero skips under configured Chrome.

- [ ] **Step 7: Run full verification**

```powershell
npx.cmd tsc --noEmit
$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'
npm.cmd test
```

Expected: compiler exit 0 and the complete suite passes.

- [ ] **Step 8: Install and verify safely**

Back up/copy only verified application files, preserve `.env`, `data`, `.tradovate-session*`, logs, screenshots, and backups, start ATLAS in Practice/Paused, and run `/api/browser/position` only when its dedicated Tradovate worker reports connected/logged in. The response must include `placedOrder: false`.

- [ ] **Step 9: Commit if repository state supports it**

```bash
git add src/brokerPosition.ts src/browser.ts test/brokerPosition.test.ts test/fixtures/mock-position.html test/position.browser.test.ts docs/superpowers/specs/2026-07-15-atlas-broker-position-reconciliation-design.md docs/superpowers/plans/2026-07-15-atlas-top-positions-counter.md
git commit -m "feat: reconcile Tradovate top position counts"
```

If this working directory is not a usable Git repository, continue without manufacturing repository state.
