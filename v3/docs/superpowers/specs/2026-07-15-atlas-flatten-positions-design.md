# ATLAS Flatten Positions Design

## Goal

Add deliberate emergency controls that close every verified Tradovate position or one verified account position without changing ATLAS's running/paused state.

## Approved behavior

- The global `Flatten all positions` control scans every saved account, including disabled and passed accounts.
- The individual `Flatten position` control appears only when that account has a fresh broker-confirmed nonzero position. A recorded ATLAS trade receives this status from normal reconciliation; an unrecorded/manual position can be surfaced with the existing `Position` check.
- Both controls require a clear red confirmation modal. The server also requires an explicit confirmation value so a malformed request cannot trigger an exit.
- Flattening works in both Practice and Live dashboard modes because it is an emergency broker action. The confirmation copy states that it sends real Tradovate exit clicks.
- Flattening never changes `store.running`. It cancels pending entry work for each targeted lane before inspecting or exiting that lane, preventing a queued entry from racing the manual exit.

## Broker safety contract

For each target, ATLAS selects and verifies the exact Tradovate account, then reads the existing authoritative broker position signal. A flat account is skipped. Unknown or conflicting evidence is reported and never treated as flat. Only a nonzero broker position permits `Exit at Mkt & Cxl`.

After an exit click, ATLAS requires two consecutive `POSITION 0` reads before reporting success. If the account owns a recorded ATLAS trade, confirmed flatness completes that existing trade exactly once and preserves normal rotation/history behavior. An unrecorded position is closed without inventing a trade-history record.

## Ordering and concurrency

Targets for one Tradovate login run sequentially, Funded before Evaluations. Different login sessions may flatten concurrently. The global result reports every account as `closed`, `already-flat`, or `failed`; one failure does not stop independent logins from being processed.

## Status and UI

The server keeps a per-account broker-status cache populated by monitor reads, explicit Position checks, and flatten operations. Status responses decorate account rows with this state. A lane's recorded open trade still remains the source of truth for normal trade lifecycle; the cache only controls visibility and feedback for emergency actions.

The global red button lives in the primary control bar. Individual red buttons live with an account's existing controls and render only for broker state `open`. The confirmation modal lists the exact scope and explains that ATLAS will keep its current running/paused state.

## Error handling

- Disconnected or logged-out credentials fail their accounts without affecting other logins.
- Unknown broker evidence never causes an exit or a false flat result.
- A failed exit click or missing second flat confirmation is returned as a per-account failure and logged.
- The API is idempotent for flat accounts and safe against duplicate clicks: a second request re-reads the broker and skips accounts already flat.

## Verification

- Pure orchestration tests cover Funded-first ordering, same-login serialization, cross-login concurrency, flat skips, unknown failures, two-read confirmation, and unchanged running state.
- Session/server tests cover exact-account verification, pending-entry cancellation, recorded-trade reconciliation, and explicit confirmation requirements.
- UI tests cover the global button, conditional individual buttons, confirmation copy, and correct request payloads.
- Browser fixtures verify that the exit path uses the existing `Exit at Mkt & Cxl` control. Live verification is read-only: no flatten control will be clicked against the user's accounts.
