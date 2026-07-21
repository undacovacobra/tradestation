import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

test("ATLAS replaces Trading Bot wording in the title and upper-left brand", () => {
  assert.match(html, /<title>ATLAS<\/title>/);
  assert.match(html, /<h1>ATLAS<\/h1>/);
  assert.doesNotMatch(html, /Trading Bot V3/i);
});

test("dashboard renders one credential surface with evaluation left and funded right", () => {
  assert.match(html, /id="login-list"/);
  assert.equal((html.match(/id="global-evals-webhook-url"/g) || []).length, 1);
  assert.equal((html.match(/id="global-funded-webhook-url"/g) || []).length, 1);
  assert.match(html, /Evaluations webhook \(all evaluation lanes\)/);
  assert.match(html, /Funded webhook \(all funded lanes\)/);
  assert.doesNotMatch(html, /broadcast-webhook-url/);
  assert.doesNotMatch(html, /class="webhook-url"/);
  assert.match(app, /status\.credentials/);
  assert.match(app, /status\.publicWebhookBaseUrl/);
  assert.match(app, /credential-card/);
  assert.match(app, /credential-stage-grid/);
  assert.match(app, /credential-stage-panel/);
  assert.match(app, /const STAGES = \["evals", "funded", "winning"\]/);
  assert.match(app, /const orderedStages = STAGES/);
  assert.match(app, /data-stage="\$\{esc\(lane\.stage\)\}"/);
  assert.match(app, /credential-account-list/);
  assert.match(app, /credential-account-row/);
  assert.doesNotMatch(app, /lane\.webhookPath/);
  assert.doesNotMatch(app, /credential\.webhookPath/);
  assert.doesNotMatch(app, /credential-webhook/);
  assert.match(app, /queue/);
  assert.match(app, /credential-account-action/);
  assert.doesNotMatch(`${app}\n${css}`, /lane-card|lane-grid|lane-accounts/);
  assert.doesNotMatch(app, /combinedAccounts/);
  assert.doesNotMatch(app, /data-lane-login|lane-login-assign/);
  assert.match(css, /\.credential-stage-grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.credential-card/);
});

test("combined rows preserve balance, evaluation target, ATM, and history information", () => {
  assert.match(app, /balanceLine\(account\)/);
  assert.match(app, /bracketLine\(account\)/);
  assert.match(app, /sparkline\(account\.history\)/);
  assert.match(app, /stageInfo\(account\.group\)\.short/);
  assert.match(app, /\$53,000|53000|status\.evalTarget/);
  assert.match(app, /acct\.group !== "evals"/);
});

test("stage account identity stays compact and details and actions wrap independently", () => {
  assert.match(app, /class="credential-account-main"/);
  assert.match(app, /class="credential-account-details"/);
  assert.match(app, /class="credential-account-actions"/);
  assert.match(css, /\.credential-account-id[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.credential-account-details[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.credential-account-actions[^}]*flex-wrap:\s*wrap/s);
});

test("legacy duplicate account groups and their controls are removed", () => {
  assert.doesNotMatch(html, /id="group-evals"|id="group-funded"|class="groups"/);
  assert.doesNotMatch(`${html}\n${app}`, /btn-simultaneous|simultaneous-form|credential-test/);
  assert.doesNotMatch(app, /function renderGroup|renderGroup\(/);
  assert.doesNotMatch(app, /\.speed-test|\.add-form/);
  assert.doesNotMatch(app, /lane-add-account|showAddAccountModal|add-lane-account-modal/);
});

test("credential lane actions carry the credential id", () => {
  assert.match(app, /credentialId/);
  assert.match(app, /\/next/);
  assert.match(app, /\/reset-trade/);
});

test("credential management is visible before the long lane list", () => {
  assert.match(html, /id="btn-add-login"/);
  assert.equal((html.match(/id="btn-add-login"/g) || []).length, 1);
  assert.match(html, /id="btn-scan-assign"/);
  assert.equal((html.match(/Scan &amp; assign accounts/g) || []).length, 1);
  assert.doesNotMatch(html, /id="btn-scan"/);
  assert.match(html, /Add or import Tradovate accounts/);
  assert.match(html, /one sign-in for both lanes/i);
  assert.match(html, /Funded work is prioritized/i);
  assert.doesNotMatch(html, /id="add-login-form"/);
  assert.match(app, /Scan &amp; assign/);
  assert.match(app, /different Tradovate username and password/i);
  assert.match(app, /\/logins/);
  assert.match(app, /\/accounts\/add/);
  assert.match(app, /value="evals"/);
  assert.match(app, /value="funded"/);
  assert.match(app, /value="skip"/);
  assert.doesNotMatch(app, /class="btn small login-connect"|class="btn small login-scan"/);
  assert.match(css, /\.credential-tools/);
  assert.match(css, /\.credential-stage-grid/);
});

test("dashboard exposes a confirmed global flatten control that does not pause ATLAS", () => {
  assert.equal((html.match(/id="btn-flatten-all"/g) || []).length, 1);
  assert.match(app, /\/positions\/flatten-all/);
  assert.match(app, /confirm:\s*"FLATTEN ALL"/);
  assert.match(app, /even in Practice/i);
  assert.match(app, /does not pause ATLAS/i);
  assert.match(app, /flatten-results/);
});
