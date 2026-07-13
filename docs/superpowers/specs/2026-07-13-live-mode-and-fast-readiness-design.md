# ATLAS Live Mode and Fast Readiness Design

## Goal

Expose a safe, obvious dashboard control for choosing practice or live execution and remove account, balance, and ATM-dialog work from the critical webhook path.

## Execution mode

The dashboard header will show a two-state Practice/Live control beside the current running status. Practice remains the default. Enabling Live requires a deliberate confirmation in the dashboard and a matching confirmation flag at the local API. The selected mode is persisted in `data/registry.json`, recorded in Recent activity, and rendered prominently. Returning to Practice is immediate.

Test webhooks remain non-ordering in both modes. They never click Buy, Sell, or Exit and never create pool open-trade state.

## Readiness model

Each saved login owns one serialized browser worker and one armed signature. The signature identifies the exact account, platform label, take-profit dollars, and stop-loss dollars. It also retains the balance captured during idle preparation.

Preparing a login happens before a webhook: select the account, read its balance, write and save the ATM bracket, reopen it once to verify the persisted values, then mark that exact signature armed. When the signature matches at entry time, ATLAS uses the cached balance and performs only the order-ticket quantity update when necessary followed by the Buy/Sell click. It does not reopen the ATM dialog or reread the balance in the critical path.

A live entry whose exact account and bracket are not armed is rejected instead of performing a slow just-in-time setup. The error is visible on the dashboard and uses the existing Telegram action-needed notification path. This prevents a late or incorrectly configured click.

## Multiple logins and pools

Separate login workers retain independent browser sessions, queues, armed signatures, and cached balances. Signals for separate logins may execute concurrently. A single login can have only one selected account and one effective ATM configuration, so only one pool using that login can be armed at a time. The dashboard will explain that condition on the affected pool rather than representing both pools as ready.

Pools keep their existing execution lanes. Separate lane names allow concurrent positions; a shared lane remains mutually exclusive.

## Test webhook behavior

The pool test endpoint remains safe. If the exact next account is already armed, the test returns immediately from the verified readiness state. If it is not armed, it performs the full idle preparation and verification once. The result reports whether the account was already ready or was newly prepared and includes elapsed preparation time. No order-producing method is called.

## Failure handling

- Live activation is rejected unless at least one configured login is connected and logged in.
- Unarmed live signals are blocked with an actionable message.
- Preparation or ATM mismatch clears the armed signature.
- Account or bracket changes trigger a new idle preparation.
- Practice mode never sends an order even if a login is armed.
- Test webhook responses explicitly state that no trade was placed.

## Verification

Automated coverage will prove mode persistence and API confirmation, practice non-execution, unarmed live rejection, cached-balance fast entry, no final ATM verification on the armed path, safe test behavior, and parallel execution across independent login workers. Browser verification will confirm the mode control, warning/confirmation copy, and per-pool readiness timing.
