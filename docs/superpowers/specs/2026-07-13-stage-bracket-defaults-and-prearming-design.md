# V4 Stage Bracket Defaults and Pre-Arming Design

## Goal

Give every evaluation and funded account a safe, editable default dollar bracket and prepare the next account before its webhook arrives. A correctly pre-armed webhook should not spend time switching accounts or configuring the ATM bracket before clicking the order button.

## Stage Defaults

V4 will use these defaults per contract:

| Stage | Take profit | Stop loss |
| --- | ---: | ---: |
| Evaluation | $1,520 | $1,000 |
| Funded | $4,000 | $1,000 |

New accounts receive the defaults for their selected stage. Existing accounts whose bracket is still unconfigured (`0/0`) are migrated to their stage defaults. Existing positive custom TP/SL pairs are preserved.

The onboarding form pre-fills the matching values for a new account. When the user changes a new or still-defaulted account's stage, the form changes to the other stage's defaults. Once either field has been customized, changing the stage does not overwrite the custom pair. The Control Center's existing per-account TP and SL fields remain editable and continue to save custom values.

## Pre-Arming

Pre-arming means:

1. Select the account in its saved browser login.
2. Set and verify that account's TP and SL in Tradovate ATM Settings.
3. Record the exact account id and bracket pair as armed.
4. Never click Buy, Sell, or Exit during pre-arming.

V4 triggers pre-arming when:

- the user clicks **Make next**;
- a close advances a pool to its next account;
- an account is removed, skipped, held, or passed and that changes the next account;
- a connection starts or recovers and has an eligible next account.

Pre-arming runs through the existing per-login worker queue, so browser actions for one login remain serialized. The account is not reported as armed until selection and bracket verification both succeed.

## Webhook Fast Path

Each connection worker tracks an armed signature containing the account id, platform label, target, and stop. Entry preparation compares the requested account with that signature.

- If the signature matches, V4 skips account switching and bracket configuration. It sets quantity when required and then clicks Buy or Sell.
- If the signature does not match, V4 safely performs the existing account switch and bracket verification before the order click.
- A browser reconnect, recovery, V4-driven account switch, bracket failure, or account reconfiguration invalidates the armed signature.

The fast path assumes V4 remains the only component that changes the selected account or ATM bracket after pre-arming. The Control Center will warn that manually changing either setting in Tradovate requires using **Make next** again to re-arm before the next webhook.

This preserves the existing fail-closed rule: V4 never clicks an entry order when it cannot verify a positive TP/SL pair.

## Multiple Pools and Logins

A browser login can physically have only one selected account and one prepared ATM bracket at a time. Therefore, only one account can be armed per connection. Separate saved logins can be armed independently and can prepare or trade concurrently through their separate workers.

If two pools share one connection, the most recent successful pre-arm becomes the connection's armed account. A webhook for the other pool uses the safe fallback and prepares its account before entry. The dashboard must not claim that both accounts are armed.

## Status and Errors

The connection/pool status will expose:

- the armed account id and bracket;
- whether the pool's current next account matches the connection's armed signature;
- the most recent pre-arm error, if any.

The Control Center displays **Armed** when the current next account matches and **Pre-arm failed** with the error when preparation fails. A pre-arm failure does not open a trade, does not advance rotation, and does not prevent the safe webhook fallback from retrying preparation.

## Data and Migration

Stage defaults are defined in one shared server-side helper so registry migration, onboarding, and tests use the same values. Loading a registry converts only `0/0` accounts to defaults and persists the migration atomically. Valid custom brackets remain unchanged.

No new secret, webhook, pool, or connection configuration is required.

## Testing

Automated coverage will verify:

- new eval and funded accounts receive the correct defaults;
- existing `0/0` accounts migrate while custom pairs remain unchanged;
- onboarding fields change defaults with stage without overwriting custom edits;
- **Make next** pre-arms without clicking an order;
- automatic rotation advancement pre-arms the new next account;
- a matching armed signature skips switching and bracket setup on entry;
- a missing or stale signature uses the safe preparation fallback;
- separate connections pre-arm independently;
- pools sharing one connection report only the actual armed account;
- pre-arm failures remain fail-closed and visible in status.
