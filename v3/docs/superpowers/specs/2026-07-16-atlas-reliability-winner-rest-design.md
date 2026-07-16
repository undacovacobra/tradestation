# ATLAS Reliability and Evaluation Winner-Rest Design

## Objective

Make ATLAS resilient to manual dashboard/browser activity, Tradovate UI drift, delayed confirmation controls, lost sessions, duplicate or stale webhooks, process restarts, and simultaneous funded/evaluation positions without slowing the normal funded-first entry path.

## Safety invariants

1. ATLAS never clicks Buy, Sell, or Exit until the exact visible account is proven.
2. A live order request is recorded durably before the broker click, and a broker click is never forgotten merely because the process or disk write fails afterward.
3. A lane is completed only by two exact broker-flat observations or a bounded close-webhook fallback tied to the same recorded trade.
4. Practice mode, browser disconnect, account mutation, and manual reset cannot orphan recorded live exposure.
5. One lane or login failure cannot stop monitoring other open trades.
6. Funded work retains priority on a shared login; independent logins remain parallel.
7. Evaluation winners rest until the next 6:00 PM America/New_York futures-day boundary. Funded accounts do not use this daily-rest policy.

## Execution and broker verification

- Scope account, ATM, quantity, symbol, equity, and position reads to one exact visible trading ticket/account surface.
- Clear stale DOM markers before locating the quantity field.
- Use visible, exact account controls instead of broad first/last text matches.
- Replace fixed switch/ATM sleeps with bounded condition polling.
- Treat a Tradovate confirmation as part of order submission: wait for either a visible confirmation and click it successfully, or a positive broker/UI acknowledgment. A failed confirmation is an entry failure, never a recorded open trade.
- Reject unsupported non-market webhook orders until they are implemented honestly.

## Durable trade lifecycle

Persist a lane state with explicit intent:

1. `entry-intent` is written atomically before clicking.
2. `openTrade` is committed after the click path succeeds.
3. Startup restores either state as a safety lease and reconciles the exact broker account before another entry.
4. Rotation, settings, and balance files use atomic replacement; corrupt files are quarantined and surfaced instead of silently becoming empty/flat.

## Monitoring and recovery

- Inspect all open trades every active cycle, funded first per login and independent across logins.
- Continue after a lane failure and report the failure through a keyed incident with cooldown instead of swallowing it or spamming repeatedly.
- Reconnect a closed browser context automatically. While a trade is open, use the bounded click-only login path first and preserve the safety lease.
- Preserve a matching close webhook as backup evidence. Explicit broker-open evidence always vetoes that fallback.
- Read settled equity from the exact closed account and pass that account-scoped value into completion.

## Evaluation winner-rest lifecycle

- Capture exact entry equity at the final verified ticket snapshot.
- Capture exact settled exit equity for the same account.
- A positive difference marks that evaluation `WON TODAY`; zero/negative results continue rotating.
- An operator can mark a flat evaluation as won/resting and can undo the rest state.
- Rest state is visible on the account row and disables misleading Next controls.
- At the 6:00 PM ET boundary, expired rest markers stop affecting selection and flat lanes are re-armed before the next webhook.
- The existing $53,000 evaluation target remains separate: reaching it flattens and retires the account rather than merely resting it.

## Dashboard controls

- Replace unsafe `Mark closed / reset` behavior with broker reconciliation; it may clear state only after exact broker-flat confirmation.
- Block Live-to-Practice and browser disconnect while live trades or entry intents exist.
- Block account reassignment/removal/ATM edits while that lane has queued, executing, intended, or open work.
- Display credential-specific evaluation/funded webhook URLs in a compact expandable area while retaining the two global URLs.

## Verification

- Unit tests for atomic persistence, corrupt-state handling, lifecycle restoration, exact close correlation, winner rotation, manual rest, and 6 PM/DST rollover.
- Real-Chrome fixtures for hidden account-menu text, stale quantity markers, delayed confirmations, exact ticket scoping, popup/login recovery, and position evidence.
- Repeated concurrency tests for funded priority, eval/funded simultaneity, close cancellation, manual flatten overlap, and independent login parallelism.
- Full TypeScript and test suite with real Chrome, followed by repeated stress runs and a clean live v3 deployment in Practice/Paused mode.
