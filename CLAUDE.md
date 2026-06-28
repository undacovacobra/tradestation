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

## Current status (2026-06-28)
**Working & verified:**
- Rotation logic (cycle accounts, one open round-trip at a time, advance + wrap,
  optional once-per-day). Unit-tested (`npm test`, 4/4 pass).
- Webhook server (secret-protected, validates payloads, serializes orders).
- Live Tradovate **account switching** (verified on the user's two demo accounts).
- **Auto-login** (clicks "Login" → "Start Simulated Trading" → chart), hands-free.
- **Size-from-alert** — bot types the alert's `quantity` into the size box before
  Buy/Sell. Verified safe (`npm run sizetest 3`) and confirmed at "Order size confirmed at 3".
- **Live buy → close test PASSED** (2026-06-28) on the live market, demo accounts,
  size 1 — set size → Buy Mkt → Exit → rotate, all working end to end.

**Pending:**
- **Connect TradingView** for real: tunnel (Cloudflare/ngrok) + webhook URL + test alert.
  This is the next big step — get a live alert to actually reach the running bot.
- **Migration** (mostly moot now): the user RUNS from `C:\Users\tjero\folder-finder\trading-bot`
  (a subfolder of the `undacovacobra/folder-finder` repo). The bot's own repo is
  `undacovacobra/tradestation`. To deliver tradestation code into the running folder we
  added a git remote `ts` and pulled individual files via
  `cmd /c "git show ts/<branch>:<path> > <localpath>"` (paths differ: tradestation has
  src/ at root; folder-finder has trading-bot/src/). Login/accounts/.env live only in the
  running folder. A clean future migration = fresh clone of tradestation + copy over .env,
  data/accounts.json, and .tradovate-session.

## Key facts & decisions
- **One Tradovate login, many accounts.** Bot switches the active account in the UI.
- **Advance after one round-trip** (entry + its exit). Exit is driven by the strategy's
  **exit alert**, which the user confirmed is reliable.
- TradingView **Premium**, alerts carry full order details.
- Accounts are **real Lucid Trading prop accounts** (eval + funded), NOT fake money —
  be careful. Test only on demo / Tradovate "Simulation" mode.
- **`LFE…` = Evaluation, `LFF…` = Funded.**
- Demo accounts used in testing: `LFF05079261220001` and `LFE05079261220005`.
- **The bot does NOT set the symbol** — the user picks ONE fixed contract on the
  Tradovate chart (e.g. MESU6). The bot does NOT type tickers (robustness choice; the
  user confirmed they only ever trade one ticker).
- **The bot DOES set the contract size (quantity) from the alert.** Each TradingView
  alert carries a `quantity`; before clicking Buy/Sell the bot types that number into the
  size box next to Buy/Sell. The size box is an **editable combobox** (shows e.g. "1",
  presets 1/2/3/4/5/10/15/20/25, but accepts any typed number). Implemented in
  `setQuantity()` in `src/executor/tradovate.ts`: it finds the small numeric `<input>` in
  the top toolbar, fills it, presses Enter, then reads it back to confirm. If it can't
  confirm the size it throws (skips the trade rather than sending the wrong size).
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
- `npm run sizetest 3` — SAFE: set the size box to 3, no order (any time, market closed OK)
- `npm run smoketest [size]` — LIVE: buy→close on each account at `size` (default 1;
  needs market open; demo only). Use a non-1 size to prove size-from-alert works.
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
