# Trading Bot V4

V4 is an isolated, multi-login account-rotation orchestrator. V2 and V3 remain untouched.

## What changed

- Account identity is explicit. `firm`, `stage`, connection, and pool membership no longer come from `LFE`/`LFF` letters.
- Each login has its own persistent browser profile and serialized worker.
- Different login workers can trade concurrently.
- The same login never receives two browser actions at once.
- Pools lock their active account so two strategies cannot control it simultaneously.
- Test webhooks are plan-only: they never click a broker and never alter rotation state.
- A standalone `Send Test Webhook.cmd` tool works independently of the dashboard.
- A broadcast webhook can fan one signal out to several pools.
- Every pool has its own `/webhook/:poolId` URL and configurable execution lane.
- The Control Center shows full pool order, next account, last-known balances, login health, and activity.
- Add any practical number of Tradovate logins from Account Onboarding without restarting V4.
- Evaluation pools may define `balanceTarget: 53000`; funded pools omit it and never use that automatic close.

## Safety model

V4 defaults to `practice` mode and the included sample connection uses the `simulated` adapter. Change both intentionally before expecting live browser actions.

The ATLAS dashboard now has an explicit **Practice / Live** control. Enabling Live requires confirmation and at least one logged-in execution session. Live means an armed TradingView webhook can click a real Buy/Sell button. Test webhook buttons remain non-ordering in both modes.

## Near-instant execution sessions

ATLAS does all account and ATM work before the signal arrives. **READY** means the exact next account and dollar ATM bracket are already selected and verified. Every entry webhook must supply the strategy's dynamic `quantity`. ATLAS sets and verifies that quantity immediately before the Buy/Sell click. If the account/ATM setup is not READY, ATLAS blocks the signal and sends the existing action-needed alert instead of attempting a slow trade.

One saved login is one browser execution session and can keep one lane ready at a time. If evaluation and funded pools must enter simultaneously using the same credentials, add that login twice as two saved execution sessions, log into both persistent windows once, and assign each lane's accounts to its own session. Different sessions run concurrently; one shared session cannot safely hold two different accounts and ATM settings at the same instant.

The dashboard also has a safe simultaneous eval + funded benchmark. Choose one pool and contract quantity for each side, then run both together. It follows the real pre-click quantity path, reports each side plus total wall-clock time, and never clicks an order.

For the fastest one-click path, disable order confirmations in Tradovate Application Settings. Chromium background throttling is disabled by ATLAS, so the session does not need to be the foreground window. Recent activity reports queue, browser-click, and total internal timing for live entries; this does not include TradingView internet transit or exchange fill time.

Within one login, actions are serialized. Across independent logins, workers run concurrently. Pools with different execution-lane names may hold trades at the same time; pools sharing a lane are mutually exclusive, so a conflicting entry is rejected while that lane is occupied. Browser-based execution cannot be atomic across firms; a broadcast response reports each leg separately.

## Registry

Edit `data/registry.json` to define the real-world model:

```json
{
  "version": 4,
  "running": true,
  "mode": "practice",
  "connections": [
    {
      "id": "firm-a-login",
      "name": "Firm A Tradovate",
      "firm": "Firm A",
      "adapter": "tradovate",
      "url": "https://trader.tradovate.com",
      "sessionDir": ".sessions/firm-a-login",
      "accountPattern": "[A-Z0-9][A-Z0-9_-]{5,}",
      "enabled": true,
      "autoConnect": true
    }
  ],
  "accounts": [
    {
      "id": "firm-a-eval-01",
      "name": "Firm A Evaluation 1",
      "firm": "Firm A",
      "stage": "eval",
      "connectionId": "firm-a-login",
      "platformLabel": "THE-EXACT-LABEL-SHOWN-ON-SCREEN",
      "enabled": true,
      "status": "active",
      "tags": ["lfe"]
    }
  ],
  "pools": [
    {
      "id": "eval-primary",
      "name": "Primary Evaluation Rotation",
      "accountIds": ["firm-a-eval-01"],
      "enabled": true,
      "benchWinnersForDay": true,
      "executionLane": "evals",
      "balanceTarget": 53000
    }
  ]
}
```

Account labels can use any convention. They do not determine whether an account is evaluation or funded.
New installations may leave `accounts` and pool `accountIds` empty, then populate them from the browser through `/onboarding.html`.

## Webhooks

One pool:

```text
POST http://localhost:3500/webhook/eval-primary
```

```json
{
  "secret": "your-secret",
  "signalId": "unique-alert-id",
  "action": "buy",
  "symbol": "MNQ",
  "quantity": 1,
  "marketPosition": "long"
}
```

Several pools concurrently:

```text
POST http://localhost:3500/webhook
```

```json
{
  "secret": "your-secret",
  "pools": ["eval-primary", "funded-primary"],
  "signalId": "unique-alert-id",
  "action": "buy",
  "symbol": "MNQ",
  "quantity": 1,
  "marketPosition": "long"
}
```

Use `marketPosition: "flat"` or `action: "close"` to close the pool's recorded position.

The Status page shows each pool's individual webhook path and lets you change its execution lane. Give funded and evaluation pools different lane names to allow simultaneous positions. Give pools the same lane name when they must take turns.

## Standalone test sender

Open `http://localhost:3500/sender.html`, double-click `Send Test Webhook.cmd`, or run:

```text
npm run webhook:send -- --pool eval-primary --secret YOUR_SECRET --action buy --symbol MNQ --quantity 1
```

This sends `test: true`. The server returns the account and connection it would use, but does not touch the browser or rotation state.

Live manual sending requires `--live` and an additional typed confirmation:

```text
npm run webhook:send -- --live --pool eval-primary --secret YOUR_SECRET --action buy --symbol MNQ --quantity 1
```

## Adapter coverage

V4 includes `tradovate` and `simulated` adapters. Multiple prop firms using Tradovate can be configured as separate connections today. A prop firm using another platform needs a platform-specific adapter implementing account discovery, selection, entry, close, verification, and recovery. The worker/coordinator architecture is already separated for that purpose; V4 will not guess at unknown trading screens.

## Commands

```text
npm install
npm run typecheck
npm test
npm start
```

Open `http://localhost:3500` for the interactive V4 Control Center.

The Control Center is interactive: reorder accounts, set the next account, hold/reactivate, mark passed, remove pool membership, refresh safe last-known balances, and configure execution lanes. Balance refreshes defer any login that has an open trade.

Open `http://localhost:3500/onboarding.html` to connect a login, scan the account labels visible in its browser, classify unknown accounts, assign pools, and save them directly to `data/registry.json`. Direct local setup actions are trusted automatically, so this page does not ask for the webhook secret. External trade webhooks still require the secret stored in `.env`.

Use **Add another login** on that page to create a separate persistent Chromium session. Each login is isolated and serialized; separate logins can work concurrently through different pool execution lanes.
