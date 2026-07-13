# ATLAS Fast Entry with Post-Fill OCO Protection

## Goal

Add an explicit Fast Entry execution style that clicks the market entry as soon as the webhook quantity is verified, then protects the filled position with a Tradovate OCO-one-time take-profit and stop-loss pair.

## Why OCO-one-time

Changing the ATM Settings dialog after an entry only changes the template used by future entries. Tradovate documents OCO-one-time in the DOM as the supported way to add linked take-profit and stop-loss orders to an existing position. ATLAS must therefore verify working OCO orders rather than merely saving new ATM values.

Reference: https://tradovate.zendesk.com/hc/en-us/articles/26308518467859-How-Can-I-Place-OCO-Bracket-Orders-to-an-Existing-Position-in-the-DOM-module

## Execution Styles

- `standard` remains the default and preserves the current pre-armed ATM behavior.
- `fast-entry` is a deliberate dashboard selection and persists in the registry.
- Practice/test webhooks remain non-order-producing in both styles.

## Fast Entry Readiness

Before a fast-entry account can show READY, its saved login worker must:

1. Select the exact next account.
2. Turn the chart ATM switch off so stale brackets cannot attach to the new entry.
3. Confirm that a Tradovate DOM module for the active symbol is present and exposes OCO-one-time controls.
4. Keep the selected account reserved for that execution lane.

Fast Entry does not pre-set take-profit, stop-loss, or quantity. Quantity still comes from the webhook.

## Entry and Protection Flow

1. Validate the pool, next account, login readiness, symbol profile, and webhook quantity.
2. Set and read back the exact webhook quantity.
3. Dispatch the market entry click using the existing page-side click path.
4. Persist the open trade immediately with protection state `pending` and return the entry result.
5. On the same login worker queue, wait until Tradovate reports a non-zero position and an average entry price.
6. Calculate prices from per-contract dollars:
   - price distance = configured dollars / contract point value
   - round outward to the instrument tick size
   - long: TP above entry, SL below entry
   - short: TP below entry, SL above entry
7. Set the DOM quantity to the absolute broker position.
8. Execute the uninterrupted sequence OCO-one-time, take-profit click, stop-loss click.
9. Verify exactly two working exit orders for the selected account/symbol, the correct quantity, expected prices, and a shared non-zero OCO/link identifier.
10. Mark protection `protected`. The dashboard changes from `Protecting...` to `Protected`.

Different saved login workers protect in parallel. A single saved login remains serialized because it represents one browser execution session.

## Supported Instruments

The initial symbol profiles are:

- MNQ: tick size 0.25, point value $2
- NQ: tick size 0.25, point value $20
- MES: tick size 0.25, point value $5
- ES: tick size 0.25, point value $50

Fast Entry blocks before the market click for unsupported symbols. Standard mode is unaffected.

## Failure Handling

- A trade stays locked while protection is `pending` or `failed`.
- If no protective order was created, ATLAS retries the complete OCO sequence once.
- If one protective order exists, ATLAS does not blindly retry and risk duplicate orders. It marks protection `failed`, keeps the rotation locked, and sends Telegram with the account, symbol, position, and exact failure.
- Restart recovery inspects every live open trade. Pending or failed protection is reconciled against Tradovate before any new entry is allowed.
- If the position is already flat, normal broker-position settlement closes and advances the rotation without creating new orders.
- A TradingView close signal still requests Exit at Mkt & Cxl; broker flat state remains authoritative.

## Dashboard

The header adds a Standard / Fast Entry selector beside Practice / Live. Fast Entry requires a confirmation explaining the temporary unprotected gap. Each open trade displays `Protecting...`, `Protected`, or `Protection failed`. Recent Activity records the entry-click time and the later protection-verification time separately.

## Tests

- Registry persistence and default behavior for execution style.
- Pure instrument price calculations for long/short and tick rounding.
- Fast-entry worker path does not call `setBracket` before `clickOrder`.
- Coordinator persists `pending` before asynchronous protection and keeps the account locked.
- Successful protection changes state to `protected`; failure changes it to `failed` without advancing rotation.
- Same-login serialization and different-login parallel protection.
- UI selector, warning, and protection status rendering.
- Browser fixture for OCO-one-time sequential control dispatch and verification.

## Non-Goals

- No broker API access.
- No unsupported-symbol guessing.
- No claim that saving ATM Settings after entry protects the current position.
- No automatic cancellation of a partially-created protective order unless Tradovate exposes an unambiguous order-specific cancel control.
