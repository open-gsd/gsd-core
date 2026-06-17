/**
 * Regression test for bug #3357.
 *
 * Older Codex installs carried legacy GSD SessionStart commands in hooks.json.
 * Current install keeps the managed SessionStart hook in hooks.json (single
 * representation per layer) and strips stale managed entries before writing
 * exactly one canonical managed command.
 *
 * Bug #1348 (addendum): reconcileCodexHooksJsonEvent must always write the
 * canonical nested { "hooks": { "<Event>": [...] } } shape — never top-level
 * event keys — mirroring reconcileCursorHooksJson.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const installModule = require('../bin/install.js');
const { readInstallState } = require('../gsd-core/bin/lib/installer-migrations.cjs');
const { install, parseTomlToObject, reconcileCodexHooksJsonEvent } = installModule;
const { createTempDir, cleanup } = require('./helpers.cjs');
const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

function withCodexHome(codexHome, fn) {
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return fn();
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

function legacyGsdHook(codexHome) {
  return {
    hooks: [{
      type: 'command',
      command: `node "${path.join(codexHome, 'hooks', 'gsd-check-update.js')}"`,
    }],
  };
}

function userHook() {
  return {
    hooks: [{
      type: 'command',
      command: 'node "/Users/example/bin/user-hook.js"',
    }],
  };
}

function tomlGsdHookCount(codexHome) {
  const parsed = parseTomlToObject(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
  const sessionStart = parsed.hooks?.SessionStart ?? [];
  return sessionStart
    .flatMap((entry) => Array.isArray(entry.hooks) ? entry.hooks : [])
    .filter((hook) => typeof hook.command === 'string' && hook.command.includes('gsd-check-update'))
    .length;
}

describe('#3357 — Codex install removes legacy GSD hooks.json entries', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
    }
    tmpRoot = createTempDir('gsd-3357-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    delete installModule.__codexSchemaValidator;
    cleanup(tmpRoot);
  });

  test('rewrites hooks.json to one managed SessionStart hook when file only had legacy managed entry', () => {
    fs.writeFileSync(
      path.join(codexHome, 'hooks.json'),
      JSON.stringify({ SessionStart: [legacyGsdHook(codexHome)] }, null, 2),
    );

    withCodexHome(codexHome, () => install(true, 'codex'));

    // #1348: output must be nested { hooks: { SessionStart: [...] } }, not top-level
    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    assert.ok(
      hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks),
      'hooks.json must use nested { hooks: { ... } } shape (bug #1348)',
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hooksJson, 'SessionStart'),
      'hooks.json must NOT have a top-level SessionStart key (bug #1348)',
    );
    const commands = hooksJson.hooks.SessionStart.flatMap((entry) => entry.hooks).map((hook) => hook.command);
    const managed = commands.filter((cmd) => typeof cmd === 'string' && cmd.includes('gsd-check-update'));
    assert.equal(managed.length, 1);
    assert.equal(tomlGsdHookCount(codexHome), 0);
  });

  test('preserves user hooks.json entries while removing the legacy GSD hook', () => {
    const userOwnedSameBasenameHook = {
      hooks: [{
        type: 'command',
        command: 'node "/Users/example/bin/gsd-check-update.js"',
      }],
    };
    fs.writeFileSync(
      path.join(codexHome, 'hooks.json'),
      JSON.stringify({ SessionStart: [legacyGsdHook(codexHome), userHook(), userOwnedSameBasenameHook] }, null, 2),
    );

    withCodexHome(codexHome, () => install(true, 'codex'));

    // #1348: output must be nested { hooks: { SessionStart: [...] } }, not top-level
    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    assert.ok(
      hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks),
      'hooks.json must use nested { hooks: { ... } } shape (bug #1348)',
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hooksJson, 'SessionStart'),
      'hooks.json must NOT have a top-level SessionStart key (bug #1348)',
    );
    const commands = hooksJson.hooks.SessionStart.flatMap((entry) => entry.hooks).map((hook) => hook.command);
    const managed = commands.filter((cmd) => typeof cmd === 'string' && cmd.includes('gsd-check-update'));
    assert.equal(commands.includes('node "/Users/example/bin/user-hook.js"'), true);
    assert.equal(commands.includes('node "/Users/example/bin/gsd-check-update.js"'), true);
    assert.equal(managed.length, 2);
    assert.equal(tomlGsdHookCount(codexHome), 0);
  });

  test('restores migrated hooks.json and install state when later Codex validation fails', () => {
    const before = JSON.stringify({ SessionStart: [legacyGsdHook(codexHome)] }, null, 2);
    fs.writeFileSync(path.join(codexHome, 'hooks.json'), before);

    installModule.__codexSchemaValidator = () => ({
      ok: false,
      reason: 'forced migration rollback test',
    });

    assert.throws(
      () => withCodexHome(codexHome, () => install(true, 'codex')),
      /forced migration rollback test/
    );

    assert.equal(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'), before);
    assert.equal(
      readInstallState(codexHome).appliedMigrations.some((entry) => entry.id === '2026-05-11-codex-legacy-hooks-json'),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// #1348 — reconcileCodexHooksJsonEvent must always write canonical nested shape
// ---------------------------------------------------------------------------

describe('#1348 — reconcileCodexHooksJsonEvent canonical nested shape', { concurrency: false }, () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-1348-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // (a) Fresh/absent hooks.json: register → { "hooks": { "SessionStart": [...] } }
  test('(a) fresh/absent hooks.json writes nested { hooks: { SessionStart: [...] } } shape', () => {
    const hooksJsonPath = path.join(tmpDir, 'hooks.json');
    const FAKE_CMD = `"/usr/local/bin/node" "${path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/')}"`;
    assert.ok(!fs.existsSync(hooksJsonPath), 'precondition: hooks.json must not exist');

    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });

    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json must be created');
    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));

    assert.ok(
      hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks),
      `Expected nested { hooks: { ... } } shape; got: ${JSON.stringify(hooksJson)}`,
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hooksJson, 'SessionStart'),
      `hooks.json must NOT have a top-level SessionStart key; got: ${JSON.stringify(hooksJson)}`,
    );
    assert.ok(
      Array.isArray(hooksJson.hooks.SessionStart) && hooksJson.hooks.SessionStart.length > 0,
      `Expected hooks.hooks.SessionStart to be a non-empty array; got: ${JSON.stringify(hooksJson)}`,
    );
  });

  // (b) Legacy migration: seed top-level { "SessionStart": [<user>] }, register →
  //   nested hooks.SessionStart contains BOTH migrated user entry AND managed entry
  test('(b) legacy top-level shape: user entries migrate into hooks.SessionStart alongside managed entry', () => {
    const FAKE_CMD = `"/usr/local/bin/node" "${path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/')}"`;
    const userEntry = { hooks: [{ type: 'command', command: 'node "/Users/alice/my-hook.js"' }] };
    fs.writeFileSync(
      path.join(tmpDir, 'hooks.json'),
      JSON.stringify({ SessionStart: [userEntry] }, null, 2),
    );

    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));

    // Canonical nested shape
    assert.ok(
      hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks),
      `Expected nested { hooks: { ... } } shape; got: ${JSON.stringify(hooksJson)}`,
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hooksJson, 'SessionStart'),
      `hooks.json must NOT have a top-level SessionStart key; got: ${JSON.stringify(hooksJson)}`,
    );

    // User entry was migrated under hooks.SessionStart (not dropped)
    const allCommands = hooksJson.hooks.SessionStart
      .flatMap((e) => Array.isArray(e.hooks) ? e.hooks : [])
      .map((h) => h.command);
    assert.ok(
      allCommands.includes('node "/Users/alice/my-hook.js"'),
      `User entry must be preserved under hooks.SessionStart; commands: ${JSON.stringify(allCommands)}`,
    );

    // Managed entry is also present
    const managedCount = allCommands.filter((c) => typeof c === 'string' && c.includes('gsd-check-update')).length;
    assert.equal(managedCount, 1, 'Exactly one managed entry must be present under hooks.SessionStart');
  });

  // (c-i) Dedup: re-registering the same managed command does not duplicate it
  test('(c-i) re-registering managed command produces exactly one managed entry', () => {
    const FAKE_CMD = `"/usr/local/bin/node" "${path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/')}"`;
    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });
    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));
    const allCommands = hooksJson.hooks.SessionStart
      .flatMap((e) => Array.isArray(e.hooks) ? e.hooks : [])
      .map((h) => h.command);
    const managedCount = allCommands.filter((c) => typeof c === 'string' && c.includes('gsd-check-update')).length;
    assert.equal(managedCount, 1, 'Re-register must yield exactly one managed entry');
  });

  // (c-ii) Removal: user entries remain under hooks, managed entry is gone
  test('(c-ii) removing managed hook leaves user entry under hooks.SessionStart', () => {
    const FAKE_CMD = `"/usr/local/bin/node" "${path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/')}"`;
    const userEntry = { hooks: [{ type: 'command', command: 'node "/Users/alice/my-hook.js"' }] };
    // Seed already-nested file with both user + managed
    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });
    // Now manually seed a user entry into the existing nested file
    const seeded = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));
    seeded.hooks.SessionStart = [userEntry, ...seeded.hooks.SessionStart];
    fs.writeFileSync(path.join(tmpDir, 'hooks.json'), JSON.stringify(seeded, null, 2));

    // Remove managed
    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: null });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));
    // User entry must still be under hooks.SessionStart
    const allCommands = hooksJson.hooks.SessionStart
      .flatMap((e) => Array.isArray(e.hooks) ? e.hooks : [])
      .map((h) => h.command);
    assert.ok(
      allCommands.includes('node "/Users/alice/my-hook.js"'),
      `User entry must remain after managed removal; commands: ${JSON.stringify(allCommands)}`,
    );
    // No managed entry
    const managedCount = allCommands.filter((c) => typeof c === 'string' && c.includes('gsd-check-update')).length;
    assert.equal(managedCount, 0, 'No managed entry must remain after removal');
  });

  // (c-iii) Removal from absent file does NOT materialize { "hooks": {} }
  test('(c-iii) removing from absent hooks.json does not write a spurious empty { "hooks": {} }', () => {
    const hooksJsonPath = path.join(tmpDir, 'hooks.json');
    assert.ok(!fs.existsSync(hooksJsonPath), 'precondition: hooks.json must not exist');

    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: null });

    assert.ok(
      !fs.existsSync(hooksJsonPath),
      'hooks.json must NOT be created when removing from absent file (no spurious { "hooks": {} })',
    );
  });

  // (d) Mixed nested + top-level shape: { "hooks": { "PreToolUse": [...] }, "SessionStart": [...] }
  // The stray top-level event array must be lifted into hooks and merged; no top-level key survives.
  test('(d) mixed nested + top-level shape: stray top-level event array is lifted and merged', () => {
    const FAKE_CMD = `"/usr/local/bin/node" "${path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/')}"`;
    const existingNestedEntry = { hooks: [{ type: 'command', command: 'node "/Users/alice/pre-tool.js"' }] };
    const userTopLevelEntry = { hooks: [{ type: 'command', command: 'node "/Users/alice/session-start.js"' }] };

    // Seed a mixed-shape file: nested PreToolUse AND top-level SessionStart
    fs.writeFileSync(
      path.join(tmpDir, 'hooks.json'),
      JSON.stringify(
        {
          hooks: { PreToolUse: [existingNestedEntry] },
          SessionStart: [userTopLevelEntry],
        },
        null,
        2,
      ),
    );

    reconcileCodexHooksJsonEvent(tmpDir, 'SessionStart', { managedCommand: FAKE_CMD });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));

    // No stray top-level SessionStart key
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hooksJson, 'SessionStart'),
      `hooks.json must NOT have a top-level SessionStart key; got: ${JSON.stringify(hooksJson)}`,
    );

    // hooks.SessionStart contains the migrated user entry AND exactly one managed entry
    assert.ok(
      Array.isArray(hooksJson.hooks.SessionStart),
      `hooks.hooks.SessionStart must be an array; got: ${JSON.stringify(hooksJson)}`,
    );
    const sessionCommands = hooksJson.hooks.SessionStart
      .flatMap((e) => Array.isArray(e.hooks) ? e.hooks : [])
      .map((h) => h.command);
    assert.ok(
      sessionCommands.includes('node "/Users/alice/session-start.js"'),
      `Migrated user entry must be present in hooks.SessionStart; commands: ${JSON.stringify(sessionCommands)}; full: ${JSON.stringify(hooksJson)}`,
    );
    const managedCount = sessionCommands.filter((c) => typeof c === 'string' && c.includes('gsd-check-update')).length;
    assert.equal(managedCount, 1, `Exactly one managed entry must be present in hooks.SessionStart; commands: ${JSON.stringify(sessionCommands)}`);

    // hooks.PreToolUse is untouched
    assert.ok(
      Array.isArray(hooksJson.hooks.PreToolUse) && hooksJson.hooks.PreToolUse.length === 1,
      `hooks.hooks.PreToolUse must be preserved with one entry; got: ${JSON.stringify(hooksJson.hooks.PreToolUse)}`,
    );
    const preToolCommands = hooksJson.hooks.PreToolUse
      .flatMap((e) => Array.isArray(e.hooks) ? e.hooks : [])
      .map((h) => h.command);
    assert.ok(
      preToolCommands.includes('node "/Users/alice/pre-tool.js"'),
      `Existing nested PreToolUse entry must be preserved; commands: ${JSON.stringify(preToolCommands)}`,
    );
  });
});
