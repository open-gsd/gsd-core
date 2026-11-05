/**
 * GSD Tools Tests — ~/.gsd/defaults.json fallback (#1683)
 *
 * When .planning/ does not exist (pre-project context), loadConfig() should
 * consult ~/.gsd/defaults.json before returning hardcoded defaults.
 * When .planning/ exists but config.json is missing, hardcoded defaults are used.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');

/** Create a bare temp dir (no .planning/) to simulate pre-project context */
function createBareTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-'));
}

describe('loadConfig ~/.gsd/defaults.json fallback (#1683)', () => {
  test('pre-project, no defaults.json → hardcoded defaults', (t) => {
    const tmpDir = createBareTmpDir();
    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
    assert.strictEqual(config.context_window, 200000);
    assert.strictEqual(config.research, true);
    assert.strictEqual(config.subagent_timeout, 300000);
  });

  test('pre-project, defaults.json exists → merges with hardcoded defaults', (t) => {
    const tmpDir = createBareTmpDir();

    // Create ~/.gsd/defaults.json under fake GSD_HOME
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ model_profile: 'quality', context_window: 1000000 })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    // Values from defaults.json
    assert.strictEqual(config.model_profile, 'quality');
    assert.strictEqual(config.context_window, 1000000);
    // Hardcoded defaults for keys not in defaults.json
    assert.strictEqual(config.research, true);
    assert.strictEqual(config.subagent_timeout, 300000);
    assert.strictEqual(config.parallelization, true);
  });

  test('.planning/ exists but no config.json → hardcoded defaults (not defaults.json)', (t) => {
    const tmpDir = createBareTmpDir();
    // Create .planning/ without config.json
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });

    // Create defaults.json — should NOT be consulted
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ model_profile: 'quality', context_window: 1000000 })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    // Hardcoded defaults — NOT defaults.json values
    assert.strictEqual(config.model_profile, 'balanced');
    assert.strictEqual(config.context_window, 200000);
  });

  test('project config exists → project config wins', (t) => {
    const tmpDir = createBareTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'budget' })
    );

    // Also write defaults.json with a different value
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ model_profile: 'quality', context_window: 1000000 })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'budget');
    assert.strictEqual(config.context_window, 200000);
  });

  test('defaults.json with unknown keys → unknown keys NOT passed through', (t) => {
    const tmpDir = createBareTmpDir();

    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({
        model_profile: 'quality',
        unknown_key: 'should_not_appear',
        another_unknown: 42,
      })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality');
    assert.strictEqual(config.unknown_key, undefined);
    assert.strictEqual(config.another_unknown, undefined);
  });

  test('defaults.json with invalid JSON → returns hardcoded defaults', (t) => {
    const tmpDir = createBareTmpDir();

    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), '{ not valid json !!!');

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'balanced');
    assert.strictEqual(config.context_window, 200000);
  });

  // ─── #2069: global-defaults must forward model_policy / model_profile_overrides / runtime ─
  // The _globalBaseCfg whitelist in Branch D of loadConfigResolved previously omitted these
  // three keys, so they were silently dropped from ~/.gsd/defaults.json while the identical
  // keys in a project's .planning/config.json were honored. The tests below are fail-first:
  // each asserts the global path forwards its key, mirroring the project-config parity test.

  test('#2069 defaults.json model_policy → forwarded from global defaults', (t) => {
    const tmpDir = createBareTmpDir();
    const policy = { provider: 'anthropic', budget: 'high' };

    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ model_policy: policy })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.deepStrictEqual(config.model_policy, policy);
  });

  test('#2069 defaults.json model_profile_overrides → forwarded from global defaults', (t) => {
    const tmpDir = createBareTmpDir();
    const overrides = { claude: { planner: { model: 'claude-opus-4-5' } } };

    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ model_profile_overrides: overrides })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.deepStrictEqual(config.model_profile_overrides, overrides);
  });

  test('#2069 defaults.json runtime → forwarded from global defaults', (t) => {
    const tmpDir = createBareTmpDir();
    const runtime = 'codex';

    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(gsdDir, 'defaults.json'),
      JSON.stringify({ runtime })
    );

    process.env.GSD_HOME = tmpDir;
    t.after(() => { delete process.env.GSD_HOME; cleanup(tmpDir); });

    const config = loadConfig(tmpDir);
    assert.strictEqual(config.runtime, runtime);
  });

  test('#2069 defaults.json parity: model_policy / model_profile_overrides / runtime survive identically to project-config path', (t) => {
    // Identical values in ~/.gsd/defaults.json (no .planning/) vs .planning/config.json (no defaults.json)
    // must produce identical config.<key> for each of the three previously-dropped keys. A future
    // regression breaking shape-parity for just one key — e.g. changing the project path to
    // `parsed['runtime'] ?? null` — would slip a single-key test, so all three are asserted here.
    const policy = { provider: 'anthropic', budget: 'low' };
    const overrides = { claude: { planner: { model: 'claude-opus-4-5' } } };
    const runtime = 'codex';

    // Global path: ~/.gsd/defaults.json only, no .planning/
    const globalDir = createBareTmpDir();
    const globalGsdDir = path.join(globalDir, '.gsd');
    fs.mkdirSync(globalGsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalGsdDir, 'defaults.json'),
      JSON.stringify({ model_policy: policy, model_profile_overrides: overrides, runtime })
    );

    process.env.GSD_HOME = globalDir;
    const globalConfig = loadConfig(globalDir);
    delete process.env.GSD_HOME;
    t.after(() => { cleanup(globalDir); });

    // Project path: .planning/config.json only, no defaults.json
    const projectDir = createBareTmpDir();
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ model_policy: policy, model_profile_overrides: overrides, runtime })
    );

    // GSD_HOME pointing somewhere with no defaults.json so the project path is the sole source.
    const emptyHome = createBareTmpDir();
    process.env.GSD_HOME = emptyHome;
    const projectConfig = loadConfig(projectDir);
    delete process.env.GSD_HOME;
    t.after(() => { cleanup(projectDir); cleanup(emptyHome); });

    assert.deepStrictEqual(globalConfig.model_policy, projectConfig.model_policy);
    assert.deepStrictEqual(globalConfig.model_profile_overrides, projectConfig.model_profile_overrides);
    assert.strictEqual(globalConfig.runtime, projectConfig.runtime);
  });
});

// ─── #5017: every reader and writer of the defaults store resolves its root like the loader ───
//
// The loader binds the GSD-owned store to `process.env.GSD_HOME || os.homedir()`.
// The install-time resolvers, hooks, installer writer and two workflows bound it to the home
// directory alone, so a configured GSD_HOME split one user's config in two.
{
  const installModel = require('../gsd-core/bin/lib/install-model-override-resolver.cjs');
  const installEffort = require('../gsd-core/bin/lib/install-effort-resolver.cjs');

  /** Two stores holding contradicting defaults; `fill(which)` returns the JSON for that store. */
  function twoStores(t, fill) {
    const gsdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5017-gsdhome-'));
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5017-home-'));
    for (const [dir, which] of [[gsdHome, 'GSD_HOME'], [userHome, 'HOME']]) {
      fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.gsd', 'defaults.json'), JSON.stringify(fill(which)));
    }
    t.after(() => { cleanup(gsdHome); cleanup(userHome); });
    return { gsdHome, userHome };
  }

  /** Run `fn` with the home directory and GSD_HOME pinned (`gsdHomeValue` undefined = unset). */
  function withHomes(userHome, gsdHomeValue, fn) {
    const keys = ['HOME', 'USERPROFILE', 'GSD_HOME'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.HOME = userHome;
    process.env.USERPROFILE = userHome;
    if (gsdHomeValue === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = gsdHomeValue;
    try { return fn(); } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }

  describe('#5017: install-time resolvers read the store the loader reads', () => {
    test('readGsdGlobalModelOverrides: GSD_HOME wins, a blank or unset GSD_HOME falls back to the home directory', (t) => {
      const { gsdHome, userHome } = twoStores(t, (w) => ({ model_overrides: { 'gsd-planner': `model-from-${w}` } }));
      assert.deepStrictEqual(withHomes(userHome, gsdHome, () => installModel.readGsdGlobalModelOverrides()), { 'gsd-planner': 'model-from-GSD_HOME' });
      assert.deepStrictEqual(withHomes(userHome, '', () => installModel.readGsdGlobalModelOverrides()), { 'gsd-planner': 'model-from-HOME' });
      assert.deepStrictEqual(withHomes(userHome, undefined, () => installModel.readGsdGlobalModelOverrides()), { 'gsd-planner': 'model-from-HOME' });
    });

    test('readGsdEffectiveAgentTools: GSD_HOME wins, a blank GSD_HOME falls back', (t) => {
      const { gsdHome, userHome } = twoStores(t, (w) => ({ agent_tools: { 'gsd-planner': [w === 'GSD_HOME' ? 'Read' : 'Grep'] } }));
      assert.deepStrictEqual(withHomes(userHome, gsdHome, () => installModel.readGsdEffectiveAgentTools(null)), { 'gsd-planner': ['Read'] });
      assert.deepStrictEqual(withHomes(userHome, '', () => installModel.readGsdEffectiveAgentTools(null)), { 'gsd-planner': ['Grep'] });
    });

    test('readGsdRuntimeProfileResolver: GSD_HOME wins, a blank GSD_HOME falls back', (t) => {
      const { gsdHome, userHome } = twoStores(t, (w) => ({ runtime: w === 'GSD_HOME' ? 'codex' : 'claude', model_profile: 'quality' }));
      assert.strictEqual(withHomes(userHome, gsdHome, () => installModel.readGsdRuntimeProfileResolver(null)).runtime, 'codex');
      assert.strictEqual(withHomes(userHome, '', () => installModel.readGsdRuntimeProfileResolver(null)).runtime, 'claude');
    });

    test('readGsdEffectiveEffortConfig: GSD_HOME wins, a blank GSD_HOME falls back', (t) => {
      const { gsdHome, userHome } = twoStores(t, (w) => ({ effort: { default: w === 'GSD_HOME' ? 'high' : 'low' } }));
      assert.strictEqual(withHomes(userHome, gsdHome, () => installEffort.readGsdEffectiveEffortConfig(null)).default, 'high');
      assert.strictEqual(withHomes(userHome, '', () => installEffort.readGsdEffectiveEffortConfig(null)).default, 'low');
    });
  });
}

{
  const { runNode } = require('./helpers/process-seam.cjs');
  const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const ROOT = path.resolve(__dirname, '..');

  /** Run bin/install.js for Codex against a throwaway config dir, with the given home / GSD_HOME. */
  function runInstaller(args, { userHome, gsdHome, configDir }) {
    const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, GSD_HOME: userHome };
    delete env.GSD_TEST_MODE;
    if (gsdHome === undefined) delete env.GSD_HOME; else env.GSD_HOME = gsdHome;
    return runNode(
      [path.join(ROOT, 'bin', 'install.js'), '--codex', '--global', '--config-dir', configDir, ...args],
      { cwd: ROOT, env, timeoutMs: INSTALL_TIMEOUT_MS, input: '' },
    );
  }

  describe('#5017: the installer writes and reverts non-Claude defaults in the GSD_HOME store', () => {
    function dirs(t) {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5017-inst-'));
      t.after(() => cleanup(base));
      const d = { userHome: path.join(base, 'home'), gsdHome: path.join(base, 'gsdhome'), configDir: path.join(base, 'cfg') };
      for (const p of Object.values(d)) fs.mkdirSync(p, { recursive: true });
      return d;
    }
    const defaultsIn = (root) => path.join(root, '.gsd', 'defaults.json');

    test('install writes resolve_model_ids and runtime under GSD_HOME, and leaves the home directory alone', (t) => {
      const d = dirs(t);
      const r = runInstaller([], d);
      assert.strictEqual(r.exitCode, 0, `${r.stdout}\n${r.stderr}`);
      assert.ok(fs.existsSync(defaultsIn(d.gsdHome)), 'the GSD_HOME store must receive the defaults');
      const written = JSON.parse(fs.readFileSync(defaultsIn(d.gsdHome), 'utf-8'));
      assert.strictEqual(written.resolve_model_ids, 'omit');
      assert.strictEqual(written.runtime, 'codex');
      assert.ok(!fs.existsSync(defaultsIn(d.userHome)), 'the home directory store must not be created when GSD_HOME is set');
    });

    test('install with GSD_HOME unset still writes under the home directory', (t) => {
      const d = dirs(t);
      const r = runInstaller([], { ...d, gsdHome: undefined });
      assert.strictEqual(r.exitCode, 0, `${r.stdout}\n${r.stderr}`);
      assert.strictEqual(JSON.parse(fs.readFileSync(defaultsIn(d.userHome), 'utf-8')).runtime, 'codex');
    });

    test('install with a blank GSD_HOME falls back to the home directory', (t) => {
      const d = dirs(t);
      const r = runInstaller([], { ...d, gsdHome: '' });
      assert.strictEqual(r.exitCode, 0, `${r.stdout}\n${r.stderr}`);
      assert.strictEqual(JSON.parse(fs.readFileSync(defaultsIn(d.userHome), 'utf-8')).runtime, 'codex');
    });

    test('uninstall reverts the keys it set in the GSD_HOME store', (t) => {
      const d = dirs(t);
      assert.strictEqual(runInstaller([], d).exitCode, 0);
      assert.ok(fs.existsSync(defaultsIn(d.gsdHome)), 'precondition: the install wrote the GSD_HOME store, so there is something to revert');
      const r = runInstaller(['--uninstall'], d);
      assert.strictEqual(r.exitCode, 0, `${r.stdout}\n${r.stderr}`);
      const after = fs.existsSync(defaultsIn(d.gsdHome)) ? JSON.parse(fs.readFileSync(defaultsIn(d.gsdHome), 'utf-8')) : {};
      assert.strictEqual(after.runtime, undefined, 'the runtime key the install set must be reverted');
      assert.strictEqual(after.resolve_model_ids, undefined, 'the resolve_model_ids key the install set must be reverted');
    });
  });

  describe('#5017: the settings and new-project workflows name the store through GSD_HOME', () => {
    const read = (name) => fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', name), 'utf-8');
    const STORE = '${GSD_HOME:-$HOME}/.gsd/defaults.json';

    test('settings.md writes the saved defaults to the GSD_HOME store, not a literal ~/.gsd path, in its shell steps', () => {
      const text = read('settings.md');
      assert.ok(text.includes('mkdir -p "${GSD_HOME:-$HOME}/.gsd"'), 'the mkdir must target the resolved store root');
      assert.ok(text.includes(STORE), 'the write instruction must name the resolved store path');
    });

    test('new-project.md reads the saved defaults from the GSD_HOME store', () => {
      const text = read('new-project.md');
      assert.ok(text.includes(`DEFAULTS_RAW=$(cat "${STORE}" 2>/dev/null)`), 'the read must use the resolved store path');
    });

    test('the resolved-path shell expression follows the loader rule (GSD_HOME when set and non-blank, else HOME)', () => {
      const { runHook } = require('./helpers/process-seam.cjs');
      const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
      const script = `printf '%s' "${STORE}"`;
      const run = (env) => runHook('-c', [script], { interpreter: 'bash', env: { ...process.env, HOME: '/h', ...env }, timeoutMs: PROBE_TIMEOUT_MS }).stdout;
      assert.strictEqual(run({ GSD_HOME: '/g' }), '/g/.gsd/defaults.json');
      assert.strictEqual(run({ GSD_HOME: '' }), '/h/.gsd/defaults.json');
      const env = { ...process.env, HOME: '/h' };
      delete env.GSD_HOME;
      assert.strictEqual(runHook('-c', [script], { interpreter: 'bash', env, timeoutMs: PROBE_TIMEOUT_MS }).stdout, '/h/.gsd/defaults.json');
    });
  });
}
