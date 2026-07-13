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
