# V4 Setup Guide

1. Run `npm install` and then `npx playwright install chromium` on the bot computer.
2. Copy `.env.example` to `.env` and set a long `WEBHOOK_SECRET`.
3. Leave `data/registry.json` in `practice` mode during setup.
4. Replace the sample connection, account, and pool entries with your real organization.
5. Use a different `sessionDir` for every login. Two logins must never share a session folder.
6. Start V4 with `npm start`.
7. For a Tradovate connection, complete any required login or MFA in its browser window.
8. Call `/api/connections/<connection-id>/accounts?secret=<secret>` to compare discovered labels with the configured registry.
9. Open `/sender.html` or double-click `Send Test Webhook.cmd` and confirm the returned plan is correct.
10. Send practice-mode entry and close webhooks and inspect the pool state on the status page.
11. Only after repeated testing, change the registry mode to `live` and restart V4.

## Adding another login

Add another connection with a unique `id` and `sessionDir`, then assign accounts to its `connectionId`. Its browser actions will be serialized independently and can run concurrently with other connections.

## Adding another prop firm

The firm name is metadata and can be anything. If the firm uses Tradovate, use another `tradovate` connection. If it uses a different trading platform, keep the account disabled until a matching adapter has been implemented and tested against that platform.

## Safe test flow

- `Send Test Webhook.cmd` is simulation-only by default.
- A test response beginning `TEST ONLY` confirms routing without clicking a broker.
- Test alerts do not open or close stored pool state.
- `--live` is intentionally difficult to invoke and requires typing `SEND LIVE`.
