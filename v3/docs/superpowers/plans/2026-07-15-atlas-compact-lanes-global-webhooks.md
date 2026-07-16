# ATLAS Compact Lanes and Global Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent vertical account-ID wrapping and display only the correct public evaluation and funded webhooks across all credential lanes.

**Architecture:** Add a pure public-base URL normalizer at the configuration boundary, publish the normalized base in `/api/status`, and make the dashboard use it before tunnel or local fallbacks. Preserve existing webhook routes while simplifying the UI to two global stage endpoints and splitting each account row into independently sized identity and action zones.

**Tech Stack:** TypeScript, Express, browser JavaScript, CSS Grid/Flexbox, Node test runner, Playwright/Chrome for visual verification.

## Global Constraints

- Evaluations URL: `https://antennae-compress-panning.ngrok-free.dev/webhook/evals`.
- Funded URL: `https://antennae-compress-panning.ngrok-free.dev/webhook/funded`.
- Preserve V3 structure, two desktop lane cards, existing dispatch routes, funded priority, execution timing, credentials, accounts, and ATM values.
- Never place an order during testing.
- Install only while live ATLAS is Practice and Paused, after a timestamped backup.

---

### Task 1: Public webhook base configuration

**Files:**
- Create: `src/publicWebhookBase.ts`
- Create: `test/publicWebhookBase.test.ts`
- Modify: `src/config.ts`
- Modify: `src/server.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `normalizePublicWebhookBase(raw: string | undefined): string | null`.
- Produces: `config.publicWebhookBaseUrl: string | null`.
- Produces: `/api/status.publicWebhookBaseUrl: string | null`.

- [ ] **Step 1: Write the failing normalizer tests**

```ts
assert.equal(normalizePublicWebhookBase(undefined), null);
assert.equal(normalizePublicWebhookBase("https://antennae-compress-panning.ngrok-free.dev/"), "https://antennae-compress-panning.ngrok-free.dev");
assert.throws(() => normalizePublicWebhookBase("localhost:3400"), /absolute HTTP/i);
assert.throws(() => normalizePublicWebhookBase("ftp://example.com"), /HTTP or HTTPS/i);
assert.throws(() => normalizePublicWebhookBase("https://example.com/path"), /origin/i);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test test/publicWebhookBase.test.ts`

Expected: FAIL because `src/publicWebhookBase.ts` does not exist.

- [ ] **Step 3: Implement the pure normalizer**

```ts
export function normalizePublicWebhookBase(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("PUBLIC_WEBHOOK_BASE_URL must be an absolute HTTP or HTTPS URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_WEBHOOK_BASE_URL must use HTTP or HTTPS.");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("PUBLIC_WEBHOOK_BASE_URL must contain only an origin, with no path, credentials, query, or hash.");
  }
  return url.origin;
}
```

- [ ] **Step 4: Wire the value through config and status**

Add `publicWebhookBaseUrl: normalizePublicWebhookBase(process.env.PUBLIC_WEBHOOK_BASE_URL)` to `config`, add `publicWebhookBaseUrl: config.publicWebhookBaseUrl` to `/api/status`, and document the new environment key in `.env.example`.

- [ ] **Step 5: Run the focused test and TypeScript**

Run: `node --import tsx --test test/publicWebhookBase.test.ts`

Expected: PASS.

Run: `npx.cmd tsc --noEmit`

Expected: exit 0.

### Task 2: Global stage webhook presentation

**Files:**
- Modify: `test/ui-atlas.test.ts`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `status.publicWebhookBaseUrl` from Task 1.
- Produces: exactly two visible webhook code values, `#global-evals-webhook-url` and `#global-funded-webhook-url`.

- [ ] **Step 1: Write failing UI contract assertions**

```ts
assert.match(app, /status\.publicWebhookBaseUrl/);
assert.doesNotMatch(app, /lane\.webhookPath/);
assert.doesNotMatch(app, /credential\.webhookPath/);
assert.doesNotMatch(html, /broadcast-webhook-url/);
assert.doesNotMatch(html, /class="webhook-url"/);
assert.match(html, /Evaluations webhook \(all evaluation lanes\)/);
assert.match(html, /Funded webhook \(all funded lanes\)/);
```

- [ ] **Step 2: Run the UI test and verify RED**

Run: `node --import tsx --test test/ui-atlas.test.ts`

Expected: FAIL on the old lane, credential, broadcast, and localhost-fallback presentation.

- [ ] **Step 3: Replace duplicate webhook surfaces**

Move the two global stage rows directly below the credentials heading, label their scope explicitly, and remove the combined broadcast row, per-credential webhook row, per-lane webhook row, and duplicated group webhook code fields. Keep speed-test buttons inside their group headings.

- [ ] **Step 4: Use the explicit public base first**

```js
const webhookBase = status.publicWebhookBaseUrl || (status.tunnel && status.tunnel.url) || window.location.origin;
```

Build only the evaluation and funded URLs from `status.globalWebhookPaths` and this base. Remove event handlers for deleted copy controls while preserving the two `.copy-global` handlers.

- [ ] **Step 5: Run the UI test and verify GREEN**

Run: `node --import tsx --test test/ui-atlas.test.ts`

Expected: PASS.

### Task 3: Compact non-collapsing account rows

**Files:**
- Modify: `test/ui-atlas.test.ts`
- Modify: `public/app.js`
- Modify: `public/style.css`

**Interfaces:**
- Produces: `.lane-account-main` identity zone and `.lane-account-actions` control zone.

- [ ] **Step 1: Add failing layout assertions**

```ts
assert.match(app, /class="lane-account-main"/);
assert.match(app, /class="lane-account-actions"/);
assert.match(css, /\.lane-account-id[^}]*white-space:\s*nowrap/s);
assert.match(css, /\.lane-account-actions[^}]*flex-wrap:\s*wrap/s);
assert.doesNotMatch(css, /\.lane-accounts small[^}]*word-break:\s*break-all/s);
```

- [ ] **Step 2: Run the UI test and verify RED**

Run: `node --import tsx --test test/ui-atlas.test.ts`

Expected: FAIL because the account identity and actions share one flex row.

- [ ] **Step 3: Split the account markup into two zones**

Render the name/ID/ATM inside `.lane-account-main`, with the exact identifier in a `title` attribute, and render NEXT, ATM, ordering, enable/disable, remove, and login assignment inside `.lane-account-actions`.

- [ ] **Step 4: Apply compact grid and overflow rules**

Use `grid-template-columns: minmax(150px, 1fr) minmax(0, auto)` on desktop account rows. Set the identity text to `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`. Let only the action zone wrap, reduce button padding/font size, and cap the login selector width without changing its behavior.

- [ ] **Step 5: Run the UI test and verify GREEN**

Run: `node --import tsx --test test/ui-atlas.test.ts`

Expected: PASS.

### Task 4: Full verification and safe live installation

**Files:**
- Modify live environment: `C:\Users\TheTr\OneDrive\Documents\v3\.env`
- Copy verified runtime/UI/test files into: `C:\Users\TheTr\OneDrive\Documents\v3`

**Interfaces:**
- Consumes: all verified outputs from Tasks 1-3.

- [ ] **Step 1: Run complete staging verification**

Run: `npx.cmd tsc --noEmit`

Run: `$env:PW_CHROMIUM='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm.cmd test`

Expected: TypeScript exit 0 and every test passes with zero skips.

- [ ] **Step 2: Confirm safe live state and back up**

Require `/health` to report `mode: practice` and `running: false`. Create `backups/atlas-compact-webhooks-<timestamp>` containing every live file that will be replaced plus the current `.env`.

- [ ] **Step 3: Install and configure**

Copy only the verified changed files. Set exactly one live environment line:

```dotenv
PUBLIC_WEBHOOK_BASE_URL=https://antennae-compress-panning.ngrok-free.dev
```

Preserve all secrets, accounts, session directories, data, logs, and other environment values.

- [ ] **Step 4: Restart only the verified port-3400 ATLAS process**

Verify the listener command points to `C:\Users\TheTr\OneDrive\Documents\v3\src\server.ts`, stop that process tree, start `npm.cmd start` hidden from the live directory, and poll `/health` until it returns healthy.

- [ ] **Step 5: Verify the installed copy**

Compare SHA-256 hashes for copied files, run TypeScript and the complete tests in the live directory, and recheck `/health` for Practice + Paused.

- [ ] **Step 6: Visually verify localhost**

Refresh `http://localhost:3400/` in the in-app browser. At desktop width, verify account IDs remain horizontal, lane cards remain side by side, and the only displayed webhook URLs are the permanent evaluation and funded URLs. At a narrow width, verify clean stacking and usable controls. Do not click Start, Live, Buy, Sell, Exit, or any order-triggering control.
