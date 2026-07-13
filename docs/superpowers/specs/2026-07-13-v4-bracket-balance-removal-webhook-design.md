# V4 Bracket, Balance, Removal, and Webhook Reliability Design

## Goal

Make the V4 dashboard accurately control the live Tradovate ATM bracket, refresh every remaining account balance, permanently delete accounts the user removes, and expose a full copyable webhook URL for each pool.

## Root Causes

1. Tradovate's live ATM dialog lays out its labels and inputs in separate columns. The current DOM-parent search can resolve both `TAKE PROFIT` and `STOP LOSS` to the first input. The requested take-profit is therefore written first and then overwritten with the stop-loss value.
2. The Remove action only removes an account ID from one pool. It leaves the account enabled in the registry and leaves its cached balance behind.
3. Balance refresh loops over all enabled registry accounts and aborts the entire login on the first account-selection error. The two Tradovate accounts that no longer exist stop the refresh before later accounts are reached.
4. The pool header shows only a relative webhook route instead of a complete URL that can be copied.

## Design

### Exact ATM input selection and persistence verification

The browser adapter will select each ATM number input by matching the label and input on the same visible horizontal row. It will prefer the closest visible input whose vertical center aligns with the requested label, instead of climbing to a shared parent and taking the first input.

After entering both values and clicking Save, the adapter will reopen the ATM dialog, re-read the saved Take Profit and Stop Loss values with the same row-matching logic, and require exact numeric equality. It will close the dialog after verification. If either value differs, pre-arm fails, the account is not marked Armed, and no trade can be placed through the fast path.

### Permanent account deletion

The dashboard's Remove button becomes `Delete account`. After the existing open-trade guard, deletion removes the account from every pool, removes it from the registry, and removes its cached balance/history. The account will disappear from the connection count, status payload, onboarding configured list, all rotations, and future balance refreshes.

### Resilient balance refresh

Balance refresh will inspect only enabled accounts still referenced by at least one pool. Each account refresh is isolated: one missing or temporarily unreadable account produces an account-specific error but does not stop later accounts. The response and dashboard summary will report the number updated and the account labels that failed. After the scan, V4 attempts to re-arm the appropriate next account for the connection.

### Full copyable webhook URLs

Each pool will render a full webhook URL below its execution lane using the dashboard's actual origin plus `/webhook/<pool-id>`. A Copy webhook button copies that exact URL. This guarantees the displayed URL maps to the running V4 route. When the dashboard is opened through a public HTTPS domain, the copied URL automatically uses that public domain; when opened locally, it accurately shows the local-only URL.

The webhook secret remains in the TradingView JSON body or `x-webhook-secret` header and is never embedded in the URL.

## Error Handling and Safety

- A persisted bracket mismatch is fail-closed and clears the worker's armed signature.
- Permanent deletion is rejected while the account has an open trade.
- Balance failures are retained in the result instead of being silently ignored.
- Copying a webhook does not send a request or expose the webhook secret.

## Testing

- Browser fixture with labels and inputs in separate columns proves Take Profit and Stop Loss resolve to different fields.
- Browser test proves post-Save persisted values are reopened and verified; a clamped or changed value rejects preparation.
- Registry and balance-log tests prove global deletion and cached-balance cleanup.
- Coordinator test proves a missing account does not prevent later balances from refreshing.
- UI tests prove the full origin-based webhook and copy button are rendered and removal is labeled as permanent deletion.

