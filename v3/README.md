# ATLAS

ATLAS is a local Tradovate execution manager. It preserves the V3 dashboard
and account rotation workflow while supporting multiple prop-firm credentials
without consuming multiple Tradovate sessions for the same username.

## Execution model

- One persistent browser context is used per saved Tradovate credential.
- Every credential has an Evaluation lane and a Funded lane, each with its own
  rotation state, Next account, ATM preset, open-trade record, and webhook.
- Accounts using the same username/password share that credential and its one
  browser context. Accounts from another prop firm or username use another
  saved credential and context.
- A credential has one priority queue. Close work is first, then Funded entry,
  Evaluation entry, Funded maintenance, Evaluation maintenance, and diagnostics.
- An Evaluation-only alert waits 75 ms by default so a nearly simultaneous
  Funded alert can take priority. Set `FUNDED_PRIORITY_WINDOW_MS` to change it.
- ATLAS contains a no-order two-ticket independence probe, but current
  Tradovate equity is global rather than ticket-scoped. Credentials therefore
  remain honestly labeled `SEQUENTIAL` until lane-safe balance ownership can
  also be proved. If two independent ticket modules are actually open, live
  clicks fail closed; use one ticket module for that credential. With one
  ticket, ATLAS switches and verifies the account immediately before each
  action. Distinct credentials still execute concurrently.
- Tradovate is the only platform implemented. The session-adapter boundary is
  intentionally ready for a future TopstepX adapter.

ATLAS starts in Practice mode after installation. Practice mode evaluates and
logs webhook behavior but never clicks Buy, Sell, or Exit.

## Webhooks

The dashboard prints the exact URL beside every credential lane.

| Scope | Path | Behavior |
| --- | --- | --- |
| One Evaluation lane | `/webhook/:credentialId/evals` | Dispatch only that credential's evaluations |
| One Funded lane | `/webhook/:credentialId/funded` | Dispatch only that credential's funded accounts |
| Both lanes for one credential | `/webhook/:credentialId` | Funded is submitted first, then evaluations |
| All Evaluation lanes | `/webhook/evals` | Dispatch evaluations for every enabled credential |
| All Funded lanes | `/webhook/funded` | Dispatch funded for every enabled credential |
| Every lane | `/webhook` | Dispatch funded first, then evaluations, across all credentials |

Unknown credentials return 404. If some targeted lanes succeed and others
fail, ATLAS returns 207 with a result for every lane. If all fail it returns
409. The incoming webhook secret is required by every route.

Example strategy alert:

```json
{
  "secret": "your-webhook-secret",
  "action": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "quantity": 1,
  "tradeId": "{{strategy.order.id}}",
  "marketPosition": "{{strategy.market_position}}"
}
```

`marketPosition: "flat"` is treated as a close. `long` or `short` is an entry.
Each targeted lane enforces one recorded open trade at a time. Include a stable
`tradeId` whenever possible: completed ids are retained for seven days so a
TradingView retry remains idempotent even after an ATLAS restart. Browser
execution supports market alerts only; a limit alert is rejected rather than
silently changed into a market order.

## Broker-authoritative trade completion

- Webhooks request entries and exits, but they do not prove that the broker
  opened or closed the position.
- While a live trade is recorded, ATLAS reads the verified account's actual
  Tradovate position value every active monitor tick. It understands both the
  order-ticket `Position` field and Tradovate's separate top `Positions`
  counter.
- If Evaluation and Funded trades are open under one login, ATLAS visibly
  switches between the exact accounts, verifies each selection, and reads one
  position/equity snapshot at a time. Funded is always checked first.
- A nonzero signed value means the broker position is open. Two consecutive
  explicit zero readings are required before ATLAS records the close, clears
  the account lease, and rotates.
- An ATM exit, max-drawdown liquidation, or other broker-side exit therefore
  completes automatically even when no close webhook arrives.
- Missing, hidden, malformed, ambiguous, disconnected, or wrong-account
  evidence is `UNKNOWN`; it is never treated as flat by timeout or absence.
- The first unknown reading is logged. An unresolved position/session/monitor
  incident sends one action-needed notification, stays visible on the
  dashboard, retries automatically, and cannot alert again until two healthy
  checks resolve it. It never pauses ATLAS.
- A matching close webhook is retained as a bounded backup. Broker evidence
  remains primary, but after at least two unknown reads and a five-second
  grace period the close webhook may complete that exact lane/trade. Any
  explicit nonzero broker position vetoes the fallback and requests Exit.
- An Exit click keeps the open-trade safety lease until the broker confirms
  flat. Duplicate close webhooks cannot rotate the trade twice.
- After a restart, ATLAS restores the lease, reconnects the saved session, and
  reconciles the real broker position instead of requiring a manual reset.
- Practice mode is explicitly `SIMULATED` and does not read a live account's
  zero position to erase a simulated trade.

The dashboard shows `OPEN +N`, `OPEN -N`, `FLAT CHECK 1/2`, `FLAT`,
`UNKNOWN`, or `SIMULATED` per lane. **Test position reader** performs the same
read-only, account-verified cycle for a login—Funded first, then Evaluation—and
reports the account, position, equity, and timing. It never clicks Buy, Sell,
Exit, or the ATM control.

## ATM defaults and preparation

- New Evaluation accounts default to ATM preset `25`.
- New Funded accounts default to ATM preset `funded`.
- A custom per-account ATM value is preserved during migration and can be
  edited from the dashboard.
- When an account becomes Next, ATLAS prepares its account and ATM while idle.
  A live entry is blocked unless the exact account and ATM can be verified.
- Webhook quantity is authoritative: it is force-written and re-read on the
  visible ticket immediately before every entry, even if a person changed it.
- Immediately before Buy/Sell, ATLAS atomically persists the exact credential,
  lane, account, symbol, side, quantity, and entry balance. It marks the click
  afterward; either state remains broker-reconciled exposure after a crash.
- Account additions, moves, reactivation, ATM edits, and rotation changes
  invalidate and re-arm the affected lane.

## Evaluation winners and the futures day

- Evaluation accounts that close with positive settled P/L are marked
  **WON TODAY** and rest for the remainder of the futures trading day.
- The reset is 6:00 PM US/Eastern by default, not midnight. At rollover ATLAS
  automatically returns rested evaluations to rotation and re-arms the lane.
- The account row also has **Mark won / rest today** and **Put back in
  rotation** controls. Funded accounts are never benched by this policy.
- The $53,000 evaluation target remains separate: reaching it requests an
  account-verified flatten and retires the evaluation after broker-flat proof.

## Setup and operation

1. Install Node.js 22 and run `npm install`.
2. Copy `.env.example` to `.env` and set at least `WEBHOOK_SECRET`.
3. Run `npm start` or double-click `Start Trading Bot.cmd`.
4. Open `http://localhost:3400/`.
5. Add one saved credential for each distinct Tradovate username/password,
   connect it, and complete login or 2FA in the opened browser once.
6. Keep ATLAS in Practice, scan or add accounts, verify each Next account and
   ATM, then test the exact webhook URLs shown on the dashboard.

Scan recognizes account ids from different Tradovate prop-firm prefixes; it is
not limited to LFE/LFF labels. The dashboard keeps global Evaluation and Funded
webhook URLs visible and puts per-login URLs inside each credential card.

The browser session folders, `.env`, account settings, rotations, balances,
and open-trade records are local. Do not copy them into source control.

## Safety and verification

- LIVE mode is an explicit dashboard choice and carries real-money risk.
- A failed readiness, account, ATM, quantity, or login verification blocks the
  entry instead of guessing.
- A recorded open trade prevents background preparation, but reconnect is
  allowed so ATLAS can verify and reconcile the real broker position.
- The no-order simultaneous test changes prepared quantities only; it does not
  place an order.
- Start a release with `npm test`, then run `tsc --noEmit`. Browser-backed tests
  use the Chrome path in `PW_CHROMIUM` when Playwright Chromium is not bundled.

Useful commands:

```powershell
npm start
npm test
$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm test
node node_modules/typescript/bin/tsc --noEmit
```

## Remote access and notifications

The existing ngrok and Telegram settings remain supported. Set
`NGROK_AUTHTOKEN` and `NGROK_DOMAIN` for remote access. Set
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for action-needed notifications.
Keep `DASHBOARD_PASSWORD` set whenever the dashboard is exposed beyond the
local computer.
