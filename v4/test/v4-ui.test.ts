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
  assert.doesNotMatch(app, /selectedPool/);
  assert.doesNotMatch(app, /choosePool/);
});
