# Tradovate Account-Cycler Bot — Project Guide & Handoff

This file is the project's living context. If you're a new Claude session picking
this up, read it fully first — it lets you continue exactly where the last session
left off, without making the user repeat themselves.

## ⚠️ How to work with this user (important)
- The user is **non-technical** and gets overwhelmed by a lot at once. They asked,
  explicitly: **go one small step at a time, plain language, no big lists, no jargon.**
- Give **exact, click-by-click** instructions. Tell them what to paste and what a
  good result looks like. Wait for them to confirm before the next step.
- Be reassuring. Errors are fine — diagnose from screenshots/output they paste.

## What this is
A non-API trading bot that receives **TradingView webhook alerts** and routes each
trade to a different **Tradovate prop account**, cycling one round-trip at a time.
The firm (Lucid Trading) **blocks API access**, so order execution is done by
**browser automation** (Playwright) of the Tradovate web trader. Runs on the user's
**always-on Windows home PC**. Node 22, TypeScript, Playwright (Chromium).

## ⭐ V2 exists (2026-07-01) — see `v2/`
The user asked for a big upgrade but **kept separate** from the working V1. V2 lives
entirely in the `v2/` folder (own package.json, port **3300**); V1 in the repo root is
untouched and still works. V2 adds:
- **Web dashboard** (`http://localhost:3300`, vanilla HTML/JS served by the same
  Express server): start/pause button, Practice↔LIVE switch with a big red warning
  modal, status pills (running / Tradovate login / mode), live activity feed in plain
  English, optional password login (`DASHBOARD_PASSWORD` in `v2/.env`).
- **Two independent lanes**: `POST /webhook/evals` and `POST /webhook/funded`, one
  `GroupRotation` each (state in `v2/data/state-<group>.json`).
- **Single alert per strategy** (2026-07-02): one TradingView alert handles both
  open and close. Payload carries `marketPosition` (`{{strategy.market_position}}`);
  when it's `flat` the bot closes+rotates, otherwise it opens. `isCloseAlert()` in
  `v2/src/types.ts`. Old two-alert style (`"action":"close"`) still works.
- **Accounts managed on screen** (never by hand): add/remove/reorder/enable per group,
  stored in `v2/data/settings.json` via `SettingsStore`. Plus **"Scan Tradovate
  accounts"**: opens the Tradovate account menu, reads all `LF[EF]…` ids, user ticks
  Evals/Funded (pre-sorted by LFE/LFF prefix).
- **Rotation is label-keyed, not index-keyed** (`v2/src/rotation.ts`) so it survives
  account add/remove/reorder mid-rotation.
- **Daily rule is WIN-based, not trade-based** (2026-07-02): `ONCE_PER_DAY` now
  means an account that closes a WINNER sits out the rest of the (UTC) day
  (`lastWonDay` + `isBenchedToday`); losers/breakeven keep cycling. Win = EQUITY
  read just before entry vs. after close (`executeEntry`/`executeClose` return
  balances; `readSettledBalance()` waits ~1.5s post-close). Only meaningful in
  LIVE (practice moves no money → never a win). Force-close on target passes
  `won:true`. Dashboard shows "😴 WON TODAY" (`restingToday`).
- **Order path sped up + reliable qty control** (2026-07-02): the ~2s fill lag
  was from (a) a 1.5s confirm-modal wait every order, (b) hundreds of per-element
  boundingBox round-trips in the qty scan, (c) a pre-order balance read, (d)
  success screenshots. Fixes: `confirmIfPrompted` waits `ORDER_CONFIRM_WAIT_MS`
  (350); `findQtyControl`/`findQtyOption` are ONE shadow-piercing `page.evaluate`
  each; entry-balance read moved AFTER clickOrder; success screenshots gated by
  `SCREENSHOTS` (failures always shot, `snapshot(name,true)`); switch settle =
  `SWITCH_SETTLE_MS` (300). **⚠️ esbuild/tsx `__name` gotcha**: NO nested named
  functions inside `page.evaluate` (esbuild injects a `__name` helper absent in
  the page → throws, was swallowed by `.catch`). Real-browser regression test
  `test/quantity.browser.test.ts` + `test/fixtures/mock-ticket.html` (shadow DOM)
  guards it; skips if no Chromium.
- **Manual next-account pick** (2026-07-02): `⏭` button per account →
  `POST /api/next` → `rotation.setNext(label)` (only when flat).
- **Event-driven speed architecture** (2026-07-02, after user saw 6-7s fills):
  root cause was the idle balance sweep (switch+read EVERY account, seconds
  long) holding the single serialized browser queue while a webhook waited.
  Fixes: (a) `pendingTrades` counter — webhooks increment it; the sweep is now
  per-account queue jobs that BAIL between accounts when a trade is pending
  (`readAll` impl in server.ts); (b) **pre-arming** — after every close /
  setNext / contracts change / connect / mode→live / sweep end, `armNext(group)`
  selects the next account and pre-sets qty (`browser.armFor`), so an entry is
  just topbar-check → qty-check (no-op) → click Buy/Sell; `switchAccount` has a
  fast path (skips menu when top bar already shows the target);
  (c) `lastAlertGroup` tracks which lane to arm for; (d) **⚡ stopwatch event**
  per webhook ("Handled in Xms (waited Yms)") separates bot latency from
  TradingView/ngrok delivery latency. MONITOR_ACTIVE_SECONDS default 3 (min 1).
  Practice-mode webhook measured 1-19ms server-side.
- **Background balance sweep OFF by default** (2026-07-02, after user saw
  1.7s-11s variance): the every-60s full sweep switched through EVERY account
  (~seconds) and any trade landing mid-sweep waited behind it — the source of
  the variance. Now `monitor.sweep()` when flat does NOTHING unless
  `BALANCE_SWEEP_MINUTES>0` (default 0); during a trade it does the cheap
  top-bar live-account read only (no switching). Heartbeat every
  `MONITOR_ACTIVE_SECONDS` (3s) but only touches the browser when a trade is
  open. Idle balances refresh on Scan + during trades. `$53k` stop still works
  (live-account read). This removes account-switching contention from the trade
  path entirely.
- **Bot now SETS position size** (2026-07-02): per-group "Contracts per trade"
  on the dashboard (`settings.contracts.{evals,funded}`, default 1). Live entry
  calls `browser.setQuantity(n)` which fills Tradovate's order-ticket qty field
  and **reads it back to verify** — throws (→ no order) if it can't confirm, so
  a wrong size can't fire. Alert `quantity` is ignored for sizing (handleEntry
  overrides `order.quantity = store.contractsFor(group)`). "Test size on
  Tradovate" button (`/api/test-quantity`) sets+verifies with no order. ⚠️
  `setQuantity` selector is heuristic/unverified (getByRole spinbutton →
  number input → qty-ish attrs); saves `set-quantity-failed` screenshot on miss.
- **Trading-day boundary is 6pm ET, not midnight** (`v2/src/tradingDay.ts`,
  `tradingDayKey`): futures session reset. Configurable via `TRADING_DAY_TZ`
  (default America/New_York) + `TRADING_DAY_RESET_HOUR` (default 18); server
  injects `tradingDay()` into both `GroupRotation`s; DST-aware. 22 tests pass.
- **Practice mode is the default** and persisted; LIVE requires a confirm flag on the
  API and a warning modal in the UI. Pause makes webhooks no-ops.
- Browser automation unchanged from V1 (same confirmed UI labels, one shared
  serialized queue for both lanes + scans) — still **no API**. Browser is now
  connected from the dashboard ("Connect browser"), independent of trade mode.
- **Remote access built in** (2026-07-02): dashboard **"Remote access"** button
  turns the ngrok tunnel on/off in-process via the official `@ngrok/ngrok` SDK
  (`v2/src/tunnel.ts`), no separate ngrok window/command. Configured by
  `NGROK_AUTHTOKEN` + `NGROK_DOMAIN` in `.env`; auto-starts on boot
  (`NGROK_AUTOSTART`, default true). SDK is an **optionalDependency** loaded
  lazily, so a failed/absent install never breaks the bot (button just reports
  unavailable; CLI ngrok remains a fallback). User's domain:
  `antennae-compress-panning.ngrok-free.dev`.
- **Friendlier startup**: `Start Trading Bot.cmd` launches the bot in its own
  window and opens the dashboard; remote access comes up on its own. Only the
  initial double-click is unavoidable (can't start a program from a web button
  that isn't running yet).
- **Account monitor** (2026-07-02, `v2/src/monitor.ts`): while the browser is
  logged in, re-reads the Tradovate account menu on an **adaptive cadence** —
  `MONITOR_SECONDS` (60s) idle, `MONITOR_ACTIVE_SECONDS` (5s) while any trade is
  open (self-scheduling `tick()`), so the target stop reacts fast on the live
  account. **Balance = Tradovate's top-bar "EQUITY"** for the SELECTED account
  (confirmed 2026-07-02 from user screenshots — the account MENU shows no
  dollars, only "Demo & Active"). `readSelectedAccount()` reads the top bar
  (cheap, used during a trade since the live account is already selected);
  `readAllBalances()` cycles every account (menu ids → switch → read top bar,
  idle cadence + Scan); `extractEquity()` parses the number after "EQUITY".
  **Scan** uses `readAllBalances` + `monitor.scanIngest()` so balances populate
  immediately on scan. Powers: (a) balance + history per
  account (`data/balances.json`) with sparkline, "$X to go", shown on the
  dashboard; (b) auto-adding accounts that appear in Tradovate (LFE→evals,
  LFF→funded); (c) **eval profit target** (`evalTarget` in settings.json,
  default $53,000): at/above target → account retired to `status:"passed"`
  (new 🏆 Passed column, excluded from rotation, "Put back in rotation" undo),
  and if it held the open trade the bot **force-flattens without a webhook**
  (`forceClose` in server.ts) + entry-time guard in `handleEntry`. Open-trade
  banner shows the alert's contract count (actual size = Tradovate screen).
  **⚠️ Balance READING is unverified against the real Tradovate UI** — parser
  is heuristic (row text near `LF[EF]…` ids); if the menu shows no dollars the
  bot pushes a warn event and saves a `balances-not-visible` screenshot for
  calibration. 14 unit tests pass (rotation + parser + monitor force-close).
- Login is tolerant of tunnel hiccups (one 401 retry before showing the password
  screen) so the dashboard doesn't flicker over ngrok.
- Windows: double-click `v2/Start Trading Bot.cmd` starts the server and opens the
  dashboard.

**V2 verified in this session (practice mode only):** unit tests, type-check, server
boot, login protection, account add/remove via API, both webhooks (entry/close/
one-open-rule/bad-secret/paused), live-confirm guard, and dashboard rendering
(screenshots via Playwright). **Not yet tested:** anything against the real Tradovate
UI (scan, live clicks) — the confirmed V1 selectors were carried over unchanged.

## Current status of V1 (2026-06-28)
**Working & verified:**
- Rotation logic (cycle accounts, one open round-trip at a time, advance + wrap,
  optional once-per-day). Unit-tested (`npm test`, 4/4 pass).
- Webhook server (secret-protected, validates payloads, serializes orders).
- Live Tradovate **account switching** (verified on the user's two demo accounts).
- **Auto-login** (clicks "Login" → "Start Simulated Trading" → chart), hands-free.

**Pending:**
- **Live buy → close test** (`npm run smoketest`) — needs the **futures market open**
  (~5pm CT / 6pm ET). The user planned to run this on their demo accounts with size 1.
- **Connect TradingView** for real: tunnel (Cloudflare/ngrok) + webhook URL + test alert.
- **Migration**: the user wants this bot to live in its own repo `undacovacobra/tradestation`
  (this code was copied there). They may still have an older clone at
  `folder-finder/trading-bot` that is fully set up (env, accounts, saved login).

## Key facts & decisions
- **One Tradovate login, many accounts.** Bot switches the active account in the UI.
- **Advance after one round-trip** (entry + its exit). Exit is driven by the strategy's
  **exit alert**, which the user confirmed is reliable.
- TradingView **Premium**, alerts carry full order details.
- Accounts are **real Lucid Trading prop accounts** (eval + funded), NOT fake money —
  be careful. Test only on demo / Tradovate "Simulation" mode.
- **`LFE…` = Evaluation, `LFF…` = Funded.**
- Demo accounts used in testing: `LFF05079261220001` and `LFE05079261220005`.
- **The bot does NOT set symbol or quantity** — the user sets the contract and size on
  the Tradovate screen; the bot only switches account and clicks Buy/Sell/Exit. Keep it
  this way (far more robust).
- **Confirmed Tradovate UI labels** (in `src/executor/tradovate.ts`):
  - Login button text: `Login`; environment button: `Start Simulated Trading`
  - Buy: `Buy Mkt`; Sell: `Sell Mkt`; Close/flatten: `Exit at Mkt & Cxl`
  - Account menu: opened by clicking the **account id** in the top bar (matched by the
    `LF[EF]\d{6,}` pattern), then clicking the target account's row.
- Auto-login has a manual fallback if buttons aren't found (won't get stuck).
- Note: Tradovate showed a "clock out of sync" warning — user should enable Windows
  automatic time before live trading.

## Commands
- `npm test` — rotation unit tests (no setup, no broker)
- `npm start` — run the webhook server (EXECUTOR=dryrun is safe; tradovate is live)
- `npm run testhook` — fire sample buy/close alerts at a running server (verify webhook)
- `npm run switchtest` — SAFE: cycle accounts, no orders (any time, market closed OK)
- `npm run smoketest` — LIVE: buy→close on each account (needs market open; demo only)
- `npm run calibrate` — open the trader to log in / inspect the UI

## Setup on a fresh clone (Windows)
1. `npm install`
2. Copy `.env.example` → `.env` (set a long `WEBHOOK_SECRET`; `EXECUTOR=dryrun` to start)
3. Create `data/accounts.json` (copy `data/accounts.example.json`, fill in real account
   ids; the demo two are `LFF05079261220001` and `LFE05079261220005`)
4. `npx playwright install chromium`
5. `npm run switchtest` to verify login + switching

## Roadmap (planned)
- **Per-strategy account groups:** two independent rotations at once — one strategy
  cycles only eval (`LFE…`) accounts, another cycles only funded (`LFF…`). Add a `group`
  field per account + a `group` field in the alert, keep one `AccountRotation` per group.
- Additional cycling filters (to be specified by the user).
- TradingView tunnel + end-to-end webhook test.

## Risk note (already discussed with the user)
The firm blocks the API to stop automation; browser automation likely violates their
Terms and could fail/ban an account. The user understands and accepts this. Don't
re-litigate it every session, but don't pretend the risk isn't there.
