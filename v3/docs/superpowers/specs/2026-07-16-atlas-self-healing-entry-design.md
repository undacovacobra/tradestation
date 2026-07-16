# ATLAS Self-Healing Webhook Entry Design

## Goal

Make every live entry webhook fully authoritative for quantity while preserving funded priority and preventing a manual Tradovate browser change from placing an order on the wrong account, ATM preset, or size.

## Confirmed Gap

ATLAS currently writes a webhook quantity only when its in-memory quantity cache differs. If a person changes the visible Tradovate quantity after ATLAS cached the desired value, the write is skipped. The final live-ticket check detects the mismatch and blocks the trade, which is safe but not fully automated. A similar manual account or ATM change can also cause a safe rejection instead of an automatic repair.

## Approved Behavior

For every entry webhook that includes `quantity`:

1. Preserve the existing funded-first credential scheduler.
2. Check the live Tradovate account and saved ATM before changing quantity.
3. If account or ATM drifted, actively select the target account and saved ATM again.
4. Force-write the webhook quantity even when ATLAS's cache says that value was already set.
5. Read the live ticket again and require exact account, ATM, and quantity agreement.
6. If the final check sees a race or drift, run one bounded full repair and verify once more.
7. Click Buy/Sell only after exact agreement. If repair or verification fails, place no order and report the failure.

When `quantity` is omitted, retain the existing compatibility behavior: leave the displayed positive quantity unchanged. The user's TradingView webhooks include quantity, so normal operation always takes the authoritative path.

## Architecture

`CredentialWorker.enterPrepared` owns the safety sequence because it already serializes work for one Tradovate login and performs the final pre-click gate. The trading-session adapter will expose two explicit capabilities: force-setting a quantity and repairing prepared account/ATM/quantity state. `TradovateBrowser` will implement repair by invalidating only its UI caches, adopting or selecting the requested account from the real screen, applying the saved ATM, and force-writing the quantity.

No webhook routes, rotation rules, funded priority rules, position reconciliation, or close behavior change.

## Failure Handling

- A quantity write must read back the exact whole-number value or throw.
- A repair is attempted at most once after the final verification detects drift.
- A second mismatch fails closed with no Buy/Sell click.
- Login loss, missing account, missing ATM, or uneditable quantity continue to produce an actionable error.

## Verification

- Unit test that cached quantity cannot suppress a webhook-authoritative write.
- Worker test that manual identity/ATM drift triggers repair before order placement.
- Worker test that an unsuccessful repair produces no order click.
- Browser test that a forced write replaces a manually changed visible quantity.
- Full TypeScript and test-suite verification.
- Live no-order quantity test plus the existing read-only position test after deployment.

