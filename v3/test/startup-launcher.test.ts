import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = join(import.meta.dirname, "..", "..");

test("Windows launcher starts the current v3 build without PowerShell scripts", () => {
  const launcher = readFileSync(join(repositoryRoot, "Start ATLAS.cmd"), "utf8");
  const watchdog = readFileSync(join(repositoryRoot, "run-atlas.cmd"), "utf8");

  assert.match(launcher, /run-atlas\.cmd/i);
  assert.match(watchdog, /npm\.cmd\s+--prefix\s+"%ATLAS_DIR%"\s+start/i);
  assert.doesNotMatch(watchdog, /call\s+npm\s+start/i);
});

test("root README gives a PowerShell-safe v3 startup command", () => {
  const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");

  assert.match(readme, /Start ATLAS\.cmd/i);
  assert.match(readme, /npm\.cmd\s+--prefix\s+v3\s+start/i);
});

test("Windows launcher migrates an existing root ATLAS configuration into v3", () => {
  const watchdog = readFileSync(join(repositoryRoot, "run-atlas.cmd"), "utf8");

  assert.match(watchdog, /copy\s+\/y\s+"%REPO_ROOT%\\\.env"\s+"%ATLAS_DIR%\\\.env"/i);
  assert.match(watchdog, /robocopy\s+"%REPO_ROOT%\\data"\s+"%ATLAS_DIR%\\data"/i);
  assert.match(watchdog, /mklink\s+\/J\s+"%ATLAS_DIR%\\\.tradovate-session"\s+"%REPO_ROOT%\\\.tradovate-session"/i);
});

test("Windows launcher installs v3 dependencies when they are absent", () => {
  const watchdog = readFileSync(join(repositoryRoot, "run-atlas.cmd"), "utf8");

  assert.match(watchdog, /if not exist "%ATLAS_DIR%\\node_modules\\\.bin\\tsx\.cmd"/i);
  assert.match(watchdog, /npm\.cmd\s+--prefix\s+"%ATLAS_DIR%"\s+install/i);
});

test("Windows launcher reuses an already-running healthy ATLAS server", () => {
  const launcher = readFileSync(join(repositoryRoot, "Start ATLAS.cmd"), "utf8");

  assert.match(launcher, /curl\.exe\s+-fsS\s+http:\/\/localhost:3400\/health/i);
  assert.match(launcher, /if not errorlevel 1 goto open_dashboard/i);
});
