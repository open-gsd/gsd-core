'use strict';

/**
 * Drift guard for blocking PreToolUse guard budgets (#5180, follow-up to
 * #3981 / #4175).
 *
 * Claude Code documents that a timed-out hook does NOT block the tool call, so
 * a blocking guard registered with a small host budget, or one whose own git
 * probe budget is sized to the happy path, silently allows the call it exists
 * to deny. #4175 raised the installer's budget for the blocking guards; this
 * file pins that every other registration surface agrees with the installer
 * (read from the REAL installer output, not a second hand-kept number) and that
 * the guards' internal probe budget x probe count fits inside both the host
 * budget and the test helper's bound.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');
const { STAGED_HOOK_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const {
  BLOCKING_GUARD_PROBE_TIMEOUT_MS,
  BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES,
} = require('../hooks/lib/git-probe.js');

// Blocking guards hooks/hooks.json registers. The installer registers these
// plus gsd-workflow-guard and gsd-validate-commit.
const PLUGIN_BLOCKING_GUARDS = [
  'gsd-prompt-guard',
  'gsd-worktree-path-guard',
  'gsd-write-guard',
  'gsd-secret-read-guard',
  'gsd-agent-isolation-guard',
];
// Advisory hook: negative control (must NOT be raised to the blocking budget).
const ADVISORY_PRETOOL = ['gsd-read-guard'];
const KIMI_BLOCKING_GUARDS = [
  'gsd-prompt-guard',
  'gsd-worktree-path-guard',
  'gsd-write-guard',
  'gsd-secret-read-guard',
  'gsd-workflow-guard',
  'gsd-validate-commit',
];

// node start + fs work + kill/reap observed on a starved Windows runner (~0.46 s).
const OVERHEAD_MS = 500;
// The host budget in seconds the installer registers for blocking guards (#4175).
const HOST_BUDGET_SECONDS = 120;

/** Pure arithmetic under test: do N probes of `budget` ms plus overhead fit under `bound`? */
function fits(probeCount, budget, overhead, bound) {
  return probeCount * budget + overhead < bound;
}

function hookName(command) {
  const m = /gsd-[a-z-]+(?=\.(?:js|sh))/.exec(command || '');
  return m ? m[0] : null;
}

function collect(hooksByEvent) {
  const out = new Map();
  for (const entries of Object.values(hooksByEvent)) {
    for (const entry of entries) {
      for (const h of entry.hooks) {
        const name = hookName(h.command);
        if (name) out.set(name, h.timeout);
      }
    }
  }
  return out;
}

function pluginTimeouts() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  return collect(cfg.hooks);
}

function installerTimeouts(t) {
  const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
  t.after(() => cleanup(root));
  const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
  return collect(settings.hooks);
}

describe('blocking guard host budgets agree with the installer (#5180)', () => {
  test('installer registers the reference blocking guard at the host budget', (t) => {
    const installer = installerTimeouts(t);
    assert.strictEqual(installer.get('gsd-worktree-path-guard'), HOST_BUDGET_SECONDS);
  });

  test('plugin hooks.json registers every blocking guard at exactly the installer budget', (t) => {
    const installer = installerTimeouts(t);
    const budget = installer.get('gsd-worktree-path-guard');
    const plugin = pluginTimeouts();
    for (const name of PLUGIN_BLOCKING_GUARDS) {
      assert.strictEqual(plugin.get(name), HOST_BUDGET_SECONDS,
        `hooks/hooks.json registers ${name} at ${plugin.get(name)}s; expected ${HOST_BUDGET_SECONDS}s ` +
        `(installer uses ${budget}s; a timed-out hook does not block, #3981)`);
      assert.ok(plugin.get(name) >= budget);
    }
  });

  test('negative control: an advisory hook is NOT held to the blocking budget', () => {
    const plugin = pluginTimeouts();
    for (const name of ADVISORY_PRETOOL) {
      assert.ok(plugin.get(name) < HOST_BUDGET_SECONDS,
        `${name} is advisory and must keep its small budget; the discriminator would be vacuous otherwise`);
    }
  });

  test('kimi config.toml registers every blocking guard at exactly the installer budget', (t) => {
    const { root } = runMinimalInstall({ runtime: 'kimi', scope: 'global' });
    t.after(() => cleanup(root));
    const toml = fs.readFileSync(path.join(root, '.kimi', 'config.toml'), 'utf8');
    const seen = new Map();
    for (const block of toml.split('[[hooks]]').slice(1)) {
      const name = hookName((/^command = "(.*)"$/m.exec(block) || [])[1]);
      const timeout = /^timeout = (\d+)$/m.exec(block);
      if (name) seen.set(name, timeout ? Number(timeout[1]) : undefined);
    }
    for (const name of KIMI_BLOCKING_GUARDS) {
      assert.strictEqual(seen.get(name), HOST_BUDGET_SECONDS,
        `kimi config.toml registers ${name} at ${seen.get(name)}s; expected ${HOST_BUDGET_SECONDS}s`);
    }
    assert.ok(seen.get('gsd-read-guard') < HOST_BUDGET_SECONDS, 'negative control: advisory read-guard stays small');
  });
});

describe('guard git-probe budget fits inside the host and test-helper bounds (#5180)', () => {
  const hostBoundMs = HOST_BUDGET_SECONDS * 1000;

  test('exported probe constants are the agreed values', () => {
    assert.strictEqual(BLOCKING_GUARD_PROBE_TIMEOUT_MS, 5000);
    assert.strictEqual(BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES, 3);
  });

  test('worst case fits under the 20 s staged-hook helper bound and the 120 s host budget', () => {
    assert.ok(fits(BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES, BLOCKING_GUARD_PROBE_TIMEOUT_MS, OVERHEAD_MS, STAGED_HOOK_SCRIPT_TIMEOUT_MS));
    assert.ok(fits(BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES, BLOCKING_GUARD_PROBE_TIMEOUT_MS, OVERHEAD_MS, hostBoundMs));
  });

  test('boundary: limit-1 / limit / limit+1 of probeCount * budget + overhead < bound', () => {
    const limit = 3 * 5000 + OVERHEAD_MS;
    assert.strictEqual(fits(3, 5000, OVERHEAD_MS, limit + 1), true, 'limit+1: fits');
    assert.strictEqual(fits(3, 5000, OVERHEAD_MS, limit), false, 'limit: strict < does not fit');
    assert.strictEqual(fits(3, 5000, OVERHEAD_MS, limit - 1), false, 'limit-1: does not fit');
  });

  test('negative control: the pre-fix 10 s QUICK bound could not hold 3 x 5 s probes', () => {
    assert.strictEqual(fits(3, 5000, OVERHEAD_MS, 10000), false);
  });
});
