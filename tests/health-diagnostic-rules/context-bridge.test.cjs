'use strict';

/**
 * Tests for `src/health-diagnostic-rules/context-bridge.cts` (#6430): W032, the gsd-core Claude Code plugin is enabled
 * but no statusline feeds the context monitor, so context warnings are inactive.
 *
 * The rule reads Claude Code's own settings files, so each case writes real ones: a temp global config dir (selected
 * through CLAUDE_CONFIG_DIR) and a temp project's `.claude/settings.json`. No owner is stubbed.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('../helpers.cjs');
const fc = require('../helpers/fast-check-setup.cjs');
const { SEVERITY, REMEDY_ACTION } = require('../../gsd-core/bin/lib/health-diagnostic-types.cjs');
const { PACKAGE_NAME } = require('../../gsd-core/bin/lib/package-identity.cjs');
const { RULES: RULE_TABLE } = require('../../gsd-core/bin/lib/health-diagnostic.cjs');
const { RULES } = require('../../gsd-core/bin/lib/health-diagnostic-rules/context-bridge.cjs');

const rule = RULES.find((r) => r.code === 'W032');
const PLUGIN = { enabledPlugins: { 'gsd-core@gsd-core': true } };
const NPM_STATUSLINE = { statusLine: { type: 'command', command: 'node "/home/u/.claude/hooks/gsd-statusline.js"' } };

// The env is snapshotted ONCE per test and restored after it, however many fixtures the test builds.
const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'GSD_RUNTIME'];
let savedEnv;
beforeEach(() => { savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])); });
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// A temp global Claude config dir and project, with the given settings written to each, and the env pointing at them.
function setup(t, { global, project, projectLocal, skillsPlugin, runtime = 'claude' }) {
  const home = createTempDir('gsd-6430-home-');
  const cwd = createTempDir('gsd-6430-proj-');
  t.after(() => { cleanup(home); cleanup(cwd); });
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.GSD_RUNTIME = runtime;
  const write = (dir, name, value) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  };
  if (global !== undefined) write(home, 'settings.json', global);
  if (project !== undefined) write(path.join(cwd, '.claude'), 'settings.json', project);
  if (projectLocal !== undefined) write(path.join(cwd, '.claude'), 'settings.local.json', projectLocal);
  if (skillsPlugin !== undefined) write(path.join(home, 'skills', 'gsd-core', '.claude-plugin'), 'plugin.json', skillsPlugin);
  return { cwd };
}

describe('W032 (context warnings inactive on a plugin-only Claude install)', () => {
  test('is registered in the rule table as an advisory, non-repairable warning', () => {
    assert.ok(rule, 'RULES must contain a W032 entry');
    assert.equal(rule.severity, SEVERITY.WARNING);
    assert.equal(rule.repairable, false);
    assert.equal(RULE_TABLE.filter((r) => r.code === 'W032').length, 1, 'W032 appears exactly once in the full table');
  });

  test('a plugin-only install reports it: the plugin is enabled and no statusline is wired', (t) => {
    const { cwd } = setup(t, { global: PLUGIN });
    const diagnostics = rule.check({ cwd });
    assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
    const [d] = diagnostics;
    assert.equal(d.code, 'W032');
    assert.equal(d.severity, SEVERITY.WARNING);
    assert.match(d.message, /Context warnings are inactive/);
    assert.match(d.message, /\/tmp\/claude-ctx-\{session_id\}\.json/);
    assert.match(d.message, /hooks\.workflow_guard/);
    assert.equal(d.remedy.action, REMEDY_ACTION.ADVISE);
    assert.ok(d.remedy.args.command.includes(`npx ${PACKAGE_NAME}@latest --global`), d.remedy.args.command);
    assert.match(d.remedy.args.command, /--force-statusline/);
  });

  test('an npm install (statusline wired, plugin not enabled) reports nothing', (t) => {
    const { cwd } = setup(t, { global: NPM_STATUSLINE });
    assert.deepEqual(rule.check({ cwd }), []);
  });

  test('the plugin enabled alongside the npm statusline reports nothing', (t) => {
    const { cwd } = setup(t, { global: { ...PLUGIN, ...NPM_STATUSLINE } });
    assert.deepEqual(rule.check({ cwd }), []);
  });

  test('a disabled plugin reports nothing', (t) => {
    const { cwd } = setup(t, { global: { enabledPlugins: { 'gsd-core@gsd-core': false } } });
    assert.deepEqual(rule.check({ cwd }), []);
  });

  test("another tool's statusline does not write the bridge, so it still reports", (t) => {
    const { cwd } = setup(t, { global: { ...PLUGIN, statusLine: { type: 'command', command: 'my-own-statusline' } } });
    assert.equal(rule.check({ cwd }).length, 1);
  });

  test('settings are read from the project scopes too: enabling in the project reports, wiring there clears it', (t) => {
    const reported = setup(t, { global: {}, project: PLUGIN });
    assert.equal(rule.check({ cwd: reported.cwd }).length, 1, 'project settings.json enabling the plugin');
    const local = setup(t, { projectLocal: PLUGIN });
    assert.equal(rule.check({ cwd: local.cwd }).length, 1, 'project settings.local.json enabling the plugin');
    const cleared = setup(t, { global: PLUGIN, project: NPM_STATUSLINE });
    assert.deepEqual(rule.check({ cwd: cleared.cwd }), [], 'a statusline wired in the project scope');
  });

  test('another runtime reports nothing even with the plugin settings present', (t) => {
    const { cwd } = setup(t, { global: PLUGIN, runtime: 'codex' });
    assert.deepEqual(rule.check({ cwd }), []);
  });

  test('an unreadable or non-object settings file degrades to no finding and never throws', (t) => {
    for (const bad of ['{ not json', '[]', '"x"', 'null']) {
      const { cwd } = setup(t, { global: bad });
      assert.deepEqual(rule.check({ cwd }), [], `settings.json = ${bad}`);
    }
    const noSettings = setup(t, {});
    assert.deepEqual(rule.check({ cwd: noSettings.cwd }), [], 'no settings file at all');
  });

  test('a later scope overrides an earlier one: a project that disables the plugin clears it, a project statusLine replaces the global one', (t) => {
    const disabled = setup(t, { global: PLUGIN, project: { enabledPlugins: { 'gsd-core@gsd-core': false } } });
    assert.deepEqual(rule.check({ cwd: disabled.cwd }), [], 'project false overrides user true');
    const replaced = setup(t, { global: { ...PLUGIN, ...NPM_STATUSLINE }, project: { statusLine: { type: 'command', command: 'my-own-statusline' } } });
    assert.equal(rule.check({ cwd: replaced.cwd }).length, 1, 'a project statusLine without gsd-statusline replaces the global one');
    const reenabled = setup(t, { global: { enabledPlugins: { 'gsd-core@gsd-core': false } }, projectLocal: PLUGIN });
    assert.equal(rule.check({ cwd: reenabled.cwd }).length, 1, 'local true overrides user false');
  });

  test('the auto-discovered skills-dir plugin (install guide Option B) counts as enabled without an enabledPlugins entry', (t) => {
    const found = setup(t, { skillsPlugin: { name: 'gsd-core', version: '1.0.0' } });
    assert.equal(rule.check({ cwd: found.cwd }).length, 1);
    const wired = setup(t, { global: NPM_STATUSLINE, skillsPlugin: { name: 'gsd-core' } });
    assert.deepEqual(rule.check({ cwd: wired.cwd }), [], 'the statusline wired clears it');
    const other = setup(t, { skillsPlugin: { name: 'some-other-plugin' } });
    assert.deepEqual(rule.check({ cwd: other.cwd }), [], 'a different plugin in skills/ is not gsd-core');
    const garbage = setup(t, { skillsPlugin: '{ not json' });
    assert.deepEqual(rule.check({ cwd: garbage.cwd }), [], 'an unreadable plugin.json is no finding');
  });

  test('[property] only a key that is gsd-core or gsd-core@<marketplace> reports; near-miss keys never do', () => {
    const home = createTempDir('gsd-6430-prop-');
    const cwd = createTempDir('gsd-6430-propcwd-');
    try {
      process.env.CLAUDE_CONFIG_DIR = home;
      process.env.GSD_RUNTIME = 'claude';
      const reports = (key) => {
        fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { [key]: true } }));
        return rule.check({ cwd }).length;
      };
      const marketplace = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,11}$/);
      const affix = fc.stringMatching(/^[a-z]{1,6}$/);
      fc.assert(fc.property(marketplace, (m) => reports(`gsd-core@${m}`) === 1), { numRuns: 25 });
      assert.equal(reports('gsd-core'), 1, 'the bare name');
      fc.assert(fc.property(marketplace, affix, (m, a) => (
        reports(`${a}gsd-core@${m}`) === 0 && reports(`gsd-core${a}@${m}`) === 0 && reports(`gsd-core-${a}@${m}`) === 0 && reports(`${a}-x@${m}`) === 0
      )), { numRuns: 25 });
    } finally {
      cleanup(home);
      cleanup(cwd);
    }
  });
});
