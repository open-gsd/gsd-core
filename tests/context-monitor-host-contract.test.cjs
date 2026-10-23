/**
 * #4840: the context-monitor hook reads a metrics bridge file that only the
 * statusline hook writes, and the installer wires that statusline writer for
 * Claude Code alone. A host the installer registers the monitor on without a
 * writer gets a hook that fires on every tool event, finds no file, and exits
 * silently — forever, with no way to discover it. The Codex precedent (#2586)
 * is to stop registering the hook there and declare the feature unsupported
 * (`hostBehaviors.unsupportedFeatures: ["context-warnings"]`); this test holds
 * every settings-json / kimi-hooks-toml host to the same contract, against the
 * real installer.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { cleanup, TEST_ENV_BASE } = require('./helpers.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { hostBehaviorsFor } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_SCRIPT = path.join(ROOT, 'bin', 'install.js');

// Every host whose hooks the installer writes into a settings.json or a Kimi config.toml.
const SETTINGS_HOSTS = ['claude', 'antigravity', 'augment', 'codebuddy', 'hermes', 'qwen'];
const KIMI_HOSTS = { kimi: '.kimi', 'kimi-code': '.kimi-code' };

function install(runtime, { home, configDir }) {
  const res = spawnSync(
    process.execPath,
    [INSTALL_SCRIPT, `--${runtime}`, '--global', '--yes', '--no-sdk', '--config-dir', configDir],
    {
      encoding: 'utf-8',
      timeout: INSTALL_TIMEOUT_MS,
      env: { ...process.env, ...TEST_ENV_BASE, HOME: home, USERPROFILE: home, GSD_HOME: home },
    },
  );
  assert.equal(res.status, 0, `${runtime} install failed:\n${res.stdout}\n${res.stderr}`);
}

function hooksReferencing(settings, needle) {
  const found = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(group && group.hooks) ? group.hooks : []) {
        if (h && typeof h.command === 'string' && h.command.includes(needle)) found.push(event);
      }
    }
  }
  return found;
}

// The extended lifecycle events (#772, #2098) route to the same file for the PreCompact reset and the
// SubagentStop envelope handling; only the tool-completion registration emits warnings.
// Hook timeout (seconds) the installer writes for the monitor; a settings.json field, not a subprocess budget.
const MONITOR_HOOK_TIMEOUT_SECONDS = 10;
const LIFECYCLE_EVENTS = new Set(['SubagentStop', 'Stop', 'PreCompact', 'SubagentStart']);

function warningEvents(settings) {
  return hooksReferencing(settings, 'gsd-context-monitor.js').filter((e) => !LIFECYCLE_EVENTS.has(e));
}

function fresh() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4840-home-'));
  return { home, configDir: path.join(home, 'cfg') };
}

describe('#4840: the context monitor is registered only where a metrics writer is installed', () => {
  for (const runtime of SETTINGS_HOSTS) {
    test(`${runtime}: registered monitor implies an installed statusline writer`, (t) => {
      const dirs = fresh();
      t.after(() => cleanup(dirs.home));
      install(runtime, dirs);
      const settings = JSON.parse(fs.readFileSync(path.join(dirs.configDir, 'settings.json'), 'utf-8'));
      const monitorEvents = warningEvents(settings);
      const writerInstalled = !!(settings.statusLine && String(settings.statusLine.command).includes('gsd-statusline.js'));
      if (runtime === 'claude') {
        assert.ok(monitorEvents.includes('PostToolUse'), 'claude has the statusline writer, so the monitor must stay registered on PostToolUse');
      } else {
        assert.deepEqual(monitorEvents, [], `${runtime} has no context metrics writer, so no tool event may register the monitor`);
      }
      if (monitorEvents.length > 0) {
        assert.ok(
          writerInstalled,
          `${runtime} registers gsd-context-monitor.js on ${monitorEvents.join(', ')} but installs no gsd-statusline.js writer, so the hook can never produce a warning`,
        );
      }
    });
  }

  for (const [runtime, dirName] of Object.entries(KIMI_HOSTS)) {
    test(`${runtime}: the monitor is not registered in config.toml (no writer exists for it)`, (t) => {
      const dirs = fresh();
      t.after(() => cleanup(dirs.home));
      install(runtime, dirs);
      const toml = fs.readFileSync(path.join(dirs.home, dirName, 'config.toml'), 'utf-8');
      const postToolUse = toml.split('[[hooks]]').filter((b) => b.includes('event = "PostToolUse"'));
      assert.ok(postToolUse.length > 0, 'sanity: other PostToolUse hooks are still registered');
      assert.ok(postToolUse.every((b) => !b.includes('gsd-context-monitor.js')), `${runtime} config.toml must not register gsd-context-monitor.js on PostToolUse`);
    });
  }

  test('every host without a writer declares context-warnings unsupported; the writer host does not', () => {
    const withoutWriter = ['antigravity', 'augment', 'codebuddy', 'hermes', 'qwen', 'kimi', 'kimi-code', 'codex'];
    for (const runtime of withoutWriter) {
      const unsupported = hostBehaviorsFor(runtime).unsupportedFeatures || [];
      assert.ok(unsupported.includes('context-warnings'), `${runtime} must declare context-warnings unsupported, got ${JSON.stringify(unsupported)}`);
    }
    const claude = hostBehaviorsFor('claude').unsupportedFeatures || [];
    assert.ok(!claude.includes('context-warnings'), 'claude has the statusline writer and must not declare context-warnings unsupported');
  });

  test('a reinstall strips a stale managed monitor registration but keeps a user-authored hook on the same event', (t) => {
    const dirs = fresh();
    t.after(() => cleanup(dirs.home));
    install('qwen', dirs);
    const settingsPath = path.join(dirs.configDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    // What a pre-#4840 install left behind: the managed monitor on PostToolUse, beside a user's own hook.
    settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
    settings.hooks.PostToolUse.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: `node "${path.join(dirs.configDir, 'hooks', 'gsd-context-monitor.js')}"`, timeout: MONITOR_HOOK_TIMEOUT_SECONDS }],
    });
    settings.hooks.PostToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo my-own-hook' }] });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    install('qwen', dirs);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.deepEqual(warningEvents(after), [], 'the stale managed registration must be removed');
    assert.deepEqual(hooksReferencing(after, 'echo my-own-hook'), ['PostToolUse'], 'a user-authored hook must survive');
  });
});
