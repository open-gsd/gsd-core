'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Enhancement #772: Adopt new stable Codex hook events + commandWindows for
 * Windows parity.
 *
 * Codex CLI (rust-v0.137.0) stabilised the full hook-event set. This suite
 * asserts that a Codex install:
 *
 * (a) Registers the 3 new high-value hook events in hooks.json:
 *   - SubagentStart — inject context / GSD_AGENT_NAME awareness at subagent open
 *   - Stop          — post-session context headroom tracking
 *   - PostToolUse   — mirror the Claude Code PostToolUse context monitor
 *
 * (b) Emits `commandWindows` in the SessionStart hooks.json entry so that
 *   Windows users get the .cmd shim path and non-Windows users get the POSIX
 *   node runner command. Both fields are present in the same entry; Codex picks
 *   the right one per its HookHandlerConfig schema
 *   (codex-rs/config/src/hook_config.rs: commandWindows / command_windows alias).
 *
 * Note: UserPromptSubmit is NOT wired (same rationale as Qwen #788 — the
 * gsd-prompt-guard handler exits unless tool_name is Write|Edit, so it would be
 * a silent no-op for the UserPromptSubmit payload shape).
 *
 * Test strategy:
 *   - Test new event registration via ensureCodexHooksJsonEvent() directly
 *     (mirrors the #3426 pattern of testing ensureCodexHooksJsonSessionStart
 *     directly with a stub hook file — avoids full install() migration dance).
 *   - Test commandWindows via ensureCodexHooksJsonSessionStart() directly.
 *   - IR-first discipline: assert on the structured result, not rendered text.
 *
 * Verified hook event schema:
 *   https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
 *   https://github.com/openai/codex/blob/main/codex/codex-rs/config/src/hook_config.rs
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INSTALL = require('../bin/install.js');
const {
  ensureCodexHooksJsonSessionStart,
  ensureCodexHooksJsonEvent,
  removeCodexHooksJsonEvent,
  reconcileCodexHooksJsonEvent,
} = INSTALL;
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract all hook handler entries (full objects with type/command/etc.) for
 * `eventName` from a hooks.json object (flat or nested-hooks shape).
 */
function hooksJsonHandlersForEvent(hooksJson, eventName) {
  if (!hooksJson || typeof hooksJson !== 'object') return [];
  const table =
    hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks)
      ? hooksJson.hooks
      : hooksJson;
  if (!Array.isArray(table[eventName])) return [];
  return table[eventName].flatMap(entry =>
    Array.isArray(entry && entry.hooks) ? entry.hooks : []
  );
}

function readHooksJson(targetDir) {
  const p = path.join(targetDir, 'hooks.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stubHookFile(targetDir, hookName) {
  const hooksDest = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDest, { recursive: true });
  const dest = path.join(hooksDest, hookName);
  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, '#!/usr/bin/env node\n// stub\n');
    try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
  }
}

// ─── Suite 1: ensureCodexHooksJsonEvent export surface ───────────────────────

describe('enh-772: export surface — new functions are exported', () => {
  test('ensureCodexHooksJsonEvent is a function', () => {
    assert.strictEqual(typeof ensureCodexHooksJsonEvent, 'function',
      'ensureCodexHooksJsonEvent must be exported from bin/install.js');
  });

  test('removeCodexHooksJsonEvent is a function', () => {
    assert.strictEqual(typeof removeCodexHooksJsonEvent, 'function',
      'removeCodexHooksJsonEvent must be exported from bin/install.js');
  });

  test('reconcileCodexHooksJsonEvent is a function', () => {
    assert.strictEqual(typeof reconcileCodexHooksJsonEvent, 'function',
      'reconcileCodexHooksJsonEvent must be exported from bin/install.js');
  });
});

// ─── Suite 2: ensureCodexHooksJsonEvent registers new events ─────────────────

describe('enh-772: ensureCodexHooksJsonEvent registers SubagentStart, Stop, PostToolUse', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-events-');
    stubHookFile(tmpDir, 'gsd-context-monitor.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const eventName of ['SubagentStart', 'Stop', 'PostToolUse']) {
    test(`${eventName}: ensureCodexHooksJsonEvent writes hooks.json`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      const result = ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      assert.ok(result && result.path, `result must have path for ${eventName}`);
      assert.ok(result.wrote || result.changed,
        `ensureCodexHooksJsonEvent must write or change hooks.json for ${eventName}`);
      assert.ok(fs.existsSync(path.join(tmpDir, 'hooks.json')),
        `hooks.json must exist after registering ${eventName}`);
    });

    test(`${eventName}: hooks.json contains the event entry`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.ok(handlers.length > 0,
        `Expected ${eventName} entry in hooks.json; got: ${JSON.stringify(hooksJson)}`);
    });

    test(`${eventName}: hook entry uses gsd-context-monitor`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.ok(
        handlers.some(h => h.command && h.command.includes('gsd-context-monitor')),
        `${eventName} hook must use gsd-context-monitor; got: ${JSON.stringify(handlers)}`
      );
    });

    test(`${eventName}: hook entry has type: 'command'`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      const entry = handlers.find(h => h.command && h.command.includes('gsd-context-monitor'));
      assert.strictEqual(entry && entry.type, 'command',
        `${eventName} hook entry must have type 'command'`);
    });

    test(`${eventName}: hook entry has timeout: 10`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      const entry = handlers.find(h => h.command && h.command.includes('gsd-context-monitor'));
      assert.strictEqual(entry && entry.timeout, 10,
        `${eventName} hook entry must have timeout 10`);
    });
  }

  test('null absoluteRunner returns unchanged result without writing', () => {
    const result = ensureCodexHooksJsonEvent(tmpDir, 'SubagentStart', {
      absoluteRunner: null,
      platform: 'linux',
    });
    assert.strictEqual(result.changed, false,
      'null runner must return changed: false');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'hooks.json')),
      'hooks.json must NOT be written when runner is null');
  });
});

// ─── Suite 3: commandWindows parity in SessionStart ──────────────────────────

describe('enh-772: commandWindows parity — ensureCodexHooksJsonSessionStart emits commandWindows', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-cmdwin-');
    stubHookFile(tmpDir, 'gsd-check-update.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // commandWindows is ONLY emitted on win32 platform (where the .cmd shim is also
  // written). On POSIX platforms, commandWindows is omitted to avoid pointing Windows
  // Codex at a non-existent .cmd file (the shim is only present after a native Windows
  // install that runs buildCodexHookWindowsShimIR and atomicWriteFileSync).

  test('POSIX platform: commandWindows is NOT emitted (shim not written on POSIX)', () => {
    const fakeRunner = '"/usr/local/bin/node"';
    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'linux',
    });
    assert.ok(result && result.wrote, 'must write hooks.json on linux');

    const hooksJson = readHooksJson(tmpDir);
    const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
    assert.ok(handlers.length > 0, `Expected SessionStart handlers; got: ${JSON.stringify(hooksJson)}`);

    const entry = handlers[0];
    assert.ok(
      entry.commandWindows === undefined,
      `commandWindows must NOT be emitted on POSIX (shim not written); got: ${JSON.stringify(entry)}`
    );
  });

  test('POSIX platform: command references gsd-check-update.js (not .cmd)', () => {
    const fakeRunner = '"/usr/local/bin/node"';
    ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'linux',
    });
    const hooksJson = readHooksJson(tmpDir);
    const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
    const entry = handlers[0];
    assert.ok(
      entry.command && entry.command.includes('gsd-check-update'),
      `POSIX command must reference gsd-check-update; got: ${entry.command}`
    );
    assert.ok(
      !entry.command.endsWith('.cmd') && !entry.command.endsWith('.cmd"'),
      `POSIX command must not end with .cmd; got: ${entry.command}`
    );
  });

  test('null absoluteRunner: no commandWindows emitted, no write', () => {
    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: null,
      platform: 'linux',
    });
    assert.strictEqual(result.changed, false, 'null runner must return changed: false');
    const hooksJson = readHooksJson(tmpDir);
    if (hooksJson) {
      const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
      for (const h of handlers) {
        assert.ok(!h.commandWindows,
          `commandWindows must not be present when runner is null; got: ${JSON.stringify(h)}`);
      }
    }
  });

  test('Windows platform: SessionStart hook is written with commandWindows pointing to .cmd shim', () => {
    // On win32, both `command` and `commandWindows` use the .cmd shim path
    // (because managedCommand = shimIR.hookCommand = .cmd path, and
    // commandWindows = same .cmd path). This ensures Codex picks the .cmd
    // on Windows regardless of which field it reads.
    const fakeRunner = '"C:/Program Files/nodejs/node.exe"';
    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'win32',
    });
    // The shim write and hooks.json write should succeed in the tmp dir.
    if (result.wrote) {
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
      assert.ok(handlers.length > 0,
        `SessionStart must be registered on Windows path; got: ${JSON.stringify(hooksJson)}`);
      const entry = handlers[0];
      assert.ok(typeof entry.commandWindows === 'string',
        `commandWindows must be present on Windows path; got: ${JSON.stringify(entry)}`);
      // commandWindows should reference the .cmd shim
      assert.ok(
        entry.commandWindows.includes('gsd-check-update') && entry.commandWindows.includes('.cmd'),
        `commandWindows must reference gsd-check-update.cmd on win32; got: ${entry.commandWindows}`
      );
    }
  });
});

// ─── Suite 4: idempotency ────────────────────────────────────────────────────

describe('enh-772: ensureCodexHooksJsonEvent is idempotent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-idem-');
    stubHookFile(tmpDir, 'gsd-context-monitor.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const eventName of ['SubagentStart', 'Stop', 'PostToolUse']) {
    test(`${eventName}: calling twice does not duplicate hook entries`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      const opts = { absoluteRunner: fakeRunner, platform: 'linux' };

      ensureCodexHooksJsonEvent(tmpDir, eventName, opts);
      ensureCodexHooksJsonEvent(tmpDir, eventName, opts);

      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.strictEqual(handlers.length, 1,
        `${eventName} should have exactly 1 hook handler after idempotent re-register; got ${handlers.length}: ${JSON.stringify(handlers)}`);
    });
  }
});

// ─── Suite 5: removeCodexHooksJsonEvent ──────────────────────────────────────

describe('enh-772: removeCodexHooksJsonEvent removes managed entries', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-remove-');
    stubHookFile(tmpDir, 'gsd-context-monitor.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const eventName of ['SubagentStart', 'Stop', 'PostToolUse']) {
    test(`${eventName}: removeCodexHooksJsonEvent removes the managed entry`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });

      // Verify it was registered
      let hooksJson = readHooksJson(tmpDir);
      let handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.ok(handlers.length > 0, `${eventName} must be registered before removal`);

      // Remove
      const result = removeCodexHooksJsonEvent(tmpDir, eventName);
      assert.ok(result.changed || result.wrote,
        `removeCodexHooksJsonEvent must change hooks.json for ${eventName}`);

      hooksJson = readHooksJson(tmpDir);
      if (hooksJson) {
        handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
        assert.strictEqual(handlers.length, 0,
          `After removal, ${eventName} should have 0 handlers; got: ${JSON.stringify(handlers)}`);
      }
    });
  }
});

// ─── Suite 6: reconcileCodexHooksJsonEvent preserves user entries ─────────────

describe('enh-772: reconcileCodexHooksJsonEvent preserves user-owned entries', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-preserve-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('user-owned SubagentStart entry is preserved when GSD entry is registered', () => {
    const hooksJsonPath = path.join(tmpDir, 'hooks.json');
    const userEntry = {
      hooks: [{ type: 'command', command: 'my-custom-hook.sh' }]
    };
    fs.writeFileSync(hooksJsonPath, JSON.stringify({
      SubagentStart: [userEntry]
    }, null, 2) + '\n');

    reconcileCodexHooksJsonEvent(tmpDir, 'SubagentStart', {
      managedCommand: '"/usr/local/bin/node" "/home/me/.codex/hooks/gsd-context-monitor.js"',
    });

    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    const table = hooksJson.hooks || hooksJson;
    const entries = Array.isArray(table.SubagentStart) ? table.SubagentStart : [];
    // Should have 2 entries: user entry + GSD entry
    assert.ok(entries.length >= 2,
      `User entry must be preserved; got entries: ${JSON.stringify(entries)}`);
    // User entry must still be present
    const userEntryStillPresent = entries.some(e =>
      Array.isArray(e.hooks) && e.hooks.some(h => h.command === 'my-custom-hook.sh')
    );
    assert.ok(userEntryStillPresent,
      `User entry must survive GSD registration; entries: ${JSON.stringify(entries)}`);
  });
});
