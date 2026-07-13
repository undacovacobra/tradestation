# V4 Rotation Management Design

## Goal

Make the V4 dashboard and onboarding flow fully manageable without editing `registry.json`: configured accounts remain editable after a browser scan, every rotation is visible together, and operators can choose the next account, skip an account for the current futures trading day, or remove it from a rotation.

## Current Problem and Root Cause

The browser scan separates labels into known and unknown accounts. Unknown labels receive an onboarding form, while known labels are rendered as a read-only “Already configured” badge. The server likewise exposes an account-create endpoint but no account-update endpoint.

The control center renders only `selectedPool`; pool buttons replace the visible detail panel instead of showing all pools. “Set next” and “Remove” already exist, but they are hidden inside the selected pool. The existing “Hold” action changes the permanent registry status, so it cannot represent a one-day exclusion that automatically expires.

## User Experience

### Account onboarding

After scanning a login, every discovered account is shown as a form.

- New accounts keep the current create flow.
- Configured accounts are prefilled from the saved registry and labeled “Configured.”
- Friendly name, firm, evaluation/funded stage, and rotation-pool membership are editable.
- The internal account id, connection, and platform label remain immutable after creation so saved rotation state and broker matching cannot be orphaned accidentally.
- Saving changes updates the account and its pool memberships atomically.
- An account missing from the live browser remains listed separately as a warning; it is not silently deleted.
- An account with an open trade cannot be edited or removed from a pool until the trade is closed.

### Control center

Remove the pool tabs and render every enabled rotation as a vertically stacked panel. Each panel always shows its webhook path, execution lane, balance target, open-trade state, ordered account roster, and the account currently next in line.

Each account row provides these controls:

- **Make next:** selects that account as the next eligible account in this rotation.
- **Skip today:** excludes the account only from this rotation for the current futures trading day.
- **Resume today:** removes the temporary exclusion immediately.
- **Hold:** changes the account’s persistent registry status and keeps it unavailable until manually reactivated.
- **Remove from rotation:** removes only that pool membership after confirmation. It does not delete the account or its saved login configuration.

“Skip today” automatically expires when the trading-day key changes at the configured reset, currently 6:00 PM Eastern. A skipped account remains visible with a “Skipped today” badge and cannot be selected as next until resumed.

## Data Model and Behavior

Add `skippedDay: Record<string, string>` to each pool’s persisted rotation state. Keys are account ids and values are trading-day keys. Availability filtering excludes an account only when its stored value equals the current trading-day key. Old entries are harmless and may be pruned when the state is next saved.

Temporary skips are pool-specific. Persistent `active`, `held`, and `passed` statuses remain account-wide because they describe the lifecycle of the prop account rather than a single rotation.

Add a registry operation that updates mutable account fields and replaces pool membership in one save. It validates the account and every requested pool before mutating data, preserves pool order for existing memberships, and appends newly added memberships at the end.

Add coordinator operations to skip or resume an account for a pool. They reject changes while that account has the pool’s open trade. Setting next continues to require an enabled, active, non-skipped account.

## API Changes

- `PATCH /api/accounts/:accountId` accepts `name`, `firm`, `stage`, and `poolIds`.
- `POST /api/pools/:poolId/accounts/:accountId` adds `skip-today` and `resume-today` actions.
- `GET /api/status` includes each account’s pool-specific `skippedToday` flag.

Local dashboard authorization follows the existing loopback rule. Errors return the existing `{ ok: false, error }` shape and are displayed beside the action that failed.

## Safety Rules

- Never delete an account definition as part of “Remove from rotation.”
- Never change internal ids, connection ids, or broker platform labels through the edit form.
- Never allow pool membership changes, skips, holds, passes, removal, or next-account changes for the account holding that pool’s open trade.
- Do not overwrite `.env`, browser session directories, balances, or existing registry accounts during deployment.

## Testing

1. Registry tests prove configured account fields and pool memberships update and persist without changing immutable identifiers.
2. Rotation tests prove skip-today excludes an account, resume restores it, and the skip expires after the 6:00 PM trading-day key changes.
3. Coordinator tests prove status exposes `skippedToday` and “Make next” rejects skipped accounts.
4. Static UI tests prove onboarding renders configured accounts as editable forms and the dashboard renders all pools without pool tabs.
5. Run the full V4 typecheck and test suite.
6. Start the local server with the user’s preserved data, verify all rotations and controls in the in-app browser, and leave the refreshed dashboard open.
