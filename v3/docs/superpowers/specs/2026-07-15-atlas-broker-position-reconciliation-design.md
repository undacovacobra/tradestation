# ATLAS Broker-Position Reconciliation Design

**Date:** 2026-07-15
**Status:** Approved, including live Tradovate UI calibration
**Scope:** V3/ATLAS Tradovate execution manager

## Problem

ATLAS currently treats TradingView close webhooks as proof that a trade ended. That leaves ATLAS with a stale open trade when an ATM closes the position, Tradovate liquidates the account at its drawdown limit, or any other broker-side exit occurs without the close webhook reaching ATLAS. The stale state blocks rotation and can produce misleading entry/exit failure alerts.

The broker account must be the authority for whether the account is in a position. A webhook can request an action, but it cannot prove the resulting broker state.

## Calibrated Tradovate Signal

The actual authenticated Tradovate web trader was inspected on 2026-07-15 while account `LFE05079261220009` was selected and flat. Its order ticket displayed a dedicated field:

```text
POSITION
0
-.-- USD
```

The same screen also displayed `OPEN P/L 0.00 USD`, `DAY MARGIN 0%`, and `INITIAL MARGIN 0%`. Those values are useful diagnostics, but they are not closure evidence: an open position can temporarily have zero P/L, and margin presentation may change.

ATLAS will therefore read the dedicated `POSITION` value belonging to the verified selected account:

- A successfully parsed numeric value other than zero means `OPEN`.
- A successfully parsed numeric zero means a flat observation.
- A missing `POSITION` label, missing value, unverified selected account, popup/overlay, disconnected page, ambiguous DOM match, or unparsable value means `UNKNOWN`.
- The absence of an expected element never means flat.
- The words `Flat` or `Closed` are not required and will not be assumed to exist.

The parser will accept the expected signed and formatted position forms, including `0`, `1`, `+1`, `-1`, and comma-formatted numeric values. Any additional text must be isolated to the smallest ticket container that contains the `POSITION` label and its value.

Before live installation is considered verified, the detector must read `FLAT` from the currently observed `POSITION 0` screen. The next real user-driven trade will provide an additional runtime calibration: ATLAS must observe a nonzero `POSITION` while the trade is open and return to two confirmed zeros after exit. ATLAS will not place a real order merely to manufacture this test.

## State Model

Each locally recorded open trade has broker evidence:

```text
OPEN(netPosition, checkedAt)
FLAT_CANDIDATE(firstObservedAt)
FLAT_CONFIRMED(checkedAt)
UNKNOWN(reason, checkedAt)
```

Two consecutive successful zero readings on separate monitor ticks are required to confirm flat. Any nonzero reading resets the flat-candidate counter. `UNKNOWN` retains the local open trade and resets the consecutive-flat counter.

## Reconciliation Flow

### After entry

The Buy/Sell click remains on the existing fast path. Broker-position verification begins only after the click, so it cannot delay order submission.

ATLAS records the local trade immediately for safety, then the monitor reads the account's actual `POSITION` value:

- Nonzero: confirm the trade as broker-open.
- Zero twice: treat the entry as not open (rejected, immediately flattened, or otherwise absent), clear the stale local trade, and rotate safely.
- Unknown: keep the trade recorded and warn without guessing.

### During a trade

The active monitor continues reading equity for target handling and also reads the dedicated position value through the credential worker's serialized queue. Position checks never switch away from an account that ATLAS believes owns an open trade.

- Nonzero: keep monitoring.
- First zero: record a flat candidate; take no completion action yet.
- Second consecutive zero: reconcile the trade as broker-closed.
- Unknown: retain the trade, rate-limit warnings, and retry on the next tick.

### Broker-confirmed closure

On confirmed flat, ATLAS performs exactly-once reconciliation:

1. Re-check that the same local trade is still open.
2. Read settled equity when available.
3. Call the existing rotation close operation once.
4. Clear the credential worker's open-trade lease once.
5. Record an activity event such as `Broker confirmed flat - ATM, liquidation, or external exit detected`.
6. Classify the outcome from entry equity versus settled exit equity.
7. Bench a winner for the rest of the trading day under the existing policy.
8. Keep a loss/liquidation account eligible for rotation under the existing policy.
9. Arm the next account after reconciliation completes.

If settled equity is unavailable, the trade is still completed because broker position is authoritative, but ATLAS does not invent a win/loss classification.

## Webhook Behavior

Opening webhooks request Buy/Sell. Closing webhooks request an exit only when the verified broker position is still nonzero. A close webhook never directly marks the trade complete.

For a close webhook:

- If the broker is already confirmed flat, reconcile without clicking Exit.
- If the broker is confirmed open, click Exit and wait for broker-flat confirmation.
- If broker state is unknown, do not claim completion. Preserve state and retry safely.

All webhook and monitor completion paths use the same serialized, idempotent reconciliation operation so simultaneous events cannot close the rotation twice.

## Multiple Credentials and Priority

Position reads are scoped to the credential worker and verified account label. Operations remain serialized inside one Tradovate login and concurrent across independent credentials. Existing funded-first scheduling remains unchanged. Position monitoring is post-execution work and does not enter the funded or evaluation pre-click critical path.

## Practice Mode

Practice mode does not place a real Tradovate order, so it must not use the live account's zero position to erase its simulated lifecycle. Practice mode keeps its existing simulated open/close behavior. Broker-position status is displayed as `SIMULATED`, not `FLAT` or `OPEN`.

## Failure and Alert Policy

- `UNKNOWN` never becomes flat by timeout.
- Position-read failures do not pause the entire bot.
- Warnings are rate-limited per lane/account.
- A Telegram alert is sent only after a configurable number of consecutive unknown reads while ATLAS records an open trade.
- The event includes credential, lane, account, and the detector's reason.
- Manual `Mark closed / reset` remains an emergency recovery tool and clearly states that it does not close a broker position.

## Dashboard and Observability

For each active lane, expose:

- Broker state: `OPEN +N`, `OPEN -N`, `FLAT CHECK 1/2`, `FLAT`, `UNKNOWN`, or `SIMULATED`.
- Last successful broker-position check time.
- Detector reason when unknown.
- Automatic closure source: broker-position reconciliation rather than webhook.

The activity log distinguishes ATM/liquidation/external exits from webhook-requested exits without claiming which broker-side mechanism occurred when the screen only proves that the position is flat.

## Safety Constraints

- No new API or DOM path may place, modify, or cancel an order except the existing explicit Buy/Sell/Exit commands.
- Calibration and status probes are read-only.
- The selected account must be verified before its position value is trusted.
- A zero from the wrong account or an ambiguous ticket is `UNKNOWN`, not flat.
- Two consecutive zeros are required before automatic completion.
- Reconciliation is exactly once across monitor, ATM, liquidation, webhook, and manual races.
- Live installation starts in `Practice` and `Paused`.

## Verification Strategy

Implementation follows test-driven development:

1. Unit tests for numeric position parsing and ambiguous/missing states.
2. Browser fixture tests reproducing the calibrated `POSITION 0` ticket and nonzero long/short variants.
3. Reconciler tests for two-zero confirmation, unknown fail-safe behavior, idempotency, balance-based winner/loss rotation, and webhook races.
4. Credential worker tests proving serialized, account-verified reads and lease clearing.
5. Server/route tests proving close webhooks no longer directly complete trades.
6. Full existing automated and Chrome-backed suite.
7. Read-only verification against the real authenticated Tradovate screen showing `POSITION 0`.
8. Backup and install to live V3, then verify ATLAS at `http://localhost:3400/` in `Practice` and `Paused`.

The first naturally occurring real trade after installation is the final open-state calibration. ATLAS will log the observed nonzero value and subsequent confirmed return to zero so it can be verified without intentionally placing a test trade.

## Top Positions Counter Amendment

The authenticated live Tradovate DOM also exposes a selected-account summary in the form `Positions: +N / -N`. ATLAS will read this during the same post-entry monitoring cycle as the order-ticket `Position N` value.

- The visible order-ticket `Position N` remains the primary signed net-position source.
- The selected-account top counter is a corroborating/fallback source: either side above zero means open; both sides at zero mean a flat observation.
- The selected account must be verified before either source is trusted.
- If both sources are available and disagree, the result is `UNKNOWN`; ATLAS keeps the trade recorded and retries.
- A missing, hidden, malformed, or ambiguous counter never implies flat.
- The existing two-consecutive-flat rule remains unchanged.
- This read occurs in the monitor/maintenance queue before equity monitoring and never delays Buy/Sell execution.

Alternatives considered were using only the top counter (rejected because losing an independent ticket-level signal reduces safety) and using the Tradovate API (deferred because it requires a separate authentication/application integration). The dual visible-DOM design is the smallest safe extension to the current system.
