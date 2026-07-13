# ATLAS Background Execution, Position Monitoring, and Remote Access Design

## Goal

Make ATLAS reliable with a minimized Tradovate window, advance rotations from the broker's actual position state, and expose a persistent Remote Access switch in the dashboard.

## Evidence and root cause

A safe dashboard test was measured on the active Tradovate session. Preparing an account/ATM while the browser was visible took about 1.68 seconds. With the same browser minimized and account/ATM already READY, changing and verifying quantity took about 0.29 seconds. Background Chromium flags are therefore effective for the account, ATM, and quantity path. The remaining delay is isolated to the existing Playwright locator click path for Buy, Sell, and Exit, which waits for browser actionability/rendering conditions that may stall while a window is minimized.

## Background-safe order click

ATLAS will retain all existing safety checks before an order: exact armed account, verified ATM bracket, required webhook quantity, logged-in session, and one selected visible order control. It will replace the final Playwright actionability click with a page-side click on that single verified control. This avoids compositor/actionability waits while retaining the same browser page and button identity.

The button lookup must reject zero or multiple visible matching controls, disabled controls, or a mismatched selected account. A failed click must not create open-trade state and must report timing plus an actionable Telegram message.

ATLAS will record per-entry timing for quantity verification, final click dispatch, and broker-position confirmation. These timings are visible in activity and returned from the webhook.

## Actual broker exit lifecycle

An entry opens an ATLAS trade record but it is finalized only from Tradovate's displayed selected-account position.

The worker will expose a read-only position reader that returns a signed quantity, zero when flat, or null when the broker display cannot be read. While a non-simulated ATLAS trade is active, a monitor reads only that already-selected account. It requires a nonzero position to confirm the entry, and later requires zero to confirm exit.

When the broker position becomes zero after a confirmed nonzero position, ATLAS reads the settled balance, records the close, evaluates the winner/pass rule, advances the rotation, and pre-arms the next account. This catches ATM take-profit/stop-loss exits without a TradingView close webhook.

A TradingView close webhook remains an exit request: it may click Tradovate Exit at Market, but it does not clear the rotation or label the trade closed. The actual position monitor performs that final transition. If position data is unavailable repeatedly, ATLAS keeps the trade open, blocks a replacement entry, and sends Telegram action-needed notification.

## Remote Access switch

The dashboard header will show Remote Access as ON (public) or OFF (local only) and a switch button. ON connects the configured ngrok tunnel. OFF disconnects it immediately, leaves local ATLAS and Tradovate untouched, and persists an explicit remote-access-disabled state that the health loop respects.

When Remote Access is OFF, the dashboard must not present the configured public address as reachable. It will display local-only webhook guidance and explain that TradingView cannot reach ATLAS until Remote Access is enabled again.

## Verification

Automated tests will cover unique verified page-side order control selection, failure safety, dynamic quantity timing fields, position lifecycle transitions, webhook close waiting for broker flat state, automatic ATM exit detection, remote-access persistence, health-loop suppression, and dashboard switch/copy behavior.

Manual simulator verification will compare a visible window and a minimized window using a one-contract test entry followed by an immediate simulated flatten. It will record accepted-webhook-to-click and position-confirmation timing. No live account or live mode is used for this verification.
