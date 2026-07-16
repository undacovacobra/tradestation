# Tradovate Account-Cycler Bot (non-API)

> **Current supported build: ATLAS v3.** The older root implementation remains
> in this repository for history, but normal operation should start `v3`.

## Start ATLAS on Windows

After extracting the complete GitHub ZIP, double-click **`Start ATLAS.cmd`** in
the outer folder. It starts the current v3 build, installs missing dependencies,
preserves existing v3 configuration/state when upgrading, and opens
`http://localhost:3400/`.

From PowerShell, use this policy-safe command:

```powershell
npm.cmd --prefix v3 start
```

Use `npm.cmd`, not plain `npm`, on machines where PowerShell blocks `npm.ps1`.
The launcher does this automatically and does not weaken Windows execution-policy
security.

Receives **TradingView webhook alerts** from your existing strategy and routes each
trade to a different **Tradovate prop account**, cycling through them one round-trip
at a time. Because your firm blocks API access, live orders are placed via
**browser automation** of the Tradovate web trader — no broker API, no TradersPost.

```
TradingView strategy ──webhook──▶ local server ──▶ rotation manager ──▶ executor ──▶ Tradovate web trader
```

## What's solid vs. what needs you

- ✅ **Rotation manager** — cycle accounts, one open round-trip at a time, advance on
  close, wrap around, optional "once per day per account". Unit-tested.
- ✅ **Webhook server** — secret-protected, validates payloads, serializes orders.
- ✅ **Dry-run executor** — proves the whole pipeline without touching a broker.
- ⚠️ **Tradovate executor** — real Playwright automation, but the UI **selectors must be
  calibrated** against the live web trader (see step 4). DOM details I can't see from
  here are best-guesses marked `CALIBRATION REQUIRED` in `src/executor/tradovate.ts`.

## ⚠️ Read this first
Your prop firm blocks the API specifically to stop automation. Browser automation does
the same thing through a different door, so it very likely **violates the firm's terms**
and could fail/ban an account. Running one strategy across many accounts is also
something firms watch for. These are your accounts and your decision — this tool just
makes the mechanics possible. **Test everything in `dryrun`, then on a demo/eval, long
before any funded account.**

## Setup
```bash
cd trading-bot
npm install
cp .env.example .env                 # set a long WEBHOOK_SECRET
cp data/accounts.example.json data/accounts.json
```
Edit `data/accounts.json` so each `tradovateLabel` matches **exactly** what appears in
Tradovate's account-selector dropdown. Disable an account anytime with `"enabled": false`.

## Run (safe dry-run)
```bash
npm start                            # EXECUTOR=dryrun by default
curl -X POST localhost:3000/webhook -H 'Content-Type: application/json' \
  -d '{"secret":"YOUR_SECRET","action":"buy","symbol":"MNQ1!","quantity":1}'
curl localhost:3000/status
```

## Go live on Tradovate
1. Set `EXECUTOR=tradovate` and `HEADED=true` in `.env`.
2. **Calibrate / log in:** `npm run calibrate` opens the trader. Log in (incl. 2FA)
   once — the session is saved to `SESSION_DIR`. While it's open, inspect the account
   dropdown, symbol box, qty box, and Buy/Sell/Close buttons, and adjust `SELECTORS` in
   `src/executor/tradovate.ts` to match.
3. `npm start`. The bot reuses the saved login. Failures auto-save a screenshot to
   `screenshots/` so you can see what the page looked like.

## TradingView alert format
Premium plan, alert → "Webhook URL" = `http://YOUR_PC:3000/webhook` (expose it safely;
see Exposure below). Alert message body:

**Entry**
```json
{ "secret": "YOUR_SECRET", "action": "{{strategy.order.action}}", "symbol": "MNQ1!",
  "quantity": 1, "orderType": "market", "stopLoss": 50, "takeProfit": 100,
  "tradeId": "{{strategy.order.id}}" }
```
**Exit** (advances the rotation)
```json
{ "secret": "YOUR_SECRET", "action": "close", "symbol": "MNQ1!" }
```
`action` accepts `buy`, `sell`, `close`. The rotation advances when a `close` arrives.

## Exposure
TradingView calls your PC from the internet. Don't port-forward raw. Use a tunnel
(Cloudflare Tunnel / ngrok) pointed at `localhost:3000`, and keep `WEBHOOK_SECRET` long
and private. The server rejects any alert without the correct secret.

## Endpoints
- `POST /webhook` — TradingView alerts
- `GET  /status` — next account, open trade, accounts traded today
- `GET  /health` — liveness

## Config (`.env`)
| Var | Meaning |
|-----|---------|
| `WEBHOOK_SECRET` | Shared secret TradingView must send |
| `PORT` | Server port (default 3000) |
| `EXECUTOR` | `dryrun` or `tradovate` |
| `HEADED` | Show the browser (`true`) or run headless |
| `SESSION_DIR` | Persistent login session folder |
| `TRADOVATE_URL` | Trader URL (demo vs live) |
| `ONCE_PER_DAY` | Don't reuse an account the same calendar day |

## Tests
```bash
npm test
```

## Roadmap (planned, not yet built)
- **Per-strategy account groups.** Account ids encode their type: `LFE…` =
  evaluation, `LFF…` = funded. The goal is **two independent rotations running at
  once** — one strategy cycles only eval accounts, another cycles only funded
  accounts, each with its own open-trade tracking. Implementation sketch: add a
  `group` field per account in `accounts.json`, include a `group` (or `strategy`)
  field in the TradingView alert, and keep a separate `AccountRotation` instance
  per group keyed off that field.
- Additional cycling filters (to be specified) layered on top of the rotation.

## Known limitations
- Selectors need calibration and can break when Tradovate ships UI changes.
- "Day" boundary is UTC; futures reset ~17:00 CT — adjust `defaultToday()` in
  `src/rotation.ts` if your strategy trades across that boundary.
- Round-trip completion is driven by your strategy's exit alert. If a stop/target fills
  on the platform without an exit alert, send a `close` alert (or add UI position
  polling) so the rotation advances.
