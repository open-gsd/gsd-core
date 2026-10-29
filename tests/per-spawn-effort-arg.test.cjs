/**
 * #5330 — per-spawn effort argument.
 *
 * A runtime descriptor may declare `runtime.spawnEffortParam` (claude: `effort`).
 * `resolveEffortArgInternal` renders `<param>="<effort>"` from the resolved effort
 * cascade for a host that declares one, and `''` for every other host. Init
 * payloads carry it as `<role>_effort_arg` beside `<role>_model`, `resolve-model`
 * as `effort_arg`, and workflows substitute it as `{<role>_effort_arg}` in the
 * spawn call; the agent's installed `effort:` frontmatter stays the fallback.
 *
 * Interim gate (until #4633's single config resolver): the argument is emitted
 * only when the loaded config carries an `effort` block, because under a project
 * config the loader drops ~/.gsd/defaults.json while the installer bakes it into
 * the frontmatter.
 *
 * Isolation follows tests/model-resolver.test.cjs § "#492 manifest effort
 * fallback": a per-test GSD_HOME holding its own defaults.json, and GSD_RUNTIME
 * set per test so the per-install runtime marker never decides the host.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib');
const {
  resolveEffortArgInternal,
  resolveEffortInternal,
  VALID_EFFORTS,
} = require(path.join(LIB, 'model-resolver.cjs'));
const { spawnEffortParamFor } = require(path.join(LIB, 'runtime-name-policy.cjs'));
const { validateRuntimeBody } = require(path.join(LIB, 'capability-validator.cjs'));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A GSD_HOME whose defaults.json carries `effort` (or no defaults.json at all). */
function gsdHome(effort) {
  const home = tmpDir('gsd-home-');
  if (effort !== undefined) {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({ effort }));
  }
  return home;
}

/** A project dir; `config` undefined → bare dir with no .planning/ at all. */
function project(config) {
  const dir = tmpDir('gsd-test-');
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config));
  }
  return dir;
}

/** Point the resolver at `home` and `runtime` for one test, restoring both after. */
function useEnv(t, { home, runtime }) {
  const saved = { GSD_HOME: process.env.GSD_HOME, GSD_RUNTIME: process.env.GSD_RUNTIME };
  process.env.GSD_HOME = home;
  process.env.GSD_RUNTIME = runtime;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const MAPPER = 'gsd-codebase-mapper';
const GLOBAL_OVERRIDE = { agent_overrides: { [MAPPER]: 'max' } };

describe('#5330 resolveEffortArgInternal — the interim gate', () => {
  test('project config without an effort block: no argument, so the baked frontmatter holds', (t) => {
    const home = gsdHome(GLOBAL_OVERRIDE);
    const dir = project({ model_profile: 'balanced' });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    // The reason for the gate: the runtime cascade has dropped defaults.json here,
    // so it disagrees with the `max` the installer bakes from that same file.
    assert.notEqual(resolveEffortInternal(dir, MAPPER), 'max');
    assert.equal(resolveEffortArgInternal(dir, MAPPER), '');
  });

  test('project config with its own effort block: the argument carries the resolved cascade', (t) => {
    const home = gsdHome(GLOBAL_OVERRIDE);
    const dir = project({ effort: { agent_overrides: { [MAPPER]: 'xhigh' } } });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), 'effort="xhigh"');
  });

  test('a project effort block without an entry for the agent still passes the cascade result', (t) => {
    const home = gsdHome();
    const dir = project({ effort: { default: 'medium' } });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), `effort="${resolveEffortInternal(dir, MAPPER)}"`);
  });

  test('no project config: defaults.json is the loaded config, so its effort is passed', (t) => {
    const home = gsdHome(GLOBAL_OVERRIDE);
    const dir = project();
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), 'effort="max"');
  });

  test('no config anywhere: no argument', (t) => {
    const home = gsdHome();
    const dir = project();
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), '');
  });

  test('effort: null in the project config is no block', (t) => {
    const home = gsdHome(GLOBAL_OVERRIDE);
    const dir = project({ effort: null });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), '');
  });
});

describe('#5330 resolveEffortArgInternal — descriptor-driven, never host-coded', () => {
  for (const runtime of ['codex', 'opencode', 'cursor', 'not-a-runtime']) {
    test(`${runtime}: no argument even when the project sets effort`, (t) => {
      const home = gsdHome();
      const dir = project({ effort: { agent_overrides: { [MAPPER]: 'xhigh' } } });
      useEnv(t, { home, runtime });
      t.after(() => { cleanup(dir); cleanup(home); });

      assert.equal(resolveEffortArgInternal(dir, MAPPER), '');
    });
  }

  test('inherit renders no argument: it is never a wire level', (t) => {
    const home = gsdHome();
    const dir = project({ effort: { agent_overrides: { [MAPPER]: 'inherit' } } });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortInternal(dir, MAPPER), 'inherit');
    assert.equal(resolveEffortArgInternal(dir, MAPPER), '');
  });

  test('the host clamp applies: claude has no minimal, so it renders low', (t) => {
    const home = gsdHome();
    const dir = project({ effort: { agent_overrides: { [MAPPER]: 'minimal' } } });
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => { cleanup(dir); cleanup(home); });

    assert.equal(resolveEffortArgInternal(dir, MAPPER), 'effort="low"');
  });

  test('property: on claude the argument is the cascade value a project names, after the host clamp', (t) => {
    const home = gsdHome();
    useEnv(t, { home, runtime: 'claude' });
    t.after(() => cleanup(home));

    fc.assert(
      fc.property(fc.constantFrom(...VALID_EFFORTS), (effort) => {
        const dir = project({ effort: { agent_overrides: { [MAPPER]: effort } } });
        const arg = resolveEffortArgInternal(dir, MAPPER);
        cleanup(dir);
        return arg === `effort="${effort === 'minimal' ? 'low' : effort}"`;
      }),
      { numRuns: VALID_EFFORTS.length * 3 },
    );
  });
});

describe('#5330 spawnEffortParamFor', () => {
  test('reads the shipped claude descriptor', () => {
    assert.equal(spawnEffortParamFor('claude'), 'effort');
  });

  test('a registered runtime that declares nothing has no parameter', () => {
    assert.equal(spawnEffortParamFor('codex'), null);
  });

  test('absent, unknown and prototype-key ids have no parameter', () => {
    for (const id of ['', undefined, 42, 'not-a-runtime', '__proto__', 'constructor']) {
      assert.equal(spawnEffortParamFor(id), null, String(id));
    }
  });

  test('a registry that failed to load yields no parameter, not Claude Code\'s', () => {
    assert.equal(spawnEffortParamFor('claude', null), null);
  });

  test('a declared value that is not an identifier is not rendered', () => {
    const reg = (v) => ({ runtimes: { x: { runtime: { spawnEffortParam: v } } } });
    assert.equal(spawnEffortParamFor('x', reg('reasoning_effort')), 'reasoning_effort');
    for (const bad of ['effort="high"', 'a b', '', '1x', 7]) {
      assert.equal(spawnEffortParamFor('x', reg(bad)), null, JSON.stringify(bad));
    }
  });
});

describe('#5330 capability validator: runtime.spawnEffortParam', () => {
  function claudeDescriptorWith(value) {
    const cap = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'claude', 'capability.json'), 'utf8'));
    if (value === undefined) delete cap.runtime.spawnEffortParam;
    else cap.runtime.spawnEffortParam = value;
    return cap;
  }
  const fieldErrors = (cap) => validateRuntimeBody(cap).filter((e) => e.includes('spawnEffortParam'));

  test('the shipped value and an absent field are both valid', () => {
    assert.deepEqual(fieldErrors(claudeDescriptorWith('effort')), []);
    assert.deepEqual(fieldErrors(claudeDescriptorWith(undefined)), []);
  });

  test('a non-identifier value is rejected', () => {
    for (const bad of ['', 'effort="high"', 'a b', 42, null, ['effort']]) {
      assert.equal(fieldErrors(claudeDescriptorWith(bad)).length, 1, JSON.stringify(bad));
    }
  });
});

describe('#5330 resolve-model CLI', () => {
  test('emits effort_arg beside effort, and --pick effort_arg prints the bare token', (t) => {
    const home = gsdHome();
    const dir = project({ effort: { agent_overrides: { [MAPPER]: 'xhigh' } } });
    t.after(() => { cleanup(dir); cleanup(home); });
    const env = { GSD_HOME: home, GSD_RUNTIME: 'claude' };

    const full = runGsdTools(['query', 'resolve-model', MAPPER], dir, env);
    assert.ok(full.success, full.error);
    const parsed = JSON.parse(full.output);
    assert.equal(parsed.effort, 'xhigh');
    assert.equal(parsed.effort_arg, 'effort="xhigh"');

    const picked = runGsdTools(['query', 'resolve-model', MAPPER, '--pick', 'effort_arg'], dir, env);
    assert.ok(picked.success, picked.error);
    assert.equal(picked.output.trim(), 'effort="xhigh"');
  });

  test('effort_arg is empty on a host with no per-spawn effort channel', (t) => {
    const home = gsdHome();
    const dir = project({ effort: { agent_overrides: { [MAPPER]: 'xhigh' } } });
    t.after(() => { cleanup(dir); cleanup(home); });

    const res = runGsdTools(['query', 'resolve-model', MAPPER], dir, { GSD_HOME: home, GSD_RUNTIME: 'codex' });
    assert.ok(res.success, res.error);
    assert.equal(JSON.parse(res.output).effort_arg, '');
  });
});
