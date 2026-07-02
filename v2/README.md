# Trading Bot V2 — Dashboard Edition

V2 of the account-cycler bot. Everything is controlled from a **web dashboard**
(no terminal needed once it's running):

- Start / pause button, Practice ↔ LIVE switch (with a big warning), status lights.
- **Two independent lanes** with their own webhooks:
  - Evaluation accounts → `POST /webhook/evals`
  - Funded accounts → `POST /webhook/funded`
- Accounts are added / removed / reordered **on screen** (or found automatically
  with "Scan Tradovate accounts"). No files to edit by hand.
- Live activity feed with plain-English messages and errors.

Trades are still placed by **browser automation** (Playwright driving the
Tradovate web trader) — no API is used anywhere. The bot never sets symbol or
quantity; you set those on the Tradovate screen, the bot only switches account
and clicks Buy / Sell / Exit.

V1 (in the repo root) is untouched and still works. V2 uses port **3300** so
both can even run at the same time.

## Setup on the Windows PC (one time)

1. Install Node.js 22 if you haven't (nodejs.org → LTS).
2. Open a terminal in this `v2` folder and run:
   ```
   npm install
   npx playwright install chromium
   ```
3. Copy `.env.example` to `.env` and set:
   - `WEBHOOK_SECRET` — a long random string (also goes in your TradingView alerts)
   - `DASHBOARD_PASSWORD` — the password you'll use to open the dashboard
4. Double-click **`Start Trading Bot.cmd`** (or run `npm start`).
   Your browser opens the dashboard at `http://localhost:3300`.

First-time steps on the dashboard:
1. Click **Connect browser** — a Chrome window opens Tradovate. If auto-login
   doesn't finish, log in there once (the session is remembered).
2. Click **Scan Tradovate accounts** — tick which accounts are Evals / Funded.
3. Stay in **Practice mode** and send a test alert (`npm run testhook`) — you
   should see "PRACTICE — would BUY…" appear in the Activity feed.

## The two webhooks

Each group card on the dashboard shows its own webhook address with a Copy
button. Point your eval strategy's TradingView alerts at the **evals** URL and
your funded strategy at the **funded** URL.

**One alert per strategy handles both opening and closing.** Create a single
TradingView alert on the strategy (fires on every order) with this message:

```json
{
  "secret": "your-webhook-secret",
  "action": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "quantity": 1,
  "marketPosition": "{{strategy.market_position}}"
}
```

How it decides open vs close: TradingView says "buy"/"sell" for every order, so
the bot reads `marketPosition`. When it becomes **`flat`**, the order closed the
trade → the bot flattens and rotates to the next account. Any other value
(`long`/`short`) is treated as a new entry.

> This requires a **strategy** alert (so the `{{strategy.*}}` placeholders fill
> in). The older two-alert style still works too — just send
> `"action": "close"` for the exit.

Each lane keeps its own rotation and its own one-open-trade-at-a-time rule.
The browser still only ever does one thing at a time.

### The daily win rule

Accounts cycle one round-trip at a time and loop back to the first. When
`ONCE_PER_DAY=true` (default), an account that closes a **winning** trade is
benched for the rest of the day (shown as "😴 WON TODAY" and skipped in the
rotation); an account that **loses or breaks even stays in the cycle** and gets
traded again when its turn comes back around. Win/loss is measured from the
account's balance (EQUITY) read just before the entry vs. just after the close,
so this only takes effect in **LIVE** mode — in Practice no real money moves, so
nothing counts as a win and every account keeps cycling. If a balance can't be
read, the trade is treated as "not a win" (the account stays in the cycle).

The "day" follows the **futures session**, not the calendar: it rolls over at
**6pm US/Eastern** by default (the CME session reopen), so a winner from the
afternoon is benched until the next session starts that evening. Change it with
`TRADING_DAY_TZ` (e.g. `America/Chicago`) and `TRADING_DAY_RESET_HOUR`.

## Balances, the $53,000 eval target, and the Passed column

While the Tradovate browser is connected and logged in, the bot re-reads the
account menu on an interval. That cadence is **adaptive**: `MONITOR_SECONDS`
(default 60s) when nothing is open, and the faster `MONITOR_ACTIVE_SECONDS`
(default 5s) whenever a trade is open — so the profit-target stop reacts
quickly on the live account. One read powers three things:

- **Balances on the dashboard** — each account row shows its latest balance, a
  small balance-history chart, and (for evals) how many dollars remain to the
  target. History is kept in `data/balances.json`. **Scan Tradovate accounts**
  also reads balances, so they populate the moment you scan instead of waiting
  for the next sweep. Balance = Tradovate's **EQUITY** figure from the top bar
  (the account menu itself shows no dollars), read by switching to each account;
  while a trade is open the live account is already selected, so its balance is
  read straight from the top bar every few seconds with no switching.
- **Auto-adding new accounts** — any LFE…/LFF… id that appears in Tradovate but
  isn't in the bot gets added automatically (LFE → Evals, LFF → Funded).
- **The eval profit target** (default **$53,000**, `evalTarget` in
  `data/settings.json`) — an eval at/above the target is retired to the
  **🏆 Passed** column and never traded again (a "Put back in rotation" button
  exists if it was retired by mistake). If the target is hit **while that
  account holds the open trade, the bot flattens it immediately** without
  waiting for a TradingView alert. There's also an entry-time guard so a
  passed-level account can never take a new trade.

Honest limits of the target stop: it reacts on the monitor interval (not
tick-by-tick), it needs the bot running with the browser logged in, and it
closes at market price — so the final balance will be near, not exactly at,
the moment it crossed the target. If Tradovate's account menu doesn't show
dollar amounts, balances stay blank and the bot says so in the Activity feed
(a screenshot of the open menu lets us calibrate the reader).

The open-trade banner also shows how many contracts the **alert** asked for —
the actual size is whatever is set on the Tradovate screen, which the bot
doesn't control by design.

## Reaching it from anywhere (ngrok) — built into the dashboard

The PC must stay on and logged in — that's where the clicking happens. But the
dashboard and webhooks get one permanent public address with ngrok, and the bot
now manages the tunnel itself via a **"Remote access"** button (no separate
ngrok window/command needed).

One-time setup:
1. Sign up free at ngrok.com, claim your **free static domain**
   (Dashboard → Domains), e.g. `your-name.ngrok-free.dev`.
2. Copy your **authtoken** (ngrok dashboard → Your Authtoken).
3. In `v2/.env` set:
   ```
   NGROK_AUTHTOKEN=<your token>
   NGROK_DOMAIN=your-name.ngrok-free.dev
   ```
4. Restart the bot. Remote access turns on automatically (`NGROK_AUTOSTART=true`),
   or toggle it any time with the dashboard's **Remote access** button.

Then, forever:
- TradingView webhook URLs: `https://your-name.ngrok-free.dev/webhook/evals`
  and `…/webhook/funded`
- Dashboard from your phone or any computer: `https://your-name.ngrok-free.dev`
  (it asks for your dashboard password)

The tunnel uses the official `@ngrok/ngrok` SDK (an **optional** dependency
running in-process). If it isn't installed the bot still runs — the Remote
access button just reports it's unavailable, and you can fall back to the ngrok
CLI (`ngrok http --url=your-name.ngrok-free.dev 3300`).

Set `DASHBOARD_PASSWORD` in `.env` **before** exposing the dashboard.

Only one computer can hold the tunnel at a time. If a second one tries, ngrok
reports the address is already online — turn the bot off on the other computer
(or stop its agent from dashboard.ngrok.com), then hit Remote access again.

## Commands

- `npm start` — run the bot + dashboard (or double-click `Start Trading Bot.cmd`)
- `npm test` — rotation unit tests (no setup, no broker)
- `npm run testhook` — fire a sample buy+close at the evals webhook
  (`npm run testhook -- funded` for the funded one)

## Safety

- **Practice mode is the default** and survives restarts. In practice mode no
  order ever reaches Tradovate — trades only appear in the Activity feed.
- Switching to LIVE requires clicking through an explicit warning.
- The Pause button makes the bot ignore all alerts until you press Start.
- All state lives in `v2/data/` (created automatically, never edited by hand).
