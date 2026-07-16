# ATLAS Position Reader and Webhook Fallback Design

## Goal

Keep ATLAS moving after an ATM, liquidation, or strategy exit by reliably
reconciling every recorded trade against the correct Tradovate account. The
broker screen remains the primary position authority. A lane-specific close
webhook becomes a bounded fallback when the screen cannot provide a definite
answer.

## Constraints

- ATM orders remain the primary broker-side protection and are never modified by
  monitoring.
- Entry execution remains on the existing fast path. Position monitoring cannot
  run inside the Buy/Sell click path.
- One Tradovate login has one globally selected account in sequential mode.
  Therefore two open positions under that login must be inspected one at a time.
- Funded inspection runs before evaluation inspection for each login.
- Account identity must be proven from the visible Tradovate top bar before any
  position or equity value is accepted.
- An explicit broker `open` result always overrides webhook fallback.
- An unknown reader result never pauses all of ATLAS and never advances a lane
  without eligible close-webhook evidence.
- The diagnostic button never clicks Buy, Sell, or Exit.

## Login-Level Reconciliation Cycle

The monitor groups recorded open trades by saved login instead of launching
independent lane reads. Each login receives one serialized cycle every active
monitor interval:

1. Collect that login's recorded funded and evaluation trades.
2. Sort funded first, then evaluation.
3. For each trade, verify the visible account label.
4. If it is not the expected account, invalidate the cached selection, select
   the expected account, and verify it again.
5. Read position and equity while that account remains selected.
6. Reconcile that lane before selecting the next account.

The account switch does not touch the ATM preset or any order button. Reading
position and equity in one worker task prevents the current extra switch between
separate position and balance calls.

## Position Evidence

ATLAS accepts two visible, account-scoped sources:

- The order ticket's `Position` label and signed whole-contract value.
- The top `Positions` area, including both `Positions: + N/- N` and a visible
  `Positions` label whose nearby value is a single signed whole number.

Hidden, duplicate, malformed, or conflicting values remain `unknown`. If one
source is definite and the other is unavailable, the definite source is used.
If both sources are definite, they must agree on flat/open state and direction.
Two consecutive broker-flat observations are still required for normal broker
reconciliation.

## Close-Webhook Fallback

A valid close alert is already identified by `action: "close"` or
`marketPosition: "flat"`. When it reaches a lane with a recorded open trade,
ATLAS stores evidence scoped to that lane and the current trade fingerprint.

- Broker `flat`: use the existing two-reading confirmation and finish normally.
- Broker `open`: request Exit if it has not already been requested, then keep
  monitoring. The webhook cannot override explicit open evidence.
- Broker `unknown`: retry through normal monitor cycles. After at least five
  seconds and two unknown observations, the same-fingerprint close webhook may
  complete the recorded trade as a webhook fallback.

Completing a trade clears the pending close evidence. Fingerprint matching and
the existing completion lock make monitor/webhook races idempotent, so a lane
cannot rotate twice.

## Alerts and Failure Behavior

Unknown position evidence emits one action-needed notification per trade and
failure episode. Further unknown reads update status but remain silent. A
definite open or flat observation resets the episode, allowing one new alert if
the reader later fails again.

An unknown result does not set `running` to false. Without a close webhook,
ATLAS conservatively retains that lane's recorded trade and continues checking;
other logins and lanes remain operational.

## No-Order Test Button

The dashboard adds `Test position reader (no order)` beside the other diagnostics.
For a selected login, the endpoint chooses each recorded open account, or the
next funded and evaluation accounts when flat, and runs the same funded-first
verified account-selection and snapshot path as the real monitor.

The result reports the account, lane, selection verification, position state,
equity availability, reason for unknown evidence, and elapsed time. It does not
mutate rotations, close evidence, readiness, running state, or broker orders.

## Verification

- Browser fixture proves the separate `Positions` label plus numeric value.
- Worker tests prove stale cached selection is force-reselected and verified.
- Login-cycle tests prove funded-first order and a single snapshot per account.
- Fallback tests prove the five-second/two-unknown threshold, explicit-open
  veto, fingerprint isolation, and exactly-once completion.
- Alert tests prove one notification per failure episode.
- Route/UI tests prove the test button is no-order and uses the real snapshot
  path.
- Full TypeScript, JavaScript syntax, and browser-backed test suites must pass
  before deployment or push.
