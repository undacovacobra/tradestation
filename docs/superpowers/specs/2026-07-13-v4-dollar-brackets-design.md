# V4 Per-Account Dollar Brackets Design

## Source Change

Port the V3 behavior introduced by commit `b13f4f5`: every account may define a take-profit and stop-loss in dollars per contract, and the bot writes those values into Tradovate's ATM Settings using `$ Value`. Tradovate/exchange-side bracket orders then manage the exit instead of relying on a later browser webhook to react at the profit or loss threshold.

## V4 Adaptation

V3 has one browser and can pre-arm one next account. V4 can operate several logins and several pools, including pools that share a login. A single browser cannot remain pre-armed for multiple possible next accounts simultaneously. V4 will therefore make bracket verification part of the serialized login-worker entry preparation:

1. Select the account for the pool.
2. Switch that login's browser to the selected account.
3. Require both saved bracket amounts to be positive, then open ATM Settings, force `$ Value`, write and read-back-verify take profit and stop loss, and save. An unconfigured account is rejected before any order-producing click.
4. Set and verify quantity when supplied.
5. Click Buy or Sell only after every required preparation step succeeds.

Clicking `Make next` changes only the pool's saved rotation pointer. It does not touch Tradovate. Bracket preparation occurs when a real entry webhook arrives, after V4 resolves the next account and immediately before that account's quantity and Buy/Sell actions.

This may add browser preparation time when the bracket differs from the last verified bracket, but it guarantees that V4 never knowingly places an order with an unverified requested bracket. The bracket setter caches the last verified target/stop pair per login, so repeated identical brackets remain a no-op.

## Account Data

Add `targetPerContract` and `stopPerContract` as nonnegative numbers on every V4 account, defaulting to `0`. Both positive means the bracket is configured and required. Both zero means the account is unconfigured and cannot take a real entry. This fail-closed rule prevents a previously saved Tradovate ATM bracket from silently carrying into an account whose V4 values are zero. A mixed state where only one value is positive is rejected by registry updates and by the browser adapter.

The values are editable on configured-account onboarding cards and displayed on every rotation row. Internal account identity remains immutable.

## Browser Safety

Port V3's tested ATM interaction into V4's shared `TradovateBrowser`:

- Only click controls clearly labeled as ATM/settings/gear candidates.
- Confirm the ATM Settings dialog opened.
- Force `Show in` to `$ Value` before entering numbers.
- Locate Take Profit and Stop Loss rows, replace their numbers, and read them back exactly.
- Click Save only after both values verify.
- On any failure, capture a diagnostic screenshot, cancel/close the dialog, clear the cache, and throw before the order click.
- Reset the bracket cache on browser disconnect/recovery.

Tradovate's current ATM gear is an unlabeled icon. The fallback locator must anchor to the exact visible `ATM` row, select the nearest icon-only button to its right on the same horizontal row, reject any button whose text resembles an order action, and confirm that `ATM Settings` opened. A browser fixture must include both the unlabeled ATM gear and a separate `DAY/GTC` gear so the test proves the decoy is never clicked.

Because the current selector strategy is heuristic, the no-trade calibration endpoint will return visible field diagnostics on failure, matching V3's live-calibration workflow.

## API and UI

- Extend account onboarding/create/update requests with `targetPerContract` and `stopPerContract`.
- Show two numeric inputs: “Make $ per contract” and “Lose $ per contract.”
- Show the saved bracket under each account in the control center.
- Add `POST /api/connections/:id/test-bracket`, which requires positive target and stop values, runs through that login's serialized worker, writes the ATM bracket with `force=true`, and never places an order.
- Add a calibration form on onboarding next to the selected login so the user can test a bracket without trading.
- Add compact `TP $`, `SL $`, and `Save bracket` controls directly to every control-center account row. Saving changes only that account's registry values, refuses one-sided values, treats `0/0` as visibly unconfigured, and is rejected while that account holds an open trade.
- Keep onboarding editing as a secondary bulk-configuration path, but do not require a browser scan merely to change an existing account's bracket.

## Balance Refresh Correction

The balance endpoint currently reaches Tradovate, but account switching may resolve a hidden duplicate account label and wait until timeout. Account-menu selection must choose a visible exact label rather than `.last()`. The refresh result must remain per-login and continue refreshing other logins when one fails.

The dashboard must replace the generic `Saved.` message with a specific summary such as `2 balances updated; 8 not updated`, followed by the connection error when applicable. The button stays disabled while the request is running so repeated clicks cannot queue duplicate browser scans.

The existing explicit close webhook remains supported for manual/strategy flattening. Exchange-side ATM exits do not by themselves notify V4 that the position is flat; V4's existing close/balance workflow remains responsible for clearing pool state until position reconciliation is added separately.

## Tests

1. Model/registry tests cover defaults, persistence, updates, and rejection of one-sided brackets.
2. Browser tests port the V3 mock ATM fixture and verify write, read-back, caching, and nonpositive rejection.
3. Worker/coordinator tests verify a required bracket is prepared before quantity and entry, and that bracket failure prevents the order click.
4. UI contract tests verify editable bracket fields, displayed bracket text, and the no-trade calibration endpoint/form.
5. Browser tests verify an unlabeled ATM gear is selected while the nearby `DAY/GTC` gear is untouched.
6. Balance-refresh tests verify visible account selection and a useful updated/failed dashboard summary.
7. Run the complete V4 typecheck and test suite, then update the local server with registry/session preservation and verify the browser.
