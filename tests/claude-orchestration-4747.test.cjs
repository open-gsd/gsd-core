'use strict';

/**
 * claude-orchestration-4747.test.cjs — #4747: re-ground the claude-orchestration
 * capability against documented Claude Code Workflow behavior.
 *
 *   B — activation is gated on the documented kill switches
 *       (CLAUDE_CODE_DISABLE_WORKFLOWS, disableWorkflows / enableWorkflows in
 *       managed / project-local / project / user settings), not on an Agent SDK
 *       version. Fail-closed: anything unknown or unreadable resolves to inline.
 *   C — emitWorkflowScript rejects a script that would exceed the documented
 *       runtime caps (4,096 items per parallel() call, 1,000 agents per run).
 *   D — worktree plans hand their metadata back through agent({ schema }), and a
 *       thrown agent is recorded per plan instead of disappearing into null.
 *
 * Sources: code.claude.com/docs/en/workflows, /settings, /managed-settings, and
 * the bundled /workflow-authoring reference.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fc = require('fast-check');

process.env.GSD_TEST_MODE = '1';

const core = require('../gsd-core/bin/lib/claude-orchestration.cjs');
const router = require('../gsd-core/bin/lib/claude-orchestration-command-router.cjs');
const { runGsdTools, createTempDir, createTempProject, cleanup } = require('./helpers.cjs');

const {
  detectWorkflowBackend,
  emitWorkflowScript,
  resolveWaveDispatch,
  resolveWorkflowAvailability,
  DETECT_REASONS,
  WORKFLOW_MAX_ITEMS_PER_CALL,
  WORKFLOW_MAX_AGENTS_PER_RUN,
  WORKTREE_METADATA_SCHEMA,
} = core;
const { readWorkflowSettingsSources, managedSettingsDir } = router;

const ROOT = path.resolve(__dirname, '..');
const HOWTO_PATH = path.join(ROOT, 'docs', 'how-to', 'enable-claude-orchestration-workflow-backend.md');
const CAP_PATH = path.join(ROOT, 'capabilities', 'claude-orchestration', 'capability.json');

const CAPABLE_HOST = { dispatch: { nested: true, background: true } };
const OPEN = { disabled: false, reason: 'workflows_available' };
const ENABLED = { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'auto' };

function detect(overrides) {
  return detectWorkflowBackend(Object.assign({
    runtimeId: 'claude',
    hostIntegration: CAPABLE_HOST,
    config: ENABLED,
    workflowAvailability: OPEN,
  }, overrides || {}));
}

/** Precedence-ordered sources, highest first, every scope absent by default. */
function sources(overrides) {
  const o = overrides || {};
  return ['managed', 'projectLocal', 'project', 'user'].map((scope) => (
    o[scope] ? Object.assign({ scope }, o[scope]) : { scope, status: 'absent' }
  ));
}
const ok = (settings) => ({ status: 'ok', settings });

// ─── B. detectWorkflowBackend ─────────────────────────────────────────────────

describe('#4747 B: detectWorkflowBackend gates on availability, not the SDK version', () => {
  test('B8 every gate open with availability open -> workflow', () => {
    const r = detect();
    assert.deepEqual(r, { available: true, backend: 'workflow', reason: 'workflow_backend_active' });
  });

  test('B9 the Agent SDK version no longer affects detection', () => {
    for (const agentSdkVersion of [undefined, 'garbage', '0.0.1', '0.3.149-rc.1', '99.0.0']) {
      assert.equal(detect({ agentSdkVersion }).backend, 'workflow', String(agentSdkVersion));
    }
  });

  test('B10 the deprecated min_agent_sdk_version key is ignored', () => {
    const config = Object.assign({}, ENABLED, { 'claude_orchestration.min_agent_sdk_version': '99.0.0' });
    assert.equal(detect({ config, agentSdkVersion: '0.0.1' }).backend, 'workflow');
  });

  test('B6 missing or malformed availability fails closed', () => {
    for (const workflowAvailability of [undefined, null, 'x', [], {}, { disabled: 'no' }, { disabled: 1 }]) {
      const r = detect({ workflowAvailability });
      assert.equal(r.backend, 'inline', JSON.stringify(workflowAvailability));
      assert.equal(r.available, false);
      assert.equal(r.reason, 'workflow_availability_unknown', JSON.stringify(workflowAvailability));
    }
  });

  test('B7 a disabled availability surfaces its own reason', () => {
    for (const reason of [
      'workflows_disabled_by_env',
      'workflows_disabled_by_managed_settings',
      'workflows_disabled_by_settings',
      'workflow_settings_unreadable',
    ]) {
      const r = detect({ workflowAvailability: { disabled: true, reason } });
      assert.deepEqual(r, { available: false, backend: 'inline', reason });
    }
  });

  test('B7 a disabled availability with an unrecognized reason still fails closed with a known code', () => {
    const r = detect({ workflowAvailability: { disabled: true, reason: 'made up' } });
    assert.equal(r.backend, 'inline');
    assert.equal(r.reason, 'workflow_availability_unknown');
  });

  test('B1-B5 earlier gates still win over availability', () => {
    const closed = { disabled: true, reason: 'workflows_disabled_by_env' };
    assert.equal(detect({ config: {}, workflowAvailability: closed }).reason, 'capability_disabled');
    assert.equal(detect({ runtimeId: 'codex', workflowAvailability: closed }).reason, 'runtime_not_claude');
    assert.equal(detect({
      config: Object.assign({}, ENABLED, { 'claude_orchestration.execution_backend': 'inline' }),
      workflowAvailability: closed,
    }).reason, 'backend_inline');
    assert.equal(detect({ hostIntegration: { dispatch: { nested: false, background: true } }, workflowAvailability: closed }).reason,
      'workflow_tool_unavailable');
  });

  test('every reason detect returns is in DETECT_REASONS', () => {
    assert.ok(Array.isArray(DETECT_REASONS));
    const seen = new Set([
      detect().reason,
      detect({ config: {} }).reason,
      detect({ runtimeId: 'codex' }).reason,
      detect({ config: Object.assign({}, ENABLED, { 'claude_orchestration.execution_backend': 'inline' }) }).reason,
      detect({ hostIntegration: null }).reason,
      detect({ workflowAvailability: null }).reason,
      detect({ workflowAvailability: { disabled: true, reason: 'workflows_disabled_by_env' } }).reason,
    ]);
    for (const r of seen) assert.ok(DETECT_REASONS.includes(r), r);
  });

  test('property: workflow only when availability is open, never throws, deterministic', () => {
    fc.assert(fc.property(
      fc.record({
        runtimeId: fc.constantFrom('claude', 'codex', 'cursor'),
        backend: fc.constantFrom('auto', 'workflow', 'inline', 'junk'),
        enabled: fc.boolean(),
        availability: fc.oneof(
          fc.constant(undefined),
          fc.constant(null),
          fc.record({ disabled: fc.boolean(), reason: fc.constantFrom(...DETECT_REASONS) }),
          fc.anything(),
        ),
        sdk: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
      }),
      (i) => {
        const input = {
          runtimeId: i.runtimeId,
          hostIntegration: CAPABLE_HOST,
          agentSdkVersion: i.sdk,
          config: { 'claude_orchestration.enabled': i.enabled, 'claude_orchestration.execution_backend': i.backend },
          workflowAvailability: i.availability,
        };
        const a = detectWorkflowBackend(input);
        assert.deepEqual(a, detectWorkflowBackend(input));
        assert.ok(DETECT_REASONS.includes(a.reason), a.reason);
        if (a.backend === 'workflow') {
          assert.equal(i.availability && i.availability.disabled, false);
        }
      },
    ), { seed: 4747, numRuns: 300 });
  });
});

// ─── B. resolveWorkflowAvailability ───────────────────────────────────────────

describe('#4747 B: resolveWorkflowAvailability applies the documented kill switches', () => {
  test('R1/R2 CLAUDE_CODE_DISABLE_WORKFLOWS values that disable', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', ' 1 ', 'on']) {
      const r = resolveWorkflowAvailability({ env: { CLAUDE_CODE_DISABLE_WORKFLOWS: v }, sources: sources() });
      assert.deepEqual(r, { disabled: true, reason: 'workflows_disabled_by_env' }, JSON.stringify(v));
    }
  });

  test('R3 explicit-off and empty env values do not disable', () => {
    for (const v of ['0', 'false', 'FALSE', ' false ', '', '   ', undefined]) {
      const env = v === undefined ? {} : { CLAUDE_CODE_DISABLE_WORKFLOWS: v };
      const r = resolveWorkflowAvailability({ env, sources: sources() });
      assert.deepEqual(r, { disabled: false, reason: 'workflows_available' }, JSON.stringify(v));
    }
  });

  test('R1 env is checked before file reads', () => {
    const r = resolveWorkflowAvailability({
      env: { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' },
      sources: sources({ user: { status: 'unreadable' } }),
    });
    assert.equal(r.reason, 'workflows_disabled_by_env');
  });

  test('R4 an unreadable source in any scope fails closed', () => {
    for (const scope of ['managed', 'projectLocal', 'project', 'user']) {
      const r = resolveWorkflowAvailability({ env: {}, sources: sources({ [scope]: { status: 'unreadable' } }) });
      assert.deepEqual(r, { disabled: true, reason: 'workflow_settings_unreadable' }, scope);
    }
  });

  test('R5 a non-boolean kill-switch value fails closed', () => {
    for (const bad of ['true', 1, 0, null, {}, []]) {
      for (const key of ['disableWorkflows', 'enableWorkflows']) {
        const r = resolveWorkflowAvailability({ env: {}, sources: sources({ user: ok({ [key]: bad }) }) });
        assert.equal(r.reason, 'workflow_settings_unreadable', key + '=' + JSON.stringify(bad));
        assert.equal(r.disabled, true);
      }
    }
  });

  test('R6 managed disableWorkflows:true', () => {
    const r = resolveWorkflowAvailability({ env: {}, sources: sources({ managed: ok({ disableWorkflows: true }) }) });
    assert.deepEqual(r, { disabled: true, reason: 'workflows_disabled_by_managed_settings' });
  });

  test('R7 disableWorkflows:true in each non-managed scope', () => {
    for (const scope of ['projectLocal', 'project', 'user']) {
      const r = resolveWorkflowAvailability({ env: {}, sources: sources({ [scope]: ok({ disableWorkflows: true }) }) });
      assert.deepEqual(r, { disabled: true, reason: 'workflows_disabled_by_settings' }, scope);
    }
  });

  test('R8 the highest scope that sets the key wins', () => {
    const lowerTrue = resolveWorkflowAvailability({
      env: {},
      sources: sources({ projectLocal: ok({ disableWorkflows: false }), user: ok({ disableWorkflows: true }) }),
    });
    assert.equal(lowerTrue.disabled, false, 'project-local false outranks user true');

    const managedTrue = resolveWorkflowAvailability({
      env: {},
      sources: sources({ managed: ok({ disableWorkflows: true }), projectLocal: ok({ disableWorkflows: false }) }),
    });
    assert.equal(managedTrue.reason, 'workflows_disabled_by_managed_settings');
  });

  test('R9 enableWorkflows:false disables (managed and user)', () => {
    assert.deepEqual(
      resolveWorkflowAvailability({ env: {}, sources: sources({ user: ok({ enableWorkflows: false }) }) }),
      { disabled: true, reason: 'workflows_disabled_by_settings' },
    );
    assert.deepEqual(
      resolveWorkflowAvailability({ env: {}, sources: sources({ managed: ok({ enableWorkflows: false }) }) }),
      { disabled: true, reason: 'workflows_disabled_by_managed_settings' },
    );
    assert.equal(
      resolveWorkflowAvailability({
        env: {},
        sources: sources({ project: ok({ enableWorkflows: true }), user: ok({ enableWorkflows: false }) }),
      }).disabled,
      false,
      'project true outranks user false',
    );
  });

  test('R10 enableWorkflows:true is not a disable', () => {
    const r = resolveWorkflowAvailability({ env: {}, sources: sources({ user: ok({ enableWorkflows: true }) }) });
    assert.deepEqual(r, { disabled: false, reason: 'workflows_available' });
  });

  test('R11 nothing set and unrelated keys only -> available', () => {
    assert.deepEqual(resolveWorkflowAvailability({ env: {}, sources: sources() }), { disabled: false, reason: 'workflows_available' });
    const r = resolveWorkflowAvailability({
      env: {},
      sources: sources({ user: ok({ permissions: { allow: ['Workflow'] }, model: 'opus' }) }),
    });
    assert.deepEqual(r, { disabled: false, reason: 'workflows_available' });
  });

  test('R12 malformed resolver input fails closed', () => {
    for (const input of [undefined, null, {}, { env: {} }, { env: {}, sources: 'x' }, { env: {}, sources: [null] }]) {
      const r = resolveWorkflowAvailability(input);
      assert.equal(r.disabled, true, JSON.stringify(input));
      assert.ok(DETECT_REASONS.includes(r.reason), r.reason);
    }
  });

  test('property: matches the documented precedence model for any combination of sources', () => {
    const scopes = ['managed', 'projectLocal', 'project', 'user'];
    const sourceArb = fc.oneof(
      fc.constant({ status: 'absent' }),
      fc.constant({ status: 'unreadable' }),
      fc.record({
        status: fc.constant('ok'),
        settings: fc.record({ disableWorkflows: fc.boolean(), enableWorkflows: fc.boolean() }, { requiredKeys: [] }),
      }),
    );
    const reasonFor = (scope) => (scope === 'managed' ? 'workflows_disabled_by_managed_settings' : 'workflows_disabled_by_settings');
    const has = (s, key) => Object.prototype.hasOwnProperty.call(s.settings, key);
    const oracle = (srcs) => {
      if (srcs.some((s) => s.status === 'unreadable')) return { disabled: true, reason: 'workflow_settings_unreadable' };
      const okSrcs = srcs.filter((s) => s.status === 'ok');
      const dis = okSrcs.find((s) => has(s, 'disableWorkflows'));
      if (dis && dis.settings.disableWorkflows === true) return { disabled: true, reason: reasonFor(dis.scope) };
      const en = okSrcs.find((s) => has(s, 'enableWorkflows'));
      if (en && en.settings.enableWorkflows === false) return { disabled: true, reason: reasonFor(en.scope) };
      return { disabled: false, reason: 'workflows_available' };
    };
    fc.assert(
      fc.property(fc.tuple(sourceArb, sourceArb, sourceArb, sourceArb), (tuple) => {
        const srcs = tuple.map((entry, i) => Object.assign({ scope: scopes[i] }, entry));
        assert.deepEqual(resolveWorkflowAvailability({ env: {}, sources: srcs }), oracle(srcs));
      }),
      { seed: 47471, numRuns: 500 },
    );
  });
});

// ─── B. readWorkflowSettingsSources (router IO seam) ──────────────────────────

describe('#4747 B: readWorkflowSettingsSources reads the documented settings files', () => {
  function layout(t) {
    const root = createTempDir('gsd-4747-settings-');
    t.after(() => cleanup(root));
    const dirs = {
      cwd: path.join(root, 'proj'),
      home: path.join(root, 'home'),
      managed: path.join(root, 'managed'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    return dirs;
  }
  const read = (d, env) => readWorkflowSettingsSources({
    cwd: d.cwd, env: env || {}, platform: 'linux', homedir: d.home, managedDir: d.managed,
  });
  const byScope = (list) => Object.fromEntries(list.map((s) => [s.scope, s]));

  test('S1 missing files are absent, in precedence order', (t) => {
    const d = layout(t);
    const list = read(d);
    assert.deepEqual(list.map((s) => s.scope), ['managed', 'projectLocal', 'project', 'user']);
    for (const s of list) assert.equal(s.status, 'absent', s.scope);
  });

  test('S2/S10 valid files are ok and come from the documented paths', (t) => {
    const d = layout(t);
    fs.mkdirSync(path.join(d.cwd, '.claude'));
    fs.writeFileSync(path.join(d.cwd, '.claude', 'settings.local.json'), JSON.stringify({ disableWorkflows: true }));
    fs.writeFileSync(path.join(d.cwd, '.claude', 'settings.json'), JSON.stringify({ enableWorkflows: true }));
    fs.mkdirSync(path.join(d.home, '.claude'));
    fs.writeFileSync(path.join(d.home, '.claude', 'settings.json'), JSON.stringify({ disableWorkflows: false }));
    fs.writeFileSync(path.join(d.managed, 'managed-settings.json'), JSON.stringify({ enableWorkflows: false }));
    const s = byScope(read(d));
    assert.deepEqual(s.projectLocal, { scope: 'projectLocal', status: 'ok', settings: { disableWorkflows: true } });
    assert.deepEqual(s.project.settings, { enableWorkflows: true });
    assert.deepEqual(s.user.settings, { disableWorkflows: false });
    assert.deepEqual(s.managed.settings, { enableWorkflows: false });
  });

  test('S3 bad files are unreadable', (t) => {
    for (const [label, write] of [
      ['invalid JSON', (p) => fs.writeFileSync(p, '{ not json')],
      ['array root', (p) => fs.writeFileSync(p, '[]')],
      ['number root', (p) => fs.writeFileSync(p, '42')],
      ['null root', (p) => fs.writeFileSync(p, 'null')],
      ['directory in place of the file', (p) => fs.mkdirSync(p)],
    ]) {
      const d = layout(t);
      fs.mkdirSync(path.join(d.home, '.claude'));
      write(path.join(d.home, '.claude', 'settings.json'));
      assert.equal(byScope(read(d)).user.status, 'unreadable', label);
    }
  });

  test('S11 non-regular and oversized settings files are unreadable', (t) => {
    const LIMIT = 1024 * 1024;
    const settingsPath = (d) => path.join(d.home, '.claude', 'settings.json');

    // (i) symlink to a directory is never read
    const d1 = layout(t);
    fs.mkdirSync(path.join(d1.home, '.claude'));
    const target = path.join(d1.home, 'a-dir');
    fs.mkdirSync(target);
    let linked = true;
    try {
      fs.symlinkSync(target, settingsPath(d1), 'dir');
    } catch (e) {
      if (e && e.code === 'EPERM') linked = false; else throw e;
    }
    if (linked) assert.equal(byScope(read(d1)).user.status, 'unreadable', 'symlink to directory');
    else t.skip('symlink unsupported');

    // (ii) one byte over the limit
    const d2 = layout(t);
    fs.mkdirSync(path.join(d2.home, '.claude'));
    fs.writeFileSync(settingsPath(d2), ' '.repeat(LIMIT + 1));
    assert.equal(byScope(read(d2)).user.status, 'unreadable', 'limit+1');

    // (iii) exactly the limit, valid JSON object padded with spaces
    const d3 = layout(t);
    fs.mkdirSync(path.join(d3.home, '.claude'));
    const body = '{"disableWorkflows":false}';
    fs.writeFileSync(settingsPath(d3), body + ' '.repeat(LIMIT - body.length));
    assert.equal(fs.statSync(settingsPath(d3)).size, LIMIT);
    const u = byScope(read(d3)).user;
    assert.equal(u.status, 'ok', 'limit');
    assert.deepEqual(u.settings, { disableWorkflows: false });
  });

  test('S4 managed drop-ins merge alphabetically after the base file', (t) => {
    const d = layout(t);
    fs.writeFileSync(path.join(d.managed, 'managed-settings.json'), JSON.stringify({ disableWorkflows: true, enableWorkflows: true }));
    const dropIns = path.join(d.managed, 'managed-settings.d');
    fs.mkdirSync(dropIns);
    fs.writeFileSync(path.join(dropIns, 'b.json'), JSON.stringify({ disableWorkflows: false }));
    fs.writeFileSync(path.join(dropIns, 'a.json'), JSON.stringify({ disableWorkflows: true, enableWorkflows: false }));
    const m = byScope(read(d)).managed;
    assert.equal(m.status, 'ok');
    assert.equal(m.settings.disableWorkflows, false, 'b.json applies after a.json');
    assert.equal(m.settings.enableWorkflows, false, 'a.json replaces the base value');
  });

  test('S4 drop-ins alone (no base file) still count', (t) => {
    const d = layout(t);
    fs.mkdirSync(path.join(d.managed, 'managed-settings.d'));
    fs.writeFileSync(path.join(d.managed, 'managed-settings.d', '10-org.json'), JSON.stringify({ disableWorkflows: true }));
    const m = byScope(read(d)).managed;
    assert.equal(m.status, 'ok');
    assert.equal(m.settings.disableWorkflows, true);
  });

  test('S5 hidden and non-json drop-ins are ignored', (t) => {
    const d = layout(t);
    const dropIns = path.join(d.managed, 'managed-settings.d');
    fs.mkdirSync(dropIns);
    fs.writeFileSync(path.join(dropIns, '.hidden.json'), JSON.stringify({ disableWorkflows: true }));
    fs.writeFileSync(path.join(dropIns, 'notes.txt'), 'disableWorkflows: true');
    fs.writeFileSync(path.join(dropIns, 'broken.json.bak'), '{');
    assert.equal(byScope(read(d)).managed.status, 'absent');
  });

  test('S6 a missing drop-in directory leaves the base file alone', (t) => {
    const d = layout(t);
    fs.writeFileSync(path.join(d.managed, 'managed-settings.json'), JSON.stringify({ disableWorkflows: true }));
    assert.deepEqual(byScope(read(d)).managed.settings, { disableWorkflows: true });
  });

  test('S7 one unreadable drop-in makes managed unreadable', (t) => {
    const d = layout(t);
    fs.writeFileSync(path.join(d.managed, 'managed-settings.json'), JSON.stringify({}));
    fs.mkdirSync(path.join(d.managed, 'managed-settings.d'));
    fs.writeFileSync(path.join(d.managed, 'managed-settings.d', 'a.json'), '{');
    assert.equal(byScope(read(d)).managed.status, 'unreadable');
  });

  test('S8 CLAUDE_CONFIG_DIR relocates the user settings file', (t) => {
    const d = layout(t);
    const custom = path.join(d.home, 'custom-claude');
    fs.mkdirSync(custom);
    fs.writeFileSync(path.join(custom, 'settings.json'), JSON.stringify({ disableWorkflows: true }));
    fs.mkdirSync(path.join(d.home, '.claude'));
    fs.writeFileSync(path.join(d.home, '.claude', 'settings.json'), JSON.stringify({ disableWorkflows: false }));
    assert.equal(byScope(read(d, { CLAUDE_CONFIG_DIR: custom })).user.settings.disableWorkflows, true);
    assert.equal(byScope(read(d, {})).user.settings.disableWorkflows, false);
  });

  test('S9 managed settings directory per platform', () => {
    assert.equal(managedSettingsDir('darwin'), '/Library/Application Support/ClaudeCode');
    assert.equal(managedSettingsDir('linux'), '/etc/claude-code');
    assert.equal(managedSettingsDir('win32'), 'C:\\Program Files\\ClaudeCode');
    assert.equal(managedSettingsDir('freebsd'), '/etc/claude-code');
  });
});

// ─── B. CLI wiring ────────────────────────────────────────────────────────────

describe('#4747 B: the CLI applies the kill switches end to end', () => {
  function project(t, extraConfig) {
    const dir = createTempProject('gsd-4747-cli-');
    const home = createTempDir('gsd-4747-home-');
    const managed = createTempDir('gsd-4747-managed-');
    t.after(() => { cleanup(dir); cleanup(home); cleanup(managed); });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(Object.assign({
      claude_orchestration: { enabled: true },
    }, extraConfig || {})));
    // Isolate the user scope from the machine running the test.
    const env = { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), HOME: home, USERPROFILE: home, CLAUDE_CODE_DISABLE_WORKFLOWS: '', GSD_TEST_MANAGED_SETTINGS_DIR: managed, GSD_TEST_MODE: '1' };
    fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
    return { dir, env, managed };
  }
  function detectCli(p, envExtra, args) {
    const res = runGsdTools(['claude-orchestration', 'detect-backend', '--raw', ...(args || [])], p.dir, Object.assign({}, p.env, envExtra || {}));
    assert.equal(res.success, true, res.error);
    return JSON.parse(res.output);
  }

  test('user settings disableWorkflows:true -> inline workflows_disabled_by_settings', (t) => {
    const p = project(t);
    fs.writeFileSync(path.join(p.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ disableWorkflows: true }));
    assert.deepEqual(detectCli(p), { available: false, backend: 'inline', reason: 'workflows_disabled_by_settings' });
  });

  test('CLAUDE_CODE_DISABLE_WORKFLOWS=1 -> inline workflows_disabled_by_env', (t) => {
    const p = project(t);
    assert.equal(detectCli(p, { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' }).reason, 'workflows_disabled_by_env');
  });

  test('project-local settings disable -> inline', (t) => {
    const p = project(t);
    fs.mkdirSync(path.join(p.dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(p.dir, '.claude', 'settings.local.json'), JSON.stringify({ enableWorkflows: false }));
    assert.equal(detectCli(p).reason, 'workflows_disabled_by_settings');
  });

  test('the CLI ignores the host managed settings directory under the test seam and reads the injected one', (t) => {
    const p = project(t);
    fs.writeFileSync(path.join(p.managed, 'managed-settings.json'), JSON.stringify({ disableWorkflows: true }));
    assert.equal(detectCli(p).reason, 'workflows_disabled_by_managed_settings');
  });

  test('the deprecated --agent-sdk-version flag is ignored', (t) => {
    const p = project(t);
    const r = detectCli(p, {}, ['--agent-sdk-version', '0.0.1']);
    assert.ok(!/sdk/i.test(r.reason), `reason must not be an SDK gate: ${r.reason}`);
  });
});

// ─── C. runtime caps ──────────────────────────────────────────────────────────

/** `n` non-overlapping plans in one wave (one parallel() stage). */
function wideWave(n, prefix) {
  const plans = [];
  for (let i = 0; i < n; i++) plans.push({ id: (prefix || 'p') + i, brief: 'b', files_modified: ['f' + (prefix || '') + i] });
  return plans;
}

/** `total` plans spread over waves of at most 100 plans each. */
function spreadWaves(total) {
  const waves = [];
  for (let w = 0; total > 0; w++) {
    const n = Math.min(100, total);
    waves.push({ id: 'w' + w, plans: wideWave(n, 'w' + w + 'p') });
    total -= n;
  }
  return waves;
}

describe('#4747 C: emitWorkflowScript enforces the documented runtime caps', () => {
  const base = { phaseDir: '.planning/phases/01', runId: 'run-4747' };

  test('caps are the documented values', () => {
    assert.equal(WORKFLOW_MAX_ITEMS_PER_CALL, 4096);
    assert.equal(WORKFLOW_MAX_AGENTS_PER_RUN, 1000);
  });

  test('C1 a stage of 4,097 plans is rejected naming the per-call cap and the wave', () => {
    const r = emitWorkflowScript(Object.assign({}, base, { waves: [{ id: 'big', plans: wideWave(4097) }] }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /4096/);
    assert.match(r.reason, /parallel\(\)/);
    assert.match(r.reason, /big/);
  });

  test('C2 stages of 4,096 and 4,095 pass the per-call cap (the total cap rejects them)', () => {
    for (const n of [4096, 4095]) {
      const r = emitWorkflowScript(Object.assign({}, base, { waves: [{ id: 'big', plans: wideWave(n) }] }));
      assert.equal(r.ok, false, String(n));
      assert.match(r.reason, /1000 agents per run/, String(n));
      assert.doesNotMatch(r.reason, /parallel\(\)/, String(n));
    }
  });

  test('C3-C5 total agents per run: 999 and 1,000 pass, 1,001 is rejected', () => {
    for (const [n, expectOk] of [[999, true], [1000, true], [1001, false]]) {
      const r = emitWorkflowScript(Object.assign({}, base, { waves: spreadWaves(n) }));
      assert.equal(r.ok, expectOk, `${n}: ${r.reason || ''}`);
      if (expectOk) assert.equal(r.summary.plans, n);
      else assert.match(r.reason, /1000 agents per run/);
    }
  });

  test('C6 resolveWaveDispatch maps a cap breach to inline with the reason', () => {
    const r = resolveWaveDispatch(Object.assign({}, base, {
      runtimeId: 'claude', hostIntegration: CAPABLE_HOST, config: ENABLED, workflowAvailability: OPEN,
      waves: spreadWaves(1001),
    }));
    assert.equal(r.backend, 'inline');
    assert.match(r.reason, /^emit_failed: .*1000/);
  });
});

// ─── D. structured metadata hand-back ─────────────────────────────────────────

const ASYNC_FUNCTION = Object.getPrototypeOf(async function () {}).constructor;

/**
 * Run an emitted script in a stub runtime that follows the documented contract
 * (bundled /workflow-authoring reference): parallel() takes thunks and never
 * rejects — a throwing thunk resolves to null; agent() with a schema returns
 * the validated object.
 */
async function run(script, agentStub) {
  const body = script.replace(/^export /m, '');
  const harness = [
    'const phase = () => {};',
    'const parallel = async (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));',
    'const agent = async (brief, opts) => agentStub(brief, opts);',
    body,
  ].join('\n');
  return new ASYNC_FUNCTION('agentStub', harness)(agentStub);
}

const META = { agent_id: 'a1', worktree_path: '/wt/a1', branch: 'worktree-wf-a1', expected_base: 'abc123' };

function twoPlanWave(secondUsesWorktree) {
  return {
    phaseDir: '.planning/phases/01',
    runId: 'run-4747',
    waves: [{
      id: 'w1',
      plans: [
        { id: 'p1', brief: 'one', files_modified: ['a'] },
        Object.assign({ id: 'p2', brief: 'two', files_modified: ['b'] }, secondUsesWorktree === false ? { use_worktree: false } : {}),
      ],
    }],
  };
}

describe('#4747 D: worktree metadata comes back through agent({ schema })', () => {
  test('D8 the schema satisfies the documented contract', () => {
    const s = WORKTREE_METADATA_SCHEMA;
    assert.equal(s.type, 'object');
    const keys = ['agent_id', 'worktree_path', 'branch', 'expected_base'];
    assert.deepEqual(Object.keys(s.properties).sort(), [...keys].sort());
    assert.deepEqual([...s.required].sort(), [...keys].sort());
    for (const k of s.required) assert.ok(k in s.properties, k);
    for (const k of keys) assert.deepEqual(s.properties[k], { type: 'string', minLength: 1 }, k);
  });

  test('D7/D6 worktree agents receive the schema; non-worktree agents do not', async () => {
    const seen = {};
    const r = emitWorkflowScript(twoPlanWave(false));
    assert.equal(r.ok, true);
    await run(r.script, (brief, opts) => { seen[brief] = opts; return brief === 'one' ? META : 'prose'; });
    assert.deepEqual(seen.one.schema, WORKTREE_METADATA_SCHEMA);
    assert.equal(seen.one.isolation, 'worktree');
    assert.equal(seen.one.agentType, 'gsd-executor');
    assert.equal('schema' in seen.two, false);
  });

  test('D1 a valid object becomes metadata with exactly the four fields', async () => {
    const r = emitWorkflowScript(twoPlanWave());
    const ret = await run(r.script, () => Object.assign({ extra: 'dropped' }, META));
    assert.deepEqual(ret[0], { plan: 'p1', expects_worktree: true, metadata: META, error: null });
    assert.deepEqual(ret[1].metadata, META);
  });

  test('D2/D3/D5 incomplete, null, and prose results give null metadata', async () => {
    const cases = [
      ['missing field', { agent_id: 'a', worktree_path: '/w', branch: 'b' }],
      ['empty string field', Object.assign({}, META, { branch: '' })],
      ['non-string field', Object.assign({}, META, { expected_base: 7 })],
      ['agent resolved null', null],
      ['prose with an old block', '<worktree_metadata>' + JSON.stringify(META) + '</worktree_metadata>'],
      ['array', [META]],
    ];
    for (const [label, result] of cases) {
      const r = emitWorkflowScript(twoPlanWave());
      const ret = await run(r.script, () => result);
      assert.equal(ret[0].metadata, null, label);
      assert.equal(ret[0].error, null, label);
      assert.equal(ret[0].expects_worktree, true, label);
    }
  });

  test('D4 a thrown agent is recorded with its error and siblings still complete', async () => {
    const r = emitWorkflowScript(twoPlanWave());
    const ret = await run(r.script, (brief) => {
      if (brief === 'one') throw new Error('structured output failed validation after 5 attempts');
      return META;
    });
    assert.equal(ret.length, 2);
    assert.equal(ret[0].metadata, null);
    assert.match(ret[0].error, /failed validation after 5 attempts/);
    assert.deepEqual(ret[1].metadata, META);
    assert.equal(ret[1].error, null);
  });

  test('D4 a thrown non-Error value is recorded as text', async () => {
    const r = emitWorkflowScript(twoPlanWave());
    const ret = await run(r.script, (brief) => { if (brief === 'one') throw 'budget exhausted'; return META; });
    assert.equal(ret[0].error, 'budget exhausted');
  });

  test('D6 a non-worktree plan reports expects_worktree:false and null metadata', async () => {
    const r = emitWorkflowScript(twoPlanWave(false));
    const ret = await run(r.script, () => META);
    assert.deepEqual(ret[1], { plan: 'p2', expects_worktree: false, metadata: null, error: null });
  });
});

// ─── Docs / declaration parity ────────────────────────────────────────────────

describe('#4747: docs and declaration stay in step with the code', () => {
  test('the how-to lists exactly the detect reason codes', () => {
    const md = fs.readFileSync(HOWTO_PATH, 'utf8').replace(/\r\n/g, '\n');
    const start = md.indexOf('\n### Detection reason codes\n');
    assert.ok(start !== -1, 'how-to must have a "### Detection reason codes" section');
    const rest = md.slice(start + 1);
    const restLines = rest.split(String.fromCharCode(10));
    const endIdx = restLines.findIndex((line, i) => i > 0 && /^#{2,3} /.test(line));
    const section = (endIdx === -1 ? restLines : restLines.slice(0, endIdx)).join(String.fromCharCode(10));
    const codes = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    assert.deepEqual([...codes].sort(), [...DETECT_REASONS].sort());
  });

  test('min_agent_sdk_version stays declared and is marked deprecated and ignored', () => {
    const cap = JSON.parse(fs.readFileSync(CAP_PATH, 'utf8'));
    const entry = cap.config['claude_orchestration.min_agent_sdk_version'];
    assert.ok(entry, 'the key stays declared so existing configs still load');
    assert.match(entry.description, /deprecated/i);
    assert.match(entry.description, /ignored/i);
  });
});
