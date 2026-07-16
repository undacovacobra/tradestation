# ATLAS Compact Lanes and Global Webhooks Design

## Goal

Tighten the V3-style credentials and lanes dashboard, prevent account identifiers from collapsing into vertical characters, and display the two webhook URLs the operator actually uses.

## Root Causes

Each account is currently rendered as one non-wrapping flex row containing the identity and every control. The fixed-width controls consume the available lane width, while the identity is the only flexible item and has `min-width: 0`; the browser therefore compresses the identifier to roughly one character per line.

The server already exposes global stage routes at `/webhook/evals` and `/webhook/funded`. The dashboard nevertheless emphasizes per-credential and per-lane routes. Its URL builder also falls back to the local browser origin whenever the in-process tunnel status has no current URL, producing incorrect `localhost` addresses for an externally managed permanent ngrok domain.

## Approved Layout

- Preserve the recognizable V3 dashboard and two side-by-side lane cards on desktop.
- Render each account as a compact account row with a dedicated identity area and a separate action area.
- Keep account names and identifiers on one line. Long values may truncate visually with a title tooltip, but must never break character by character.
- Let the action area wrap independently when necessary.
- Use smaller controls and a compact login selector to reduce lane height and visual noise.
- Stack lane cards only at the existing narrow-screen breakpoint.

## Approved Webhook Model

Display exactly two primary TradingView webhook URLs in the credentials section:

- Evaluations: `https://antennae-compress-panning.ngrok-free.dev/webhook/evals`
- Funded: `https://antennae-compress-panning.ngrok-free.dev/webhook/funded`

The evaluations URL dispatches to every evaluation lane across all saved Tradovate credentials. The funded URL dispatches to every funded lane across all saved Tradovate credentials. Funded scheduling priority remains unchanged.

Remove the combined “all credentials and lanes,” per-credential “both lanes,” and per-lane webhook displays from the dashboard. The underlying compatibility routes may remain available to avoid breaking existing API behavior; they are simply no longer presented as the operator’s TradingView configuration.

## Public URL Source

Add an explicit `PUBLIC_WEBHOOK_BASE_URL` configuration value. The server publishes the normalized value in dashboard status, and the client builds both global webhook URLs from it. If it is absent, an active tunnel URL may be used; only then may the local origin be the final fallback for local development.

The live V3 `.env` will set:

`PUBLIC_WEBHOOK_BASE_URL=https://antennae-compress-panning.ngrok-free.dev`

## Safety and Error Handling

- URL normalization accepts only absolute HTTP or HTTPS origins and removes trailing slashes.
- Invalid configured values fail startup with an actionable message rather than silently displaying a false address.
- This change affects dashboard presentation and URL publication only. It does not change entry execution, broker sessions, account rotation, funded priority, or webhook dispatch semantics.
- Installation occurs only while ATLAS is in Practice and Paused, with a timestamped backup first.

## Verification

- A unit test proves public webhook base normalization and rejection.
- UI source tests prove only the two global stage webhook surfaces are rendered and per-lane/per-credential URL displays are absent.
- CSS tests prove account identity is non-wrapping and actions have an independent wrapping container.
- Existing webhook route tests continue proving global stage dispatch across credentials.
- TypeScript and the complete test suite pass.
- The installed localhost dashboard is visually inspected at desktop and narrow widths, with no real order placed.
