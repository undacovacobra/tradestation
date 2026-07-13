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
  assert.match(app, /Remove from rotation/);
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
