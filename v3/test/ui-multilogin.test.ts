import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("recognizable V3 layout remains while one login owns two stage columns", () => {
  assert.match(html, />ATLAS</);
  assert.match(html, /id="login-sessions"/);
  assert.match(html, /one sign-in for both lanes/i);
  assert.match(app, /credential-stage-grid/);
  assert.match(app, /credential-stage-panel/);
  assert.match(app, /credential-account-list/);
  assert.match(app, /data-stage="\$\{esc\(account\.group\)\}"/);
  assert.match(app, /stageInfo\(account\.group\)/);
  assert.doesNotMatch(app, /lane-card|lane-grid|lane-add-account|showAddAccountModal/);
  assert.doesNotMatch(`${html}\n${app}`, /No-order simultaneous test|No-order test|simultaneous-form/);
  assert.doesNotMatch(`${html}\n${app}`, /dollar bracket|pool editor/i);
});

test("additional logins and scan-and-assign remain first-class controls", () => {
  assert.match(html, /id="btn-add-login"/);
  assert.match(html, /id="btn-scan-assign"/);
  assert.match(app, /chooseLogin/);
  assert.match(app, /if \(logins\.length === 1\) return action\(logins\[0\]\.id\)/);
  assert.match(app, /\/logins\/\$\{loginId\}\/accounts/);
  assert.match(app, /globalWebhookPaths/);
  assert.match(app, /publicWebhookBaseUrl/);
  assert.doesNotMatch(app, /broadcastWebhookPath/);
  assert.match(app, /acct\.group !== "evals"/);
  assert.match(app, /status\.tunnel\.url/);
  assert.doesNotMatch(app, /data-lane-login|\/accounts\/login|class="btn small login-connect"|class="btn small login-scan"/);
});
