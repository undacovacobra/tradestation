# ATLAS Operations and Concurrent Trading Design

## Goal

Turn the V4 interface into **ATLAS — Account Trading Lane Automation System** and make its operational state immediately understandable: which saved logins are ready, which accounts belong to each login, whether a dry-run webhook succeeded, and when Telegram must ask the user for help. Preserve account-specific ATM correctness when evaluation and funded webhooks arrive together.

The existing V4 registry, connection workers, pool rotations, execution lanes, account locks, webhook authentication, and balance history remain the foundation. V2 and V3 remain untouched.

## Approved product behavior

- Replace the main-page title `V4 Control Center` with `ATLAS`.
- Replace the eyebrow `MULTI-FIRM ORCHESTRATOR` with `ACCOUNT TRADING LANE AUTOMATION SYSTEM`.
- Apply the ATLAS name consistently to the onboarding page and browser titles without renaming configuration files, API routes, or persisted V4 data.
- Show every logged-in saved session and the configured accounts attached to it near the top of the main dashboard.
- Show a pool-specific success or failure result directly beneath the Test webhook control.
- Repair Add another login so its form reliably opens, validates, saves, selects the new login, and explains the next action.
- Carry V3's deliberate Telegram action-needed notifications into the active V4 server while avoiding routine noise.
- Allow evaluation and funded pools on different execution lanes to hold trades simultaneously.

## Login and account visibility

The main dashboard adds a login-session strip below the header and above the pool summaries. Each saved connection renders one card with:

- Friendly login name and firm.
- `Logged in`, `Login required`, `Connecting`, or `Error` state.
- The configured account names and exact platform labels attached to that connection.
- The currently selected account when the browser reports one.
- A clear empty state when a login has no configured accounts.

An account is listed under a connection because it is assigned to that saved browser session in the registry. The UI must not claim that every account is simultaneously selected in Tradovate. The card distinguishes the session's available/configured accounts from the one currently selected trading account.

The status API supplies these account lists as presentation-ready connection data. It never exposes Telegram credentials, webhook secrets, browser objects, or session-directory contents.

## Pool-specific webhook test feedback

Each pool panel owns an independent test-result element directly beneath its webhook buttons. Clicking Test webhook immediately displays an in-progress message and disables only that pool's test button until the response returns.

The final result uses explicit styling and language:

- Green: `SUCCESS — ...`
- Red: `FAILED — ...`

The result remains visible until that pool is tested again. One pool's test must not overwrite another pool's result or the unrelated global action message.

The server-side dry run selects the pool's next eligible account and runs the account preparation path through the appropriate connection worker: confirm login readiness, select the exact account, apply the account's configured TP/SL dollars, and verify Tradovate persisted those values. It must not set quantity or click Buy, Sell, Exit, or any other order-producing control. The response always states that no trade was placed.

Failure returns the exact actionable reason, creates a dashboard event, and may send a deduplicated Telegram action-needed notification when human action is required. A successful dry run creates an informational dashboard event but does not send routine Telegram noise.

## Concurrent eval and funded entries

### Execution lanes

Evaluation and funded pools must retain distinct execution-lane values when they are intended to trade at the same time. The existing lane lock continues to prevent simultaneous open trades only when two pools intentionally share a lane. The existing account reservation prevents the same account from being selected by two pools.

### Different saved logins

Each saved login owns an independent browser context and `ConnectionWorker`. Signals routed to different workers may execute in parallel. A slow or blocked login must not serialize an unrelated login.

### Same saved login

A single Tradovate browser can only have one selected account and one visible ATM configuration at a time. All operations for that login therefore pass through its existing worker queue. Simultaneous pool signals are processed in rapid sequence, never with interleaved browser actions.

The complete entry-critical section for one account is:

1. Acquire the connection worker queue.
2. Confirm the session is connected and logged in.
3. Select the exact account platform label.
4. Read the entry balance without releasing the queue.
5. Apply that account's take-profit and stop-loss dollars.
6. Reopen ATM Settings and verify the saved values exactly match the account configuration.
7. Set and verify order quantity.
8. Reconfirm that the selected account is still the intended account.
9. Click the requested Buy or Sell control.
10. Release the worker queue only after the click completes or the operation aborts.

Balance refresh, pre-arming, another pool, and maintenance work cannot run inside this critical section. A mismatch or inability to verify account, bracket, or quantity aborts before the order click, preserves the pool rotation state, records an error, and sends an action-needed Telegram message.

### Pre-arming semantics

One browser session can physically pre-arm only one account at a time. The worker's armed signature remains authoritative and includes account ID, platform label, TP, and SL. If any part differs when a signal reaches the queue, ATLAS performs full preparation and verification inside the critical section before trading.

Pre-arming is a latency optimization, never a correctness assumption. A later pre-arm for another pool invalidates the earlier signature. Every live entry either proves the exact signature is still current or rebuilds it before clicking.

After an entry, ATLAS may prepare a next account only through the same worker queue. That preparation cannot change the exchange-held bracket already attached to an existing order or position, and it cannot run concurrently with another entry or close.

## Telegram operational alerts

V4 already contains the shared Telegram sender and environment configuration. ATLAS connects it to the active V4 coordinator and lifecycle paths rather than the legacy single-login server only.

Action-needed messages are sent for:

- A saved login cannot open, recover, or complete login automatically.
- A login leaves the trading screen while a V4 trade is recorded as open.
- A blocking popup cannot be dismissed.
- Account selection, ATM preparation, ATM verification, quantity verification, entry, or close fails.
- A live webhook is rejected because its required login is unavailable.
- A balance-target close or balance monitor fails in a way that needs human intervention.
- ATLAS restarts while its persisted state says a trade remains open.

Good-news messages are sent for:

- An evaluation account reaches its configured balance target and is retired.
- A closed trade is positively identified as a win using settled balance data.

Routine startup, successful pre-arms, test-webhook success, balance refresh success, and ordinary status changes remain silent. Existing identical-message deduplication remains in force. Telegram delivery is fire-and-forget: a Telegram outage is logged but never changes trade execution or rotation state.

## Add another login repair

The onboarding page keeps the existing inline creation form. The button reliably toggles it using both the `hidden` state and an explicit visibility class so cached styling cannot leave the panel stuck. Opening the form moves focus to Login name and scrolls the panel into view.

Client and server validation require a non-empty login name and firm. The UI shows validation or server errors beside the form. During creation, the save button is disabled and shows progress. On success, ATLAS:

1. Saves the connection and creates its live worker without restarting.
2. Reloads status.
3. Selects the new connection in the connection picker.
4. Leaves the form visible with a success message.
5. Presents the next action: connect the browser, complete login/MFA, and scan accounts.

Repeated clicks cannot submit duplicate requests. Existing connection IDs, registry accounts, pools, session directories, and browser profiles remain unchanged.

## Error handling and safety

- External webhook routes continue requiring the configured secret.
- Dry-run webhook routes remain local/admin operations and never place orders.
- A failed preparation never advances a pool or records an open trade.
- A failed close never clears recorded open-trade state.
- Telegram failures never affect trading.
- HTML output continues escaping connection, firm, account, pool, webhook, and error text.
- Existing open-position restrictions on account deletion, connection removal, and balance sweeps remain in force.
- The dashboard labels configured accounts separately from the currently selected account to avoid a misleading login claim.

## Verification

Automated tests must prove:

- Status presentation groups configured accounts under the correct saved login.
- Branding renders ATLAS and the full name on the dashboard and onboarding page.
- Test results are isolated per pool and render explicit in-progress, success, and failure states.
- A dry-run test performs account and ATM preparation but never invokes quantity or an order click.
- Two workers execute independent entries concurrently.
- Two simultaneous entries on one worker never interleave.
- Same-worker entries with different eval and funded brackets verify the correct bracket immediately before each order click.
- Account, bracket, or quantity verification failure prevents the order click and preserves rotation state.
- Action-needed Telegram calls cover login, preparation, entry, close, recovery, restart-with-open-trade, and monitor failures.
- Good-news Telegram calls cover evaluation retirement and confirmed wins.
- Telegram failures do not change coordinator results.
- Add another login opens, validates, prevents duplicate submission, creates the connection, selects it, and leaves clear next steps.

The full V4 test suite and TypeScript build must pass. Browser verification must cover the ATLAS header, login-account strip, pool-local webhook feedback, and Add another login form. A safe simulated concurrency test must run without broker order clicks before deployment. The user's live Tradovate session must not be used for an order-producing verification.

## Delivery

Commit the implementation to the existing mainline repository, update the user's installed V4 copy while preserving `.env`, registry data, pool state, balance history, and browser-session directories, restart the local server, and reload `http://localhost:3500`. Do not send a live broker order or external TradingView signal during deployment verification.
