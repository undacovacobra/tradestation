# ATLAS Login Pools and Cross-Login No-Order Test Design

## Goal

Make multiple Tradovate credentials and their evaluation/funded account pools easy to manage from the visible credentials section, and make the no-order simultaneous test exercise an evaluation lane and a funded lane that may belong to different Tradovate logins.

## Root Causes

1. The existing add-login form and the two manual account forms are below long credential cards. They work, but they are not discoverable where the user manages credentials and lanes.
2. Visible lane cards only manage accounts that are already assigned. They do not expose an add action.
3. `POST /api/tests/simultaneous` accepts one `credentialId` and derives both stages from that credential. A funded-only credential therefore reports that both stages need a next account, while a credential with both stages but one sequential Tradovate session correctly rejects same-session simultaneity.
4. Expected no-order test failures are surfaced through native browser alerts, which obscure the dashboard and do not explain how to resolve the selected-lane problem.

## Chosen Design

Preserve the V3 dashboard structure and add management controls to the top of the existing "Tradovate credentials and lanes" card.

- Add a visible credential toolbar with:
  - `Add Tradovate login`
  - `Scan & assign accounts`
- Keep the existing per-credential `Connect` action and rename its scan action to `Scan & assign`.
- Add an `Add account` button inside every Evaluation and Funded lane card. The modal fixes the stage and defaults the execution login to the lane's credential, while still allowing another saved login to be selected.
- Continue using the existing account-add API. Scanned accounts remain assignable to Evaluation, Funded, or Skip before anything is saved.

## Cross-Login No-Order Test

The test opens an ATLAS modal with two independent selectors:

- Evaluation login
- Funded login

Defaults are the first credential with a next Evaluation account and the first credential with a next Funded account. The request sends `evalCredentialId` and `fundedCredentialId`. The server resolves the Evaluation lane from the first ID and the Funded lane from the second ID. The old `credentialId` field remains a compatibility fallback.

If both selections point to the same sequential Tradovate session, the existing fail-safe rejection remains. If they point to different connected workers, the existing no-order readiness implementation can test them concurrently. The test never clicks Buy, Sell, or Exit.

Expected failures are rendered inside the ATLAS modal with corrective text. Native browser alerts are not used for this workflow.

## Data Flow

1. Add login -> `POST /api/logins` -> credential card appears -> Connect -> Scan & assign.
2. Scan & assign -> selected credential's account discovery endpoint -> scan modal -> stage choice per account -> existing `POST /api/accounts/add` calls with the selected `loginId`.
3. Lane-local add -> fixed stage plus account ID, nickname, and execution login -> existing account-add endpoint -> account appears in the correct credential lane.
4. No-order test -> Evaluation/Funded credential selections -> `POST /api/tests/simultaneous` -> stage-specific next accounts -> existing readiness tester -> modal result.

## Error Handling and Safety

- Missing next Evaluation and Funded accounts receive stage-specific instructions.
- Unknown credential IDs fail with a structured 400 response.
- Same-session sequential mode remains blocked unless the dual-ticket probe has proven independent ticket controls.
- All management mutations continue through existing validated APIs.
- No-order test responses always state that no trade was placed.

## Testing

- Pure tests cover distinct Evaluation/Funded credential selection and legacy fallback.
- UI regression tests require the visible add/scan toolbar, lane-local add buttons, two no-order selectors, stage-specific request fields, and modal error rendering without native alerts.
- Existing simultaneous-readiness tests continue proving separate-worker concurrency and same-session sequential rejection.
- Full TypeScript, JavaScript syntax, automated test, and responsive browser checks run before live installation.

## Scope

This change does not add another trading platform, change webhook routing, place an order, or replace the V3 dashboard. It exposes and correctly connects the existing multi-login and account-assignment capabilities.
