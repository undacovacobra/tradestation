# V4 Multi-Login Control Center Design

## Goal

Upgrade V4 from a configuration-oriented status page into a visual control center that supports any practical number of independent Tradovate logins, one combined rotation across those logins, safe pool concurrency, persisted balance visibility, and an evaluation-only automatic close at a $53,000 balance.

The existing V4 webhook routing, explicit account identity, pool rotations, per-login serialization, and execution lanes remain the foundation. V2 and V3 remain untouched.

## Approved product choices

- Use the visual **Control Center** layout (mockup option A).
- Support unlimited Tradovate logins in this release. Keep the adapter boundary ready for TopstepX later, but do not guess TopstepX controls now.
- Use smart hybrid balance collection: trade-path readings plus a safe manual refresh, with no constant all-account background sweep.
- Apply the $53,000 automatic-close target only to evaluation pools. Funded pools display balances but do not close at that target.
- Do not require server restarts or JSON editing when a login is added.

## Runtime architecture

### Dynamic connection manager

Replace the startup-only worker map with a `ConnectionManager` that owns the live workers. It creates a worker for every enabled registry connection at startup and can add or remove workers while the server remains running.

Each connection has:

- A stable connection ID.
- A friendly login name and firm.
- The Tradovate adapter and URL.
- A unique persistent Chromium session directory.
- Its own serialized action queue.
- Health state: ready, login required, busy, disconnected, or error.

Adding a login writes the connection atomically to the registry, creates its worker immediately, and makes it available to the dashboard and onboarding flow without restart. Removing a connection is rejected while it has accounts or an open trade.

### Browser and trade priority

All operations for one login pass through its worker queue. Trade entry, trade close, and active-trade balance monitoring have priority over maintenance work. Separate login workers may run concurrently. Pool execution lanes continue to determine whether separate pools may hold trades simultaneously.

A manual balance sweep may switch accounts only on a login that has no recorded open trade. A login with an open trade reads only the already-selected trading account until that trade is closed.

## Registry and persisted state

Extend pool configuration with an optional `balanceTarget` number. The shipped evaluation pool uses `53000`; the funded pool omits the target. Stage alone does not silently enable a target, so future pool behavior remains explicit.

Persist balances by V4 account ID rather than only by on-screen platform label. Each record contains:

- Last-known balance.
- Reading timestamp.
- A bounded balance history.

Pool state continues to persist next account, open trade, daily bench state, and trade history. Account and pool edits are atomic. Existing V4 registries migrate without losing accounts, order, pool membership, connection settings, or state.

## Login and account onboarding

The onboarding page gains **Add another login**. Its wizard collects:

- Login name.
- Firm name.
- Tradovate environment or URL.
- Optional account-label pattern, with the existing safe default.
- Auto-connect preference.

V4 generates the ID and session directory, saves the connection, creates the worker, and offers **Open browser**. The user completes login or MFA in that dedicated Chromium window, scans accounts, assigns friendly names and stages, and attaches each account to one or more pools.

The connection selector lists all configured logins. Reopening one connection always reuses that connection's own session. Accounts from multiple connections can be ordered in one pool.

## Control Center

The main page uses the approved Control Center layout:

- Top summary: running/practice-live state, connection health, evaluation state, funded state.
- Connection rail: every saved login, firm/platform, account count, ready/login-required/busy/error state, connect action, and Add Login action.
- Pool selector and pool header: webhook path, execution lane, flat/open state, next account, balance target when present.
- Ordered account table: order, friendly name, firm, login, stage, exact platform label, last-known balance, update age, target progress, and status.
- Activity and trade history: recent routing, connection, balance, close, and error events.

Pool account controls include set next, move up/down, hold/reactivate, move to another pool, remove from pool, mark passed, and view history. Actions that can disrupt a live position are blocked while the affected pool or account is trading.

## Balance lifecycle

The Tradovate adapter exposes safe balance-reading capabilities through the worker interface.

1. Before a live entry, V4 switches to the selected account and reads its balance.
2. After the entry is recorded, the active monitor reads only the already-selected account at the configured monitor interval.
3. After a normal close, V4 waits for settlement and stores a final reading.
4. **Refresh balances** queues a safe sweep for idle logins. Logins with open trades are skipped and reported as deferred.

Every dashboard balance is labeled last-known and includes its timestamp. Missing or stale balances are visually distinct and are never represented as live.

## Evaluation automatic close

When an open trade belongs to a pool with `balanceTarget: 53000` and the selected account balance is at least $53,000:

1. The monitor requests a target close through the coordinator and the connection's serialized worker.
2. V4 clicks **Exit at Market** on the already-selected account.
3. Only after the close action succeeds does V4 read the settled balance, record the close reason, clear the open trade, advance the rotation, and mark the account passed/benched.
4. A Telegram success notification and dashboard event record the target close.

Funded pools have no balance target and never trigger this automatic close.

If the close fails, V4 leaves the pool locked on the open account, does not advance, records a critical dashboard event, and sends a Telegram action-needed notification. Recovery may clear blocking popups and retry through the same serialized worker, but it may not repeatedly click Exit without checking the current state.

## Safety and error handling

- External webhooks continue requiring the `.env` secret. Direct local setup actions remain automatically trusted.
- Disconnected logins reject live entries rather than guessing.
- Duplicate webhook protection remains pool-specific.
- Same-lane overlap and shared-account locks remain enforced.
- Removing a connection is blocked when accounts or open trades reference it.
- Balance maintenance never switches an account away from a recorded live trade.
- Failed close attempts never make the bot claim a position is flat.
- Clearing remembered trade state, removing a login, and switching to live require explicit confirmation in the UI.
- Practice mode exercises routing, persistence, dashboard status, and simulated close behavior without order clicks.

## API boundaries

Add local-admin endpoints for connection creation/removal, pool/account mutations, safe balance refresh, and detailed status. Keep trade webhooks separate and secret-protected.

The status response supplies presentation-ready connection, pool, account, balance, target-progress, open-trade, history, and event data. Browser adapter objects and secrets are never exposed to the client.

## Verification

Automated tests cover:

- Adding multiple dynamic connections without restart and restoring them after restart.
- Preventing removal of referenced or trading connections.
- One serialized queue per login and concurrency across separate logins.
- One pool rotating in order across accounts on multiple logins.
- Different-lane concurrency and same-lane exclusion.
- Balance capture before entry, during an open trade, and after close.
- Evaluation target close at exactly and above $53,000.
- No target close below $53,000 or for funded pools.
- No balance sweep switching away from an open-trade login.
- Failed target close preserving the open state and rotation position.
- Persisted account order, status changes, balances, and history.
- Dashboard and onboarding API behavior.

Existing Chromium smoke tests remain, with targeted coverage for scanning, switching accounts, reading equity, entry, and exit selectors when Chromium is available. Type checking, the complete automated suite, HTTP smoke checks, and an in-browser visual inspection are required before publishing.

## Delivery

Commit the upgrade to the existing `agent/tradestation-v4` branch and update the existing draft pull request. Update the user's downloaded V4 copy while preserving its `.env`, eight scanned evaluation accounts, pool order, and browser session data. Restart the local server and verify the Control Center at `http://localhost:3500`.
