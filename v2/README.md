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
