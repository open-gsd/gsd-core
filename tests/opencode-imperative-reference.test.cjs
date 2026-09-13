// allow-test-rule: structural-regression-guard — AC2 requires asserting no `runtime === 'opencode'` string-equality branch remains in bin/install.js/src — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2087)
'use strict';

/**
 * opencode imperative reference host — ADR-1239 Phase D / #2087 (EoS/opencode).
 *
 * Proves opencode is driven through the PUBLIC Host-Integration Interface (the
 * imperative adapter), that its negotiated axes classify + negotiate correctly,
 * that negotiation fails CLOSED on a corrupted descriptor, that opencode's
 * SYNCHRONOUS dispatch force-flattens (#2598 retracts #2087's background
 * "upgrade" — the capability is behind an opt-in flag, not default-on), and that
 * the migration retired the hardcoded
 * `runtime === 'opencode'` / `isOpencode` branches (folded into descriptor-driven
 * `runtime.hostBehaviors` + the combined-family engine install path).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { cleanup } = require('./helpers.cjs');
const { BUILD_TIMEOUT_MS, INSTALL_TIMEOUT_MS, PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const {
  install: installRuntime,
  writeManifest,
  _prepareNativePluginUpgrade: prepareNativePluginUpgrade,
  _finishNativePluginUpgrade: finishNativePluginUpgrade,
} = require('../bin/install.js');
const {
  profileOf,
  negotiateHostCapabilities,
  shouldFlattenDispatch,
  extensionEventSurfaceFor,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const OC_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'opencode', 'capability.json'), 'utf8'),
);
const OC_AXES = OC_CAP.runtime.hostIntegration;

// Keep this independent of the descriptor: changing the descriptor without
// updating the install contract must fail rather than redefine the assertion.
const EXPECTED_OPEN_CODE_PLUGIN_FILES = ['gsd-core.js'];

test('generated OpenCode V2 dependency bundles are byte-for-byte current', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-opencode-v2-bundles.cjs'), '--check'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('npm package allowlist and dry-run contain exactly the descriptor-declared OpenCode bundles', () => {
  const repo = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const expected = ['.opencode/plugins/gsd-core.js'];
  const allowlisted = manifest.files.filter((entry) => entry.startsWith('.opencode/')).sort();
  assert.deepEqual(allowlisted, expected,
    'package files[] must derive no broader OpenCode shipping surface than nativePlugin.files');

  const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'pack', '--dry-run', '--json', '--ignore-scripts',
  ], {
    cwd: repo,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const result = JSON.parse(packed.stdout);
  const packageResult = Array.isArray(result) ? result[0] : result[Object.keys(result)[0]];
  assert.ok(packageResult && Array.isArray(packageResult.files), 'npm pack returned no package file inventory');
  const shipped = packageResult.files
    .map((entry) => entry.path.replaceAll('\\', '/'))
    .filter((entry) => entry.startsWith('.opencode/'))
    .sort();
  assert.deepEqual(shipped, expected);
  assert.equal(shipped.some((entry) => entry.startsWith('.opencode/gsd-core/')), false);
  assert.equal(shipped.some((entry) => entry.endsWith('.source.js')), false);
  assert.equal(shipped.some((entry) => entry.startsWith('.opencode/agents/') || entry.endsWith('/opencode.json')), false,
    'install-time OpenCode agents and config must be generated from top-level sources, not shipped mirrors');
});

function assertNoAncestorNodeModules(directory) {
  let current = path.resolve(directory);
  for (;;) {
    assert.equal(fs.existsSync(path.join(current, 'node_modules')), false,
      `fresh plugin smoke must not inherit node_modules from ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function isolatedOpenCodeEnv(overrides) {
  const env = { ...process.env };
  for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_SERVICE_ROOT', 'OPENCODE_STATE_DIR']) {
    delete env[key];
  }
  return Object.assign(env, overrides);
}

function assertPluginsActiveViaIsolatedV2Service(t, { project, home, pluginPath }) {
  const config = path.join(home, '.config', 'opencode');
  const data = path.join(home, '.local', 'share');
  const state = path.join(home, '.local', 'state');
  const cache = path.join(home, '.cache');
  const serviceRoot = path.join(state, 'opencode');
  const serviceFile = path.join(serviceRoot, 'service.json');
  for (const directory of [config, data, state, cache, serviceRoot]) fs.mkdirSync(directory, { recursive: true });
  const env = isolatedOpenCodeEnv({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    OPENCODE_DB: path.join(data, 'opencode', 'plugin-smoke.db'),
    GSD_PLUGIN_SMOKE_PROJECT: project,
    GSD_PLUGIN_SMOKE_SERVICE_FILE: serviceFile,
    GSD_PLUGIN_RPC_CONTRACT: path.join(__dirname, '..', 'src', 'opencode-v2-plugin', 'attestation-rpc.mjs'),
  });
  const version = spawnSync('opencode', ['--version'], { env, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if (version.status !== 0 || !/v2\./.test(version.stdout)) {
    t.diagnostic('OpenCode V2 is unavailable; isolated plugin API smoke skipped');
    return;
  }

  assertNoAncestorNodeModules(project);
  const probe = path.join(home, 'plugin-list-probe.mjs');
  const clientEntry = pathToFileURL(path.join(__dirname, '..', 'node_modules', '@opencode', 'client', 'dist', 'promise', 'index.js')).href;
  const serviceEntry = pathToFileURL(path.join(__dirname, '..', 'node_modules', '@opencode', 'client', 'dist', 'promise', 'service.js')).href;
  fs.writeFileSync(probe, `
import { OpenCode } from ${JSON.stringify(clientEntry)};
import { Service } from ${JSON.stringify(serviceEntry)};
import { pathToFileURL } from 'node:url';
const project = process.env.GSD_PLUGIN_SMOKE_PROJECT;
const serviceFile = process.env.GSD_PLUGIN_SMOKE_SERVICE_FILE;
process.chdir(project);
try {
  const endpoint = await Service.ensure({
    version: (value) => value.startsWith('2.'),
    command: ['opencode', '--log-level', 'debug', 'serve', '--service'],
    env: { OPENCODE_LOG_LEVEL: 'DEBUG', OPENCODE_DB: process.env.OPENCODE_DB },
  });
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const location = { directory: project };
  await client.plugin.awaitActivation({ location }, { signal: AbortSignal.timeout(30_000) });
  const listed = await client.plugin.list({ location }, { signal: AbortSignal.timeout(30_000) });
  const contract = await import(pathToFileURL(process.env.GSD_PLUGIN_RPC_CONTRACT));
  const rpc = client.rpc(contract.ATTESTATION_RPC);
  const rpcResult = await rpc.status(
    { parent_session_id: 'ses_bundle_smoke', wave_id: 'wave-bundle-smoke' },
    { location, signal: AbortSignal.timeout(30_000) },
  ).then(() => ({ returned: true }), (error) => ({ type: error?.type, wave_id: error?.data?.wave_id }));
  process.stdout.write(JSON.stringify({
    plugins: listed.data,
    rpc: rpcResult,
    roots: {
      config: process.env.XDG_CONFIG_HOME,
      state: process.env.XDG_STATE_HOME,
      registration: serviceFile,
    },
  }));
} finally {
  await Service.stop().catch(() => {});
}
`);

  const result = spawnSync(process.execPath, [probe], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const response = JSON.parse(result.stdout);
  const plugins = response.plugins;
  const expected = fs.realpathSync(pluginPath);
  const plugin = plugins.find((item) => item.id === 'gsd-core' && item.source?.type === 'local'
    && fs.realpathSync(item.source.path) === expected);
  assert.ok(plugin, `plugin API omitted gsd-core from ${expected}`);
  assert.equal(plugin.state?.status, 'active', JSON.stringify(plugin));
  assert.deepEqual(response.rpc, { type: 'unknown_wave', wave_id: 'wave-bundle-smoke' },
    'installed package-local RPC contract must invoke the active plugin RPC');
  for (const [name, root] of Object.entries(response.roots)) {
    assert.equal(isWithin(home, root), true, `${name} root escaped the test-owned home: ${root}`);
  }
}

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies opencode as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'opencode' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'opencode');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('opencode axes classify as the programmatic-cli reference profile', () => {
  assert.equal(profileOf(OC_AXES), 'programmatic-cli');
});

// -- AC4: dispatch is synchronous — the #2087 "upgrade" is retracted (#2598) --

test('opencode descriptor declares background dispatch false/false (#2598)', () => {
  // #2087 set these true, reading OpenCode v1.15/v1.17 as "background subagents
  // enabled by default in all modes". That reading does not hold against current
  // upstream `dev`, where the capability is opt-in:
  //   experimentalBackgroundSubagents: enabledByExperimental("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS")
  // `enabledByExperimental` falls back to the `experimental` flag and `bool()`
  // defaults false, so the Task tool's `background` parameter is hidden from the
  // model unless an operator opts in. Upstream #29638 (OPEN) confirms the session
  // loop still `tasks.pop()`s one subtask at a time.
  assert.equal(OC_AXES.dispatch.background, false,
    'background subagents are behind an opt-in experimental flag, not default-on');
  assert.equal(OC_AXES.dispatch.backgroundDispatch, false,
    'concurrent dispatch cannot be relied on, so it must not be declared');
});

test('synchronous dispatch force-flattens; the retracted axes would not have', () => {
  // Declaring a capability the host lacks is the failure mode #2598 closes:
  // negotiation is built to fail CLOSED, so an unavailable concurrency
  // capability must serialize rather than be trusted.
  assert.equal(shouldFlattenDispatch(OC_AXES.dispatch), true,
    'with background:false, GSD must force-flatten opencode dispatch (fail closed)');
  // #2939: pin the retracted contract so a silent re-flip is caught. Under the depth-aware
  // rule, flipping ONLY the two background booleans is no longer sufficient to background —
  // opencode's axes lack nested:true + subagentToolkit:"full" + a depth budget > 1, so even
  // the #2087 background values still flatten. A future accurate declaration would need to
  // establish the full nesting capability, not just the background booleans.
  const retracted = { ...OC_AXES.dispatch, background: true, backgroundDispatch: true };
  assert.equal(shouldFlattenDispatch(retracted), true,
    '#2939: the #2087 background-only values still flatten — opencode lacks nested + full toolkit + depth budget');
});

test('opencode extension-event surface includes the #2087 additions (permission + session.error)', () => {
  const surface = extensionEventSurfaceFor('opencode');
  assert.ok(surface, 'opencode is a consumed extensionEvents dialect');
  for (const ev of ['permission.asked', 'permission.replied', 'session.error']) {
    assert.ok(surface.includes(ev), `#2087 adds ${ev} to the opencode extension-event surface`);
  }
  // The engine still owns phase sequencing — no workflow-phase events on the bus.
  assert.ok(!surface.some((e) => /plan:|verify:|ship:/.test(e)));
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for opencode, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...OC_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...OC_AXES, embeddingMode: 'future-unknown' }));
});

test('a partial/empty opencode descriptor degrades to the safe floor, not the programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['programmatic-cli']);
  assert.ok(result.warnings.length > 0);
});

// -- AC2: the hardcoded branches are retired ---------------------------------

test('opencode descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = OC_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.combinedFamilyInstall, true, 'commands+skills+plugin install runs through the engine (adapter)');
  assert.equal(hb.reapplyCommand, '/gsd-update --reapply');
  assert.equal(hb.attributionConfigResolver, 'opencode');
  // #2329: OpenCode discovers commands from the PLURAL `commands/` dir; the
  // singular `command/` made all /gsd-* commands invisible to OpenCode.
  assert.equal(hb.flatCommandDir, 'commands');
  assert.equal(hb.frontmatterDialect, 'opencode');
  assert.equal(hb.skipHomePrefixSubstitution, true);
  assert.equal(hb.skipSettingsUi, true);
  assert.equal(hb.skipUpdateBannerCommand, true);
  assert.equal(hb.skipCodexSkillsManifest, true);
  assert.deepEqual(hb.nativePlugin, {
    dir: 'plugins', file: 'gsd-core.js', source: '.opencode/plugins/gsd-core.js',
  }, 'OpenCode delivery is one self-contained CommonJS host descriptor');
  assert.equal(hb.localPathPrefix, '.opencode/');
  assert.equal(hb.localToolCandidateDir, '.opencode');
  assert.deepEqual(OC_CAP.runtime.orchestratorExec, {
    transport: 'native-tool',
    tool: 'gsd_worktree_task',
  }, 'OpenCode orchestration uses the durable V2 native tool, never opencode run');
});

test('no `runtime === "opencode"` string-equality branch remains in the install source (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  for (const rel of ['bin/install.js', 'src/install-engine.cts', 'src/runtime-artifact-conversion.cts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const offenders = strip(src).match(/runtime\s*[!=]==\s*'opencode'/g) || [];
    assert.deepEqual(offenders, [], `AC2: no hardcoded runtime==='opencode' branch may remain in ${rel}; found: ${offenders.join(', ')}`);
  }
});

test('clean global install, legacy upgrade, manifest, and uninstall cover the flat V2 plugin', async (t) => {
  const repo = path.join(__dirname, '..');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-opencode-v2-install-'));
  t.after(() => cleanup(home));
  const configDir = path.join(home, '.config', 'opencode');
  const pluginsDir = path.join(configDir, 'plugins');
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });

  const legacyBytes = fs.readFileSync(path.join(repo, '.kilo', 'plugins', 'gsd-core.js'));
  fs.writeFileSync(path.join(pluginsDir, 'gsd-core.js'), legacyBytes);
  fs.writeFileSync(path.join(pluginsDir, 'package.json'), '{"type":"commonjs"}\n');
  fs.writeFileSync(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({
    manifestVersion: 2,
    version: 'legacy',
    mode: 'full',
    runtime: 'opencode',
    scope: 'global',
    files: {
      'plugins/gsd-core.js': crypto.createHash('sha256').update(legacyBytes).digest('hex'),
      'plugins/package.json': crypto.createHash('sha256').update('{"type":"commonjs"}\n').digest('hex'),
    },
  }));

  const env = isolatedOpenCodeEnv({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GSD_ALLOW_REAL_HOME_FOR_TESTS: home,
  });
  const run = (...args) => spawnSync(process.execPath, [path.join(repo, 'bin', 'install.js'), ...args], {
    cwd: repo,
    env,
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
  });

  const installed = run('--opencode', '--global');
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(fs.existsSync(path.join(pluginsDir, 'gsd-core.js')), true, 'the retired adapter path is replaced by the current flat plugin');
  assert.notDeepEqual(fs.readFileSync(path.join(pluginsDir, 'gsd-core.js')), legacyBytes, 'manifest-owned legacy adapter bytes must retire');
  assert.equal(fs.existsSync(path.join(pluginsDir, 'package.json')), true, 'the current CommonJS plugin marker remains available');

  assert.deepEqual(EXPECTED_OPEN_CODE_PLUGIN_FILES, ['gsd-core.js']);
  const installedPlugin = path.join(pluginsDir, 'gsd-core.js');
  assert.deepEqual(fs.readFileSync(installedPlugin), fs.readFileSync(path.join(repo, '.opencode', 'plugins', 'gsd-core.js')));
  assert.equal(fs.existsSync(path.join(pluginsDir, 'gsd-core')), false, 'package-directory plugin delivery must remain retired');
  assert.equal(fs.existsSync(`${installedPlugin}.map`), false, 'flat host bundle ships without a package source map');
  const manifest = JSON.parse(fs.readFileSync(path.join(configDir, 'gsd-file-manifest.json'), 'utf8'));
  for (const file of EXPECTED_OPEN_CODE_PLUGIN_FILES) assert.ok(manifest.files[`plugins/${file}`], `manifest missing ${file}`);
  assert.equal(
    manifest.files['plugins/gsd-core.js'],
    crypto.createHash('sha256').update(fs.readFileSync(installedPlugin)).digest('hex'),
    'manifest must track the replacement flat plugin',
  );
  assertPluginsActiveViaIsolatedV2Service(t, {
    project,
    home,
    pluginPath: installedPlugin,
  });

  const uninstalled = run('--opencode', '--global', '--uninstall');
  assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
  assert.equal(fs.existsSync(installedPlugin), false, 'uninstall retained flat host plugin');
});

test('OpenCode global upgrade retires only a manifest-pristine legacy adapter', (t) => {
  const repo = path.join(__dirname, '..');
  const legacyBytes = fs.readFileSync(path.join(repo, '.kilo', 'plugins', 'gsd-core.js'));
  const legacyHash = crypto.createHash('sha256').update(legacyBytes).digest('hex');
  const cases = [
    { name: 'managed-pristine', manifestHash: legacyHash, bytes: legacyBytes, expectedBytes: fs.readFileSync(path.join(repo, '.opencode', 'plugins', 'gsd-core.js')) },
    { name: 'managed-modified', manifestHash: legacyHash, bytes: Buffer.concat([legacyBytes, Buffer.from('\n// user edit\n')]), expectedBytes: null },
    { name: 'unknown', manifestHash: null, bytes: legacyBytes, expectedBytes: null },
  ];

  for (const fixture of cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-opencode-retire-${fixture.name}-`));
    t.after(() => cleanup(home));
    const configDir = path.join(home, '.config', 'opencode');
    const legacyPath = path.join(configDir, 'plugins', 'gsd-core.js');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, fixture.bytes);
    fs.writeFileSync(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({
      manifestVersion: 2,
      version: 'legacy',
      mode: 'full',
      runtime: 'opencode',
      scope: 'global',
      files: fixture.manifestHash === null ? {} : { 'plugins/gsd-core.js': fixture.manifestHash },
    }));
    const env = isolatedOpenCodeEnv({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GSD_ALLOW_REAL_HOME_FOR_TESTS: home,
    });

    const installed = spawnSync(process.execPath, [path.join(repo, 'bin', 'install.js'), '--opencode', '--global'], {
      cwd: repo,
      env,
      encoding: 'utf8',
      timeout: INSTALL_TIMEOUT_MS,
    });
    assert.equal(installed.status, 0, `${fixture.name}: ${installed.stderr || installed.stdout}`);
    assert.equal(fs.existsSync(legacyPath), true, fixture.name);
    assert.deepEqual(fs.readFileSync(legacyPath), fixture.expectedBytes || fixture.bytes, fixture.name);
  }
});

test('OpenCode local upgrade preserves modified and unknown flat-plugin collisions without acquiring ownership', (t) => {
  const repo = path.join(__dirname, '..');
  const legacyBytes = fs.readFileSync(path.join(repo, '.kilo', 'plugins', 'gsd-core.js'));
  const legacyHash = crypto.createHash('sha256').update(legacyBytes).digest('hex');
  const cases = [
    { name: 'managed-modified', manifestHash: legacyHash, bytes: Buffer.concat([legacyBytes, Buffer.from('\n// local user edit\n')]) },
    { name: 'unknown', manifestHash: null, bytes: legacyBytes },
  ];

  for (const fixture of cases) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-opencode-local-retire-${fixture.name}-`));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-opencode-local-home-${fixture.name}-`));
    t.after(() => cleanup(project));
    t.after(() => cleanup(home));
    const configDir = path.join(project, '.opencode');
    const pluginPath = path.join(configDir, 'plugins', 'gsd-core.js');
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, fixture.bytes);
    fs.writeFileSync(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({
      manifestVersion: 2,
      version: 'legacy',
      mode: 'full',
      runtime: 'opencode',
      scope: 'local',
      files: fixture.manifestHash === null ? {} : { 'plugins/gsd-core.js': fixture.manifestHash },
    }));
    const installed = spawnSync(process.execPath, [path.join(repo, 'bin', 'install.js'), '--opencode', '--local'], {
      cwd: project,
      env: isolatedOpenCodeEnv({
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        GSD_ALLOW_REAL_HOME_FOR_TESTS: home,
      }),
      encoding: 'utf8',
      timeout: INSTALL_TIMEOUT_MS,
    });
    assert.equal(installed.status, 0, `${fixture.name}: ${installed.stderr || installed.stdout}`);
    assert.deepEqual(fs.readFileSync(pluginPath), fixture.bytes, fixture.name);
    const manifest = JSON.parse(fs.readFileSync(path.join(configDir, 'gsd-file-manifest.json'), 'utf8'));
    assert.equal(
      manifest.files['plugins/gsd-core.js'],
      fixture.manifestHash === null ? undefined : fixture.manifestHash,
      fixture.name,
    );
  }
});

test('sequential in-process local installs do not transfer protected plugin ownership', (t) => {
  const repo = path.join(__dirname, '..');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-opencode-sequential-project-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-opencode-sequential-home-'));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalAllowRealHome = process.env.GSD_ALLOW_REAL_HOME_FOR_TESTS;
  const originalLog = console.log;
  const originalWarn = console.warn;
  t.after(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
    if (originalAllowRealHome === undefined) delete process.env.GSD_ALLOW_REAL_HOME_FOR_TESTS; else process.env.GSD_ALLOW_REAL_HOME_FOR_TESTS = originalAllowRealHome;
    console.log = originalLog;
    console.warn = originalWarn;
    cleanup(project);
    cleanup(home);
  });
  process.chdir(project);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.GSD_ALLOW_REAL_HOME_FOR_TESTS = home;
  console.log = () => {};
  console.warn = () => {};

  const configDir = path.join(project, '.opencode');
  const pluginPath = path.join(configDir, 'plugins', 'gsd-core.js');
  const unknownBytes = Buffer.from('// user-owned plugin\n');
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(pluginPath, unknownBytes);
  fs.writeFileSync(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({ files: {} }));

  installRuntime(false, 'opencode');
  assert.deepEqual(fs.readFileSync(pluginPath), unknownBytes, 'first install preserves the unknown file');
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'gsd-file-manifest.json'), 'utf8')).files['plugins/gsd-core.js'], undefined);

  fs.unlinkSync(pluginPath);
  installRuntime(false, 'opencode');
  assert.deepEqual(fs.readFileSync(pluginPath), fs.readFileSync(path.join(repo, '.opencode', 'plugins', 'gsd-core.js')));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(configDir, 'gsd-file-manifest.json'), 'utf8')).files['plugins/gsd-core.js'],
    crypto.createHash('sha256').update(fs.readFileSync(pluginPath)).digest('hex'),
    'the second invocation must not inherit the first invocation ownership override',
  );
});

test('OpenCode collision parking is private, symlink-safe, and clears failed-install ownership state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-opencode-native-plugin-transaction-'));
  t.after(() => cleanup(root));
  const configDir = path.join(root, '.opencode');
  const pluginPath = path.join(configDir, 'plugins', 'gsd-core.js');
  const legacyParkingCollision = path.join(path.dirname(pluginPath), `.${path.basename(pluginPath)}.gsd-preserve-${process.pid}-0`);
  const userBytes = Buffer.from('// user-owned plugin\n');
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(pluginPath, userBytes);
  fs.writeFileSync(legacyParkingCollision, 'must-not-be-replaced\n');
  fs.writeFileSync(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({ files: {} }));

  const failed = prepareNativePluginUpgrade('opencode', configDir);
  assert.ok(failed, 'unknown collision must be parked before engine materialization');
  assert.match(path.basename(failed.parkingDir), /^\.gsd-native-plugin-preserve-/);
  assert.deepEqual(fs.readFileSync(failed.parkedPath), userBytes);
  fs.writeFileSync(pluginPath, '// staged replacement\n');
  assert.throws(() => {
    try {
      throw new Error('injected adapter/engine failure after parking');
    } catch (installError) {
      try {
        finishNativePluginUpgrade(failed, false);
      } catch (restoreError) {
        throw new AggregateError([installError, restoreError]);
      }
      throw installError;
    }
  }, /injected adapter\/engine failure after parking/);
  assert.deepEqual(fs.readFileSync(pluginPath), userBytes, 'failed materialization restores the original entry');
  assert.equal(fs.existsSync(failed.parkingDir), false, 'failed transaction removes its empty private parking directory');
  assert.equal(fs.readFileSync(legacyParkingCollision, 'utf8'), 'must-not-be-replaced\n', 'legacy predictable parking-name collision is untouched');

  // A same-root manifest sub-write after the failure must not consume stale
  // preservation state left by the failed transaction.
  const manifest = writeManifest(configDir, 'opencode', { scope: 'local' });
  assert.equal(manifest.files['plugins/gsd-core.js'], crypto.createHash('sha256').update(userBytes).digest('hex'));

  const target = path.join(root, 'symlink-target.js');
  const targetBytes = Buffer.from('// target must remain untouched\n');
  fs.writeFileSync(target, targetBytes);
  fs.unlinkSync(pluginPath);
  fs.symlinkSync(target, pluginPath);
  fs.writeFileSync(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({ files: {} }));
  const symlink = prepareNativePluginUpgrade('opencode', configDir);
  assert.ok(symlink);
  assert.equal(fs.lstatSync(symlink.parkedPath).isSymbolicLink(), true, 'classification parks and lstats a symlink instead of dereferencing it');
  assert.deepEqual(fs.readFileSync(target), targetBytes, 'parking never changes a symlink target');
  fs.writeFileSync(pluginPath, '// staged replacement\n');
  finishNativePluginUpgrade(symlink, true);
  assert.equal(fs.lstatSync(pluginPath).isSymbolicLink(), true, 'successful collision handling restores the original symlink inode');
  assert.deepEqual(fs.readFileSync(target), targetBytes, 'restoration never writes through the symlink');
  assert.equal(fs.existsSync(symlink.parkingDir), false, 'successful transaction removes its empty private parking directory');
});

test('local install is movable and resolves its repository-local gsd-tools', async (t) => {
  const repo = path.join(__dirname, '..');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-opencode-v2-local-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-opencode-v2-home-'));
  t.after(() => cleanup(project));
  t.after(() => cleanup(home));
  const userPackage = '{"name":"user-project","private":true}\n';
  const userConfig = { $schema: 'https://opencode.ai/config.json', username: 'preserve-me' };
  fs.writeFileSync(path.join(project, 'package.json'), userPackage);
  fs.mkdirSync(path.join(project, '.opencode'), { recursive: true });
  fs.writeFileSync(path.join(project, '.opencode', 'opencode.json'), `${JSON.stringify(userConfig, null, 2)}\n`);
  const installed = spawnSync(process.execPath, [path.join(repo, 'bin', 'install.js'), '--opencode', '--local'], {
    cwd: project,
    env: isolatedOpenCodeEnv({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GSD_ALLOW_REAL_HOME_FOR_TESTS: home,
    }),
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
  });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(fs.readFileSync(path.join(project, 'package.json'), 'utf8'), userPackage,
    'dependency-free plugin install must not modify the user package');
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.opencode', 'opencode.json'), 'utf8')).username,
    userConfig.username, 'install must preserve unrelated OpenCode configuration');

  const command = fs.readFileSync(path.join(project, '.opencode', 'commands', 'gsd-quick-batch.md'), 'utf8');
  assert.match(command, /@\.opencode\/gsd-core\/workflows\/quick-batch\.md/);
  const workflow = fs.readFileSync(path.join(project, '.opencode', 'gsd-core', 'workflows', 'quick-batch.md'), 'utf8');
  assert.ok(workflow.includes('"${_GSD_RUNTIME_ROOT}/.opencode/gsd-core/bin/${_GSD_SHIM_NAME}"'));
  assert.equal(command.includes(project), false, 'command must not embed its install-machine project path');
  assert.equal(workflow.includes(project), false, 'workflow must not embed its install-machine project path');
  assert.equal(fs.existsSync(path.join(project, '.opencode', 'gsd-core', 'bin', 'gsd-tools.cjs')), true);
  const installedHelper = path.join(project, '.opencode', 'gsd-core', 'bin', 'lib', 'opencode-v2-attestation.cjs');
  const helperImport = spawnSync(process.execPath, ['-e', `const helper=require(${JSON.stringify(installedHelper)});process.stdout.write(helper.RPC_ID)`], {
    cwd: project,
    env: { ...process.env, NODE_PATH: '' },
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  });
  assert.equal(helperImport.status, 0, helperImport.stderr || helperImport.stdout);
  assert.equal(helperImport.stdout, 'gsd-worktree-task.attestation.v1');
  const installedPlugin = path.join(project, '.opencode', 'plugins', 'gsd-core.js');
  assert.equal(fs.existsSync(installedPlugin), true, 'local install omitted flat host plugin');
  assert.deepEqual(fs.readFileSync(installedPlugin), fs.readFileSync(path.join(repo, '.opencode', 'plugins', 'gsd-core.js')));
  assert.equal(fs.existsSync(path.join(project, '.opencode', 'plugins', 'gsd-worktree-task')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(project, '.opencode', 'gsd-file-manifest.json'), 'utf8'));
  for (const file of EXPECTED_OPEN_CODE_PLUGIN_FILES) assert.ok(manifest.files[`plugins/${file}`], `local manifest missing ${file}`);
  assertPluginsActiveViaIsolatedV2Service(t, {
    project,
    home,
    pluginPath: installedPlugin,
  });

  const uninstalled = spawnSync(process.execPath, [path.join(repo, 'bin', 'install.js'), '--opencode', '--local', '--uninstall'], {
    cwd: project,
    env: isolatedOpenCodeEnv({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GSD_ALLOW_REAL_HOME_FOR_TESTS: home,
    }),
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
  });
  assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
  assert.equal(fs.readFileSync(path.join(project, 'package.json'), 'utf8'), userPackage,
    'uninstall must preserve the user package');
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.opencode', 'opencode.json'), 'utf8')).username,
    userConfig.username, 'uninstall must preserve unrelated OpenCode configuration');
  assert.equal(fs.existsSync(installedPlugin), false, 'local uninstall retained flat host plugin');
});
