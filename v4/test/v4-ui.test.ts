import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("configured scanned accounts remain editable", () => {
  const source = readFileSync(resolve("public/onboarding.js"), "utf8");
  assert.match(source, /\/api\/accounts\/\$\{encodeURIComponent\(accountId\)\}/);
  assert.match(source, /"PATCH"/);
  assert.match(source, /Save changes/);
  assert.match(source, /Configured/);
  assert.match(source, /pool\.accountIds\.includes\(account\.id\)/);
  assert.doesNotMatch(source, /Already configured<\/span>/);
  assert.match(source, /targetPerContract/);
  assert.match(source, /stopPerContract/);
  assert.match(source, /test-bracket/);
});

test("onboarding prefills editable brackets from the selected account stage", () => {
  const source = readFileSync(resolve("public/onboarding.js"), "utf8");
  assert.match(source, /eval:\s*\{\s*targetPerContract:\s*1520,\s*stopPerContract:\s*1000\s*\}/);
  assert.match(source, /funded:\s*\{\s*targetPerContract:\s*4000,\s*stopPerContract:\s*1000\s*\}/);
  assert.match(source, /stageDefaults/);
  assert.match(source, /wireStageDefaults/);
  assert.match(source, /addEventListener\("change"/);
  assert.match(source, /autoTarget/);
  assert.match(source, /autoStop/);
  assert.match(source, /currentTarget.*recordedTarget/s);
  assert.match(source, /currentStop.*recordedStop/s);
});

test("control center renders every rotation with explicit account controls", () => {
  const app = readFileSync(resolve("public/app.js"), "utf8");
  const html = readFileSync(resolve("public/index.html"), "utf8");
  assert.match(html, /id="pool-list"/);
  assert.doesNotMatch(html, /id="pool-tabs"/);
  assert.match(app, /data\.pools\.map\(renderPool\)\.join\(""\)/);
  assert.match(app, /Make next/);
  assert.match(app, /Skip today/);
  assert.match(app, /Resume today/);
  assert.match(app, /Delete account/);
  assert.match(app, /targetPerContract/);
  assert.match(app, /stopPerContract/);
  assert.match(app, /TP \$/);
  assert.match(app, /SL \$/);
  assert.match(app, /Save bracket/);
  assert.match(app, /Unconfigured.*trade blocked/i);
  assert.match(app, /api\/accounts\/\$\{encodeURIComponent\(accountId\)\}\/bracket/);
  assert.doesNotMatch(app, /selectedPool/);
  assert.doesNotMatch(app, /choosePool/);
  assert.match(app, /summarizeBalanceRefresh/);
  assert.match(app, /button\.disabled\s*=\s*true/);
  assert.match(app, /balances updated/);
  assert.match(app, /not updated/);
  assert.match(app, /accountErrors/);
  assert.match(app, /platformLabel/);
});

test("control center shows a real copyable URL for every pool webhook", () => {
  const app = readFileSync(resolve("public/app.js"), "utf8");
  assert.match(app, /data\.tunnel\?\.url\s*\|\|\s*data\.tunnel\?\.configuredUrl\s*\|\|\s*window\.location\.origin/);
  assert.match(app, /new URL\(`\/webhook\/\$\{encodeURIComponent\(poolId\)\}`/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(app, /Copy webhook/);
  assert.match(app, /Test webhook/);
  assert.match(app, /\/api\/pools\/\$\{encodeURIComponent\(poolId\)\}\/test-webhook/);
  assert.match(app, /Permanently delete this account from V4 and every rotation\?/);
});

test("V4 server exposes and manages the public ngrok tunnel", () => {
  const server = readFileSync(resolve("src/server-v4.ts"), "utf8");
  assert.match(server, /autoStartTunnel/);
  assert.match(server, /disconnectTunnel/);
  assert.match(server, /tunnelStatus/);
  assert.match(server, /tunnel:\s*tunnelStatus\(\)/);
  assert.match(server, /\/api\/tunnel\/connect/);
  assert.match(server, /\/api\/pools\/:poolId\/test-webhook/);
  assert.match(server, /config\.ngrokAutostart[\s\S]*connectTunnel\(\)/);
});

test("control center shows whether each next account is actually pre-armed", () => {
  const app = readFileSync(resolve("public/app.js"), "utf8");
  const html = readFileSync(resolve("public/index.html"), "utf8");
  assert.match(app, /pool\.armed/);
  assert.match(app, /armedAccountId/);
  assert.match(app, /Armed/);
  assert.match(app, /Pre-arm failed/);
  assert.match(app, /prearmError/);
  assert.match(html, /manual changes.*Tradovate.*Make next/i);
});

test("ATLAS sends actionable Telegram alerts from active V4 lifecycle failures", () => {
  const server = readFileSync(resolve("src/server-v4.ts"), "utf8");
  assert.match(server, /Webhook failed for.*notifyActionNeeded/s);
  assert.match(server, /Health recovery failed.*notifyActionNeeded/s);
  assert.match(server, /Dashboard test webhook failed.*notifyActionNeeded/s);
  assert.match(server, /notifyGoodNews/);
});

test("dashboard and onboarding use the ATLAS identity", () => {
  const dashboard = readFileSync(resolve("public/index.html"), "utf8");
  const onboarding = readFileSync(resolve("public/onboarding.html"), "utf8");
  for (const html of [dashboard, onboarding]) {
    assert.match(html, /<title>ATLAS/);
    assert.match(html, /ACCOUNT TRADING LANE AUTOMATION SYSTEM/);
    assert.match(html, />ATLAS</);
  }
  assert.doesNotMatch(dashboard, /V4 Control Center/);
});

test("dashboard groups configured accounts under each logged-in session", () => {
  const html = readFileSync(resolve("public/index.html"), "utf8");
  const app = readFileSync(resolve("public/app.js"), "utf8");
  const server = readFileSync(resolve("src/server-v4.ts"), "utf8");
  assert.match(html, /id="login-sessions"/);
  assert.match(app, /Configured accounts/);
  assert.match(app, /connection\.accounts/);
  assert.match(app, /platformLabel/);
  assert.match(app, /Currently selected/);
  assert.match(server, /accounts:\s*registry\.snapshot\(\)\.accounts\.filter/);
});

test("each pool keeps its own explicit webhook test result", () => {
  const app = readFileSync(resolve("public/app.js"), "utf8");
  assert.match(app, /test-result-\$\{esc\(pool\.id\)\}/);
  assert.match(app, /test-button-\$\{esc\(pool\.id\)\}/);
  assert.match(app, /SUCCESS —/);
  assert.match(app, /FAILED —/);
  assert.match(app, /testResults/);
  assert.match(app, /button\.disabled\s*=\s*true/);
  assert.match(app, /finally[\s\S]*button\.disabled\s*=\s*false/);
});

test("Add another login opens reliably and guides the complete saved-login flow", () => {
  const onboarding = readFileSync(resolve("public/onboarding.js"), "utf8");
  const styles = readFileSync(resolve("public/style.css"), "utf8");
  const server = readFileSync(resolve("src/server-v4.ts"), "utf8");
  assert.match(onboarding, /classList\.toggle\("is-open"/);
  assert.match(onboarding, /login-name.*focus/s);
  assert.match(onboarding, /scrollIntoView/);
  assert.match(onboarding, /creatingLogin/);
  assert.match(onboarding, /Login name and firm name are required/);
  assert.match(onboarding, /saveButton\.disabled\s*=\s*true/);
  assert.match(onboarding, /document\.querySelector\("#connection"\)\.value\s*=\s*body\.connection\.id/);
  assert.match(onboarding, /Connect.*login.*scan/is);
  assert.match(styles, /\.add-login\.is-open/);
  assert.match(server, /Login name and firm name are required/);
});
