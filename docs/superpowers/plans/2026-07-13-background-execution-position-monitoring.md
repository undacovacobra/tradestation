# ATLAS Background Execution, Position Monitoring, and Remote Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make minimized Tradovate execution independent of compositor waits, close rotations only on broker-confirmed flat position, and add a Remote Access switch.

**Architecture:** `TradovateBrowser` will provide exact page-side order dispatch and a signed position reader. `ConnectionWorker` remains the serialized broker boundary. `TradeCoordinator` owns position-driven finalization; the registry owns a persistent remote-access preference.

**Tech Stack:** TypeScript, Express, Playwright, Zod, Node test runner, ngrok.

## Global Constraints

- A positive whole-number webhook quantity is mandatory for entry.
- The dispatcher rejects zero, multiple, or disabled market controls.
- Only a broker-confirmed nonzero-to-zero transition can finalize a non-simulated trade.
- Remote Access OFF disconnects ngrok without stopping ATLAS or Tradovate.
- Simulator only is used for the visible/minimized timing comparison.

---

### Task 1: Background-safe broker primitives

**Files:**
- Modify: `v4/src/browser.ts`
- Modify: `v4/src/workers.ts`
- Test: `v4/test/browser.test.ts`
- Test: `v4/test/v4-entry-preparation.test.ts`

**Interfaces:**
- Produces: `extractPosition(text: string): number | null`
- Produces: `TradovateBrowser.dispatchOrder(action, label): Promise<{ dispatchMs: number }>`
- Produces: `TradovateBrowser.readSelectedPosition(): Promise<number | null>`

- [ ] Write failing tests that assert `extractPosition("POSITION -3") === -3`, `extractPosition("POSITION 0") === 0`, and that disabled or duplicate `Buy Mkt` controls reject before dispatch.
- [ ] Run `npm.cmd test -- --test-name-pattern="extractPosition|dispatchOrder"` and verify the tests fail because the functions do not exist.
- [ ] Implement the parser and a single page-side selector that finds visible exact `Buy Mkt`/`Sell Mkt`, requires one enabled element, calls `HTMLElement.click()`, and returns elapsed dispatch milliseconds. Extend the adapter and worker to return dispatch timing.
- [ ] Run `npm.cmd test -- --test-name-pattern="extractPosition|dispatchOrder"` and verify the tests pass.
- [ ] Commit with `git commit -m "Use verified background-safe broker dispatch"`.

### Task 2: Broker-confirmed trade lifecycle

**Files:**
- Modify: `v4/src/models.ts`
- Modify: `v4/src/workers.ts`
- Modify: `v4/src/coordinator.ts`
- Modify: `v4/src/server-v4.ts`
- Test: `v4/test/v4-coordinator.test.ts`
- Test: `v4/test/v4-entry-preparation.test.ts`

**Interfaces:**
- Extends: `OpenPoolTrade` with `positionConfirmedAt?: string` and `exitRequestedAt?: string`
- Produces: `TradeCoordinator.monitorBrokerPositions(): Promise<TradeResult[]>`
- Produces: `TradeCoordinator.requestExit(poolId, alert, rotation): Promise<TradeResult>`

- [ ] Write a failing test where a close webhook invokes broker Exit but leaves `openTrade` set, and a failing test where a queued position sequence `[1, 0]` finalizes a trade only after two monitor calls.
- [ ] Run `npm.cmd test -- --test-name-pattern="close webhook requests|broker monitor finalizes"` and verify both tests fail.
- [ ] Record entry as pending broker confirmation. Have the monitor read only the active worker’s selected account: nonzero stores `positionConfirmedAt`; zero after confirmation reads settled equity, records close, applies pass/winner handling, advances, and pre-arms. Store `exitRequestedAt` for a close webhook but do not call `recordClose` there. Send Telegram action-needed notification after repeated unreadable position results.
- [ ] Run `npm.cmd test -- --test-name-pattern="close webhook requests|broker monitor finalizes"` and verify the tests pass.
- [ ] Commit with `git commit -m "Finalize rotations from broker positions"`.

### Task 3: Persistent Remote Access switch

**Files:**
- Modify: `v4/src/models.ts`
- Modify: `v4/src/registry.ts`
- Modify: `v4/src/server-v4.ts`
- Modify: `v4/public/index.html`
- Modify: `v4/public/app.js`
- Test: `v4/test/v4-registry.test.ts`
- Test: `v4/test/v4-ui.test.ts`

**Interfaces:**
- Extends: `RegistryData` with `remoteAccessEnabled: boolean`
- Produces: `Registry.setRemoteAccessEnabled(enabled: boolean): RegistryData`
- Produces: `POST /api/remote-access` with `{ enabled: boolean }`

- [ ] Write failing tests that persist `remoteAccessEnabled: false`, assert the dashboard has `id="remote-access-toggle"`, calls `/api/remote-access`, and renders `Local only` guidance.
- [ ] Run `npm.cmd test -- --test-name-pattern="remote access preference|Remote Access"` and verify the tests fail.
- [ ] Implement the preference and endpoint. ON stores true then connects ngrok; OFF stores false then disconnects ngrok. Gate the ngrok health-loop reconnect on `registry.remoteAccessEnabled`. Render the status, public address when connected, and local-only warning/copy behavior when off.
- [ ] Run `npm.cmd test -- --test-name-pattern="remote access preference|Remote Access"` and verify the tests pass.
- [ ] Commit with `git commit -m "Add persistent remote access switch"`.

### Task 4: Verification, deployment, and simulator comparison

**Files:**
- Modify: `v4/README.md`
- Modify: `v4/SETUP-GUIDE.md`

- [ ] Document dynamic quantity, broker-confirmed exits, and Remote Access OFF behavior.
- [ ] Run `npm.cmd test`, `npm.cmd run typecheck`, and `git diff --check`; require zero test failures and zero type errors.
- [ ] Verify all pools are flat, deploy source/public files to `C:\Users\TheTr\Downloads\tradestation-v4-latest\v4` preserving `.env`, `data`, `.sessions`, and screenshots, then restart the local service.
- [ ] Use Computer Use to run a one-contract simulator entry/flat timing with Tradovate visible and again minimized. Record accepted-webhook-to-click plus broker-flat confirmation timing. No live account or live mode is used.
- [ ] Commit documentation and push `main`.
