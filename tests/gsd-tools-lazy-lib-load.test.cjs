'use strict';

/**
 * #5865 — gsd-tools.cjs loads each ./lib module on first use.
 *
 * gsd-tools.cjs used to require ~50 ./lib modules at load, about 220 with their
 * own requires, whatever the command. Now only the modules main() needs before
 * dispatch load eagerly; the rest load when a command first touches them. These
 * rows pin the observable half of that: which modules a process actually loaded
 * (read from require.cache at exit), and that a module placed in require.cache
 * before its first use is the one gsd-tools uses.
 *
 * Output parity is the existing CLI suite's job; these rows only pin the load set.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, createTempProject, cleanup } = require('./helpers.cjs');
const { runNode, assertSeamExit } = require('./helpers/process-seam.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const LIB_DIR = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib');

// Modules no light command needs. Before #5865 every gsd-tools process loaded all of them.
const HEAVY = ['state.cjs', 'phase.cjs', 'roadmap.cjs', 'config.cjs', 'init.cjs', 'verify.cjs', 'commands.cjs', 'milestone.cjs'];

// The requires gsd-tools.cjs keeps eager: main() uses each before it dispatches.
const EAGER = ['cli-exit.cjs', 'io.cjs', 'project-root.cjs', 'cli-skew-check.cjs', 'active-workstream-store.cjs'];

// A --require probe that writes the ./lib modules in require.cache, as paths relative
// to bin/lib, to the file named by GSD_LAZY_LOAD_PROBE_OUT when the process exits.
const PROBE_SOURCE = [
  "'use strict';",
  "const path = require('node:path');",
  "const fs = require('node:fs');",
  "process.on('exit', () => {",
  "  const lib = path.join(" + JSON.stringify(LIB_DIR) + ", path.sep);",
  "  const loaded = Object.keys(require.cache).filter((k) => k.startsWith(lib)).map((k) => k.slice(lib.length).split(path.sep).join('/'));",
  "  fs.writeFileSync(process.env.GSD_LAZY_LOAD_PROBE_OUT, JSON.stringify(loaded.sort()));",
  "});",
  '',
].join('\n');

function loadedLibModules(t, argv, { cwd } = {}) {
  const dir = createTempDir('gsd-5865-probe-');
  t.after(() => cleanup(dir));
  const probe = path.join(dir, 'probe.cjs');
  const out = path.join(dir, 'loaded.json');
  fs.writeFileSync(probe, PROBE_SOURCE);
  const result = runNode(['--require', probe, ...argv], {
    cwd: cwd || dir,
    env: { ...process.env, GSD_LAZY_LOAD_PROBE_OUT: out },
  });
  assert.ok(fs.existsSync(out), `the probe wrote nothing: ${result.summary}`);
  return { result, loaded: JSON.parse(fs.readFileSync(out, 'utf-8')) };
}

describe('#5865: gsd-tools.cjs loads ./lib modules on first use', () => {
  test('runtime-identity loads its own module and none of the heavy ones', (t) => {
    const { result, loaded } = loadedLibModules(t, [GSD_TOOLS, 'runtime-identity', '--raw']);
    assertSeamExit(assert, result, 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.deepEqual(JSON.parse(result.stdout), { packageName: pkg.name, version: pkg.version },
      'the output is the package identity, unchanged');
    assert.ok(loaded.includes('runtime-identity.cjs'), 'the command\'s own module must load');
    for (const heavy of HEAVY) {
      assert.ok(!loaded.includes(heavy), `runtime-identity must not load lib/${heavy} (it loaded ${loaded.length} lib modules)`);
    }
  });

  test('a command that uses lib/state.cjs still loads it (positive control for the probe)', (t) => {
    const project = createTempProject('gsd-5865-state-');
    t.after(() => cleanup(project));
    fs.writeFileSync(path.join(project, '.planning', 'STATE.md'), '# Project State\n\n**Status:** Planning\n');
    const { result, loaded } = loadedLibModules(t, [GSD_TOOLS, 'state', 'json', '--cwd', project]);
    assertSeamExit(assert, result, 0);
    assert.ok(loaded.includes('state.cjs'), `state json must load lib/state.cjs (it loaded ${loaded.length} lib modules)`);
  });

  test('requiring gsd-tools.cjs as a module loads only what main() needs before dispatch', (t) => {
    const { result, loaded } = loadedLibModules(t, ['-e', `require(${JSON.stringify(GSD_TOOLS)})`]);
    assertSeamExit(assert, result, 0);
    for (const eager of EAGER) {
      assert.ok(loaded.includes(eager), `lib/${eager} stays eager (${loaded.length} lib modules loaded)`);
    }
    for (const lazy of ['runtime-identity.cjs', 'planning-workspace.cjs', 'agent-command-router.cjs', 'quick-batch-command-router.cjs', ...HEAVY]) {
      assert.ok(!loaded.includes(lazy), `lib/${lazy} must not load until a command uses it (${loaded.length} lib modules loaded)`);
    }
    // Nothing beyond what the eager requires load themselves: a lazy binding made eager again fails here.
    const eagerOnly = loadedLibModules(t, ['-e', EAGER.map((m) => `require(${JSON.stringify(path.join(LIB_DIR, m))});`).join('')]).loaded;
    assert.ok(eagerOnly.length >= EAGER.length, `the eager requires alone loaded ${eagerOnly.length} lib modules`);
    const extra = loaded.filter((m) => !eagerOnly.includes(m));
    assert.deepEqual(extra, [], 'requiring gsd-tools.cjs loads only what its eager requires load');
  });

  test('a module placed in require.cache before its first use is the one gsd-tools uses', (t) => {
    // In a child process, so the stubs never outlive this row: gsd-tools keeps the
    // module it got at first use, as it kept the module it got at load before.
    const dir = createTempDir('gsd-5865-stub-');
    t.after(() => cleanup(dir));
    const script = path.join(dir, 'stub.cjs');
    fs.writeFileSync(script, [
      "'use strict';",
      "const path = require('node:path');",
      "const Module = require('node:module');",
      `const LIB_DIR = ${JSON.stringify(LIB_DIR)};`,
      `const { dispatchHostCommand } = require(${JSON.stringify(GSD_TOOLS)});`,
      'const calls = [];',
      'const before = {};',
      'function stub(file, exports) {',
      '  const key = require.resolve(path.join(LIB_DIR, file));',
      '  before[file] = key in require.cache;',
      '  const mod = new Module(key);',
      '  mod.filename = key;',
      '  mod.loaded = true;',
      '  mod.exports = exports;',
      '  require.cache[key] = mod;',
      '}',
      // runtime-identity is a namespace binding (lazyModule); quick-batch's router is a function binding (lazyFn).
      "stub('runtime-identity.cjs', { cmdRuntimeIdentity: (raw) => { calls.push(['runtime-identity', raw]); } });",
      "stub('quick-batch-command-router.cjs', { routeQuickBatchCommand: (ctx) => { calls.push(['quick-batch', typeof ctx]); } });",
      'const errors = [];',
      '(async () => {',
      "  const handled = [];",
      "  for (const command of ['runtime-identity', 'quick-batch']) {",
      `    handled.push(await dispatchHostCommand({ command, args: [command], cwd: ${JSON.stringify(REPO_ROOT)}, raw: true, error: (msg) => { errors.push(msg); } }));`,
      '  }',
      '  process.stdout.write(JSON.stringify({ before, handled, calls, errors }));',
      '})();',
      '',
    ].join('\n'));
    const result = runNode([script], { cwd: dir });
    assertSeamExit(assert, result, 0);
    const { before, handled, calls, errors } = JSON.parse(result.stdout);
    assert.deepEqual(before, { 'runtime-identity.cjs': false, 'quick-batch-command-router.cjs': false },
      'precondition: requiring gsd-tools.cjs must not have loaded either module');
    assert.deepEqual(handled, [true, true], 'both are host commands');
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, [['runtime-identity', true], ['quick-batch', 'object']],
      'the stubs placed in require.cache must receive the calls');
  });
});
