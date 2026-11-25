'use strict';

/**
 * #6033 (epic #4635 Phase 1) — tests/helpers/isolated-env.cjs.
 *
 * Every isolation control asserts on a CHILD process (spawned through the
 * process seam), fed an injected hostile `base` — process.env is never
 * mutated. Each control is paired with a bypass run of the same probe against
 * the raw hostile env, proving the probe is able to see the leak it guards.
 *
 * Matrix: .gsd/phase/test-6033-isolated-env-seam/50-test-matrix.md rows 1-19.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { isolatedEnv, isolatedPath, createHermeticRoot, linkExecutable, homePair, setEnvForTest, withHome } = require('./helpers/isolated-env.cjs');

const MODEL_RESOLVER = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'install-model-override-resolver.cjs',
);
const EFFORT_RESOLVER = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'install-effort-resolver.cjs',
);

const IS_WIN = process.platform === 'win32';
const NODE_BIN = IS_WIN ? 'node.exe' : 'node';
const GSD_RUN = IS_WIN ? 'gsd_run.exe' : 'gsd_run';

// Windows children need SystemRoot to start at all; carry it into every injected base.
const SYSTEM_VARS = IS_WIN ? { SystemRoot: process.env.SystemRoot } : {};

// src/install-effort-resolver.cts:182 — `for (let depth = 0; depth < 8; depth += 1)` probes
// targetDir ITSELF at depth 0, then its parents. A `.planning/config.json` that sits k
// directories above targetDir is therefore probed at depth k and found iff k <= 7.
const WALK_PROBES = 8;
const MAX_REACHABLE_DISTANCE = WALK_PROBES - 1;

function tmp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => cleanup(dir));
  return dir;
}

function seamStdout(result) {
  assert.equal(result.outcome, OUTCOME.EXITED, `child did not exit cleanly: ${result.stderr}`);
  assert.equal(result.exitCode, 0, `child exited ${result.exitCode}: ${result.stderr}`);
  return result.stdout;
}

/** Spawn a probe script in a child with EXACTLY `env`; returns the parsed JSON it printed. */
function probe(script, env, args = []) {
  const result = runNode(['-e', script, ...args], { env, timeoutMs: PROBE_TIMEOUT_MS });
  return JSON.parse(seamStdout(result));
}

const ENV_PROBE = 'process.stdout.write(JSON.stringify({env:process.env,home:require("node:os").homedir()}))';

/** The env a child sees for the given spawn env. */
function childView(env) {
  return probe(ENV_PROBE, env);
}

function valuesNamed(env, pattern) {
  return Object.entries(env).filter(([k]) => pattern.test(k));
}

/** Write an executable `#!/bin/sh` stub (exit 0) named `name` in `dir`. */
function writeShellStub(dir, name) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(target, 0o755);
  return target;
}

describe('homePair (#6639)', () => {
  test('returns a new HOME/USERPROFILE pair for the directory given, on every call', () => {
    const first = homePair('/h/one');
    assert.deepEqual(Object.keys(first).sort(), ['HOME', 'USERPROFILE']);
    assert.equal(first.HOME, '/h/one');
    assert.equal(first.USERPROFILE, '/h/one');
    assert.notEqual(homePair('/h/one'), first);
    delete first.HOME;
    assert.equal(homePair('/h/one').HOME, '/h/one', 'a caller mutating one pair must not change the next');
  });

  test('isolated-env.cjs and helpers.cjs load in either order, with no require cycle', (t) => {
    const isolatedEnvPath = path.join(__dirname, 'helpers', 'isolated-env.cjs');
    const helpersPath = path.join(__dirname, 'helpers.cjs');
    const script = [
      'const [a, b] = process.argv.slice(1).map((p) => require(p));',
      'const iso = a.homePair ? a : b;',
      'const hel = a.homeSandboxEnv ? a : b;',
      'process.stdout.write(JSON.stringify({',
      '  pair: iso.homePair("/x"),',
      '  sandbox: hel.homeSandboxEnv("/y"),',
      '  built: iso.isolatedEnv({ home: process.cwd(), base: {} }).HOME === process.cwd(),',
      '}));',
    ].join('\n');
    const home = tmp(t, 'gsd-6639-order-');

    for (const order of [[isolatedEnvPath, helpersPath], [helpersPath, isolatedEnvPath]]) {
      const out = probe(script, isolatedEnv({ home }), order);
      assert.equal(out.pair.HOME, '/x', `load order ${order.map((p) => path.basename(p)).join(' then ')}`);
      assert.equal(out.pair.USERPROFILE, '/x');
      assert.equal(out.sandbox.HOME, '/y');
      assert.equal(out.sandbox.USERPROFILE, '/y');
      assert.equal(out.built, true, 'isolatedEnv builds an env after both modules loaded');
    }
  });
});

describe('withHome (#6639)', () => {
  /** A stand-in for the node:test context: collects the after-hooks so the test runs them itself. */
  const fakeContext = () => {
    const hooks = [];
    return { after: (fn) => hooks.push(fn), finish: () => hooks.splice(0).forEach((fn) => fn()) };
  };

  test('os.homedir() follows the directory while the test lives, and each variable is put back after', (t) => {
    const names = Object.keys(homePair('x'));
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    t.after(() => {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const dir = tmp(t, 'gsd-6639-withhome-');
    const ctx = fakeContext();

    withHome(ctx, dir);
    assert.equal(process.env.HOME, dir);
    assert.equal(process.env.USERPROFILE, dir);
    assert.equal(os.homedir(), dir);

    ctx.finish();
    assert.deepEqual(Object.fromEntries(names.map((name) => [name, process.env[name]])), before);
  });

  test('a variable that was unset is deleted again, not left as the string "undefined"', (t) => {
    const saved = process.env.USERPROFILE;
    t.after(() => {
      if (saved === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved;
    });
    delete process.env.USERPROFILE;
    const homeBefore = process.env.HOME;
    t.after(() => {
      if (homeBefore === undefined) delete process.env.HOME;
      else process.env.HOME = homeBefore;
    });
    const ctx = fakeContext();

    withHome(ctx, '/h/two');
    assert.equal(process.env.USERPROFILE, '/h/two');
    ctx.finish();

    assert.equal('USERPROFILE' in process.env, false);
    assert.equal(process.env.HOME, homeBefore);
  });

  test('calls on one context stack: the restore is to the value from before the first call, in either hook order', (t) => {
    const names = Object.keys(homePair('x'));
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    t.after(() => {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    for (const order of ['forward', 'reverse']) {
      const hooks = [];
      const ctx = { after: (fn) => hooks.push(fn) };
      withHome(ctx, '/h/first');
      withHome(ctx, '/h/second');
      setEnvForTest(ctx, { GSD_6639_STACK_PROBE: 'on' });
      assert.equal(process.env.HOME, '/h/second');
      assert.equal(process.env.GSD_6639_STACK_PROBE, 'on');

      for (const fn of order === 'forward' ? hooks : [...hooks].reverse()) fn();
      assert.deepEqual(Object.fromEntries(names.map((name) => [name, process.env[name]])), before, order);
      assert.equal('GSD_6639_STACK_PROBE' in process.env, false, order);
      assert.equal(hooks.length, 1, 'one restore hook per context, however many calls');
    }
  });

  test('a context reused after its hooks ran gets a fresh snapshot and a fresh hook', (t) => {
    const names = Object.keys(homePair('x'));
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    t.after(() => {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const hooks = [];
    const ctx = { after: (fn) => hooks.push(fn) };

    withHome(ctx, '/h/one');
    hooks.splice(0).forEach((fn) => fn());
    assert.deepEqual(Object.fromEntries(names.map((name) => [name, process.env[name]])), before);

    withHome(ctx, '/h/two');
    assert.equal(process.env.HOME, '/h/two');
    assert.equal(hooks.length, 1, 'the second use registers its own restore hook');
    hooks.splice(0).forEach((fn) => fn());
    assert.deepEqual(Object.fromEntries(names.map((name) => [name, process.env[name]])), before);
  });

  test('undefined unsets a variable for the test; any other non-string is a TypeError and changes nothing', (t) => {
    const saved = process.env.GSD_6639_UNSET_PROBE;
    t.after(() => {
      if (saved === undefined) delete process.env.GSD_6639_UNSET_PROBE;
      else process.env.GSD_6639_UNSET_PROBE = saved;
    });
    process.env.GSD_6639_UNSET_PROBE = 'set';
    const goodSaved = process.env.GSD_6639_GOOD_PROBE;
    t.after(() => {
      if (goodSaved === undefined) delete process.env.GSD_6639_GOOD_PROBE;
      else process.env.GSD_6639_GOOD_PROBE = goodSaved;
    });
    delete process.env.GSD_6639_GOOD_PROBE;
    const hooks = [];
    const ctx = { after: (fn) => hooks.push(fn) };

    setEnvForTest(ctx, { GSD_6639_UNSET_PROBE: undefined });
    assert.equal('GSD_6639_UNSET_PROBE' in process.env, false);
    hooks.splice(0).forEach((fn) => fn());
    assert.equal(process.env.GSD_6639_UNSET_PROBE, 'set');

    for (const bad of [null, 1, true, {}]) {
      assert.throws(() => setEnvForTest(ctx, { GSD_6639_UNSET_PROBE: bad }), TypeError);
      // A valid entry ahead of the bad one must not be applied: the whole call is validated first.
      assert.throws(() => setEnvForTest(ctx, { GSD_6639_GOOD_PROBE: 'x', GSD_6639_UNSET_PROBE: bad }), TypeError);
      assert.equal('GSD_6639_GOOD_PROBE' in process.env, false);
    }
    for (const name of ['', 'A=B', 'A\0B']) {
      assert.throws(() => setEnvForTest(ctx, { GSD_6639_GOOD_PROBE: 'x', [name]: 'y' }), TypeError, JSON.stringify(name));
      assert.equal('GSD_6639_GOOD_PROBE' in process.env, false);
    }
    assert.throws(() => setEnvForTest(ctx, { GSD_6639_GOOD_PROBE: 'a\0b' }), TypeError);
    assert.equal('GSD_6639_GOOD_PROBE' in process.env, false);
    assert.equal(process.env.GSD_6639_UNSET_PROBE, 'set');
    assert.equal(hooks.length, 0, 'a rejected call registers no hook');
  });

  test('undefined for a variable that was never set leaves it unset after the restore', (t) => {
    const saved = process.env.GSD_6639_ABSENT_PROBE;
    t.after(() => {
      if (saved === undefined) delete process.env.GSD_6639_ABSENT_PROBE;
      else process.env.GSD_6639_ABSENT_PROBE = saved;
    });
    delete process.env.GSD_6639_ABSENT_PROBE;
    const hooks = [];
    const ctx = { after: (fn) => hooks.push(fn) };

    setEnvForTest(ctx, { GSD_6639_ABSENT_PROBE: undefined });
    assert.equal('GSD_6639_ABSENT_PROBE' in process.env, false);
    hooks.splice(0).forEach((fn) => fn());
    assert.equal('GSD_6639_ABSENT_PROBE' in process.env, false);
  });
});

describe('isolatedEnv: home', () => {
  test('HOME and USERPROFILE both point at home', (t) => {
    const home = tmp(t, 'gsd-6033-home-');
    const hostile = tmp(t, 'gsd-6033-hostile-home-');
    const base = { ...SYSTEM_VARS, ...homePair(hostile) };

    const view = childView(isolatedEnv({ home, base }));
    assert.equal(view.env.HOME, home);
    assert.equal(view.env.USERPROFILE, home);
    assert.equal(view.home, home);

    // Bypass: the same probe against the raw hostile base sees the hostile home.
    const raw = childView({ ...base });
    assert.equal(raw.home, hostile);
  });

  test('userProfile sets USERPROFILE apart from HOME, defaults to home, and rejects a non-absolute path (#6638)', (t) => {
    const home = tmp(t, 'gsd-6638-home-');
    const profile = tmp(t, 'gsd-6638-profile-');

    const split = isolatedEnv({ home, userProfile: profile, base: {} });
    assert.equal(split.HOME, home);
    assert.equal(split.USERPROFILE, profile);

    assert.equal(isolatedEnv({ home, base: {} }).USERPROFILE, home, 'omitted: USERPROFILE is home');
    assert.equal(isolatedEnv({ home, userProfile: undefined, base: {} }).USERPROFILE, home);

    assert.throws(() => isolatedEnv({ home, userProfile: 'relative/dir', base: {} }), TypeError);
    assert.throws(() => isolatedEnv({ home, userProfile: '', base: {} }), TypeError);
    assert.throws(() => isolatedEnv({ home, userProfile: null, base: {} }), TypeError);
    // an absolute path other than home is accepted, whatever its form.
    const absolute = path.resolve(os.tmpdir());
    assert.equal(isolatedEnv({ home, userProfile: absolute, base: {} }).USERPROFILE, absolute);
  });

  test('rejects a missing or relative home', () => {
    assert.throws(() => isolatedEnv(), TypeError);
    assert.throws(() => isolatedEnv({}), TypeError);
    assert.throws(() => isolatedEnv({ home: undefined }), TypeError);
    assert.throws(() => isolatedEnv({ home: '' }), TypeError);
    assert.throws(() => isolatedEnv({ home: 'relative/dir' }), TypeError);
    assert.throws(() => isolatedEnv({ home: '.' }), TypeError);
    // limit: the smallest absolute path is accepted.
    const home = path.resolve(os.tmpdir());
    assert.equal(isolatedEnv({ home, base: {} }).HOME, home);
  });
});

describe('isolatedEnv: stripped and inherited variables', () => {
  test('CLAUDE_CONFIG_DIR blanked unless given', (t) => {
    const home = tmp(t, 'gsd-6033-ccd-home-');
    const claudeDir = tmp(t, 'gsd-6033-ccd-dir-');
    const base = { ...SYSTEM_VARS, CLAUDE_CONFIG_DIR: '/hostile/claude' };

    const blanked = childView(isolatedEnv({ home, base }));
    assert.equal(blanked.env.CLAUDE_CONFIG_DIR || '', '');

    const given = childView(isolatedEnv({ home, base, claudeConfigDir: claudeDir }));
    assert.equal(given.env.CLAUDE_CONFIG_DIR, claudeDir);

    const raw = childView({ ...base });
    assert.equal(raw.env.CLAUDE_CONFIG_DIR, '/hostile/claude');
  });

  test('ambient GSD_* stripped', (t) => {
    const home = tmp(t, 'gsd-6033-gsd-home-');
    const base = {
      ...SYSTEM_VARS,
      GSD_FOO: 'hostile-foo',
      GSD_RUNTIME: 'hostile-runtime',
      gsd_lower: 'hostile-lower',
    };

    const view = childView(isolatedEnv({ home, base }));
    const gsdKeys = valuesNamed(view.env, /^gsd_/i);
    for (const [key, value] of gsdKeys) {
      assert.ok(!String(value).startsWith('hostile-'), `${key} leaked ${value}`);
    }
    assert.ok(!('GSD_FOO' in view.env));
    assert.ok(!('gsd_lower' in view.env));

    // Bypass: raw base shows every hostile value to the same probe (POSIX is case-sensitive,
    // Windows folds, so match case-insensitively on the key).
    const raw = childView({ ...base });
    assert.equal(valuesNamed(raw.env, /^gsd_foo$/i)[0][1], 'hostile-foo');
    assert.equal(valuesNamed(raw.env, /^gsd_runtime$/i)[0][1], 'hostile-runtime');
    assert.equal(valuesNamed(raw.env, /^gsd_lower$/i)[0][1], 'hostile-lower');
  });

  test('prefix match only', (t) => {
    const home = tmp(t, 'gsd-6033-prefix-home-');
    const base = { ...SYSTEM_VARS, MY_GSD_X: 'kept' };
    const view = childView(isolatedEnv({ home, base }));
    assert.equal(view.env.MY_GSD_X, 'kept');
  });

  test('runner control vars stripped', (t) => {
    const home = tmp(t, 'gsd-6033-runner-home-');
    const base = {
      ...SYSTEM_VARS,
      RUN_TESTS_NO_FORCE_EXIT: '1',
      RUN_TESTS_SHARD_RESERVE: '9',
      NODE_TEST_CONTEXT: 'child-v8',
    };

    const view = childView(isolatedEnv({ home, base }));
    for (const key of ['RUN_TESTS_NO_FORCE_EXIT', 'RUN_TESTS_SHARD_RESERVE', 'NODE_TEST_CONTEXT']) {
      assert.ok(!(key in view.env), `${key} leaked into the child`);
    }

    const raw = childView({ ...base });
    assert.equal(raw.env.RUN_TESTS_NO_FORCE_EXIT, '1');
    assert.equal(raw.env.RUN_TESTS_SHARD_RESERVE, '9');
    assert.equal(raw.env.NODE_TEST_CONTEXT, 'child-v8');
  });

  test('override opts a stripped var back in', (t) => {
    const home = tmp(t, 'gsd-6033-override-home-');
    const base = { ...SYSTEM_VARS, RUN_TESTS_SHARD_RESERVE: '9', GSD_FOO: 'hostile-foo' };
    const override = { RUN_TESTS_SHARD_RESERVE: '3', GSD_TEST_DIR: '/fixture/dir', GSD_FOO: 'chosen' };

    const view = childView(isolatedEnv({ home, base, override }));
    assert.equal(view.env.RUN_TESTS_SHARD_RESERVE, '3');
    assert.equal(view.env.GSD_TEST_DIR, '/fixture/dir');
    assert.equal(view.env.GSD_FOO, 'chosen');
  });

  test('bash re-injection vars stripped', (t) => {
    const home = tmp(t, 'gsd-6033-bash-home-');
    const base = { ...SYSTEM_VARS, BASH_ENV: '/hostile/bashenv', CLAUDE_ENV_FILE: '/hostile/envfile' };

    const view = childView(isolatedEnv({ home, base }));
    assert.ok(!('BASH_ENV' in view.env), 'BASH_ENV leaked');
    assert.ok(!('CLAUDE_ENV_FILE' in view.env), 'CLAUDE_ENV_FILE leaked');

    const raw = childView({ ...base });
    assert.equal(raw.env.BASH_ENV, '/hostile/bashenv');
    assert.equal(raw.env.CLAUDE_ENV_FILE, '/hostile/envfile');
  });

  test('unrelated vars inherited', (t) => {
    const home = tmp(t, 'gsd-6033-lang-home-');
    const base = { ...SYSTEM_VARS, LANG: 'xx_XX.UTF-8' };
    const view = childView(isolatedEnv({ home, base }));
    assert.equal(view.env.LANG, 'xx_XX.UTF-8');
  });
});

describe('isolatedEnv: key casing', () => {
  test('one PATH key regardless of casing', (t) => {
    const home = tmp(t, 'gsd-6033-path-home-');
    const env = isolatedEnv({ home, base: { Path: '/from/base', path: '/other/base' }, path: '/from/helper' });
    const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
    assert.deepEqual(pathKeys, ['PATH']);
    assert.equal(env.PATH, '/from/helper');
  });

  test('override casing wins and the base twin is removed', (t) => {
    const home = tmp(t, 'gsd-6033-case-home-');
    const env = isolatedEnv({ home, base: { lang: 'base' }, override: { LANG: 'override' } });
    const langKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'lang');
    assert.deepEqual(langKeys, ['LANG']);
    assert.equal(env.LANG, 'override');
  });

  test('property: set keys win over every casing', () => {
    const casing = (name) => fc
      .array(fc.boolean(), { minLength: name.length, maxLength: name.length })
      .map((bits) => [...name].map((c, i) => (bits[i] ? c.toUpperCase() : c.toLowerCase())).join(''));
    const home = path.resolve(os.tmpdir());
    const helperPath = path.join(home, 'helper-bin');

    fc.assert(
      fc.property(
        casing('home'),
        casing('userprofile'),
        casing('path'),
        (homeKey, profileKey, pathKey) => {
          const env = isolatedEnv({
            home,
            path: helperPath,
            base: { [homeKey]: 'base-home', [profileKey]: 'base-profile', [pathKey]: 'base-path' },
          });
          for (const [name, expected] of [['HOME', home], ['USERPROFILE', home], ['PATH', helperPath]]) {
            const keys = Object.keys(env).filter((k) => k.toLowerCase() === name.toLowerCase());
            assert.deepEqual(keys, [name]);
            assert.equal(env[name], expected);
          }
        },
      ),
      { seed: 6033, numRuns: 100 },
    );
  });
});

describe('isolatedPath', () => {
  test('isolatedPath removes a tool', (t) => {
    const home = tmp(t, 'gsd-6033-tool-home-');
    const leakDir = tmp(t, 'gsd-6033-tool-leak-');
    linkExecutable(leakDir, GSD_RUN);

    const basePath = `${leakDir}${path.delimiter}${process.env.PATH}`;
    const base = { ...SYSTEM_VARS, PATH: basePath };
    const probeScript = [
      'const r=require("node:child_process").spawnSync("gsd_run",',
      '["-e","process.stdout.write(\\"LEAK\\")"],{encoding:"utf8",timeout:Number(process.argv[1])});',
      'process.stdout.write(JSON.stringify({out:r.stdout||"",code:r.error&&r.error.code||null}))',
    ].join('');
    const args = [String(PROBE_TIMEOUT_MS)];

    const { path: cleanPath, nodeBinDir } = isolatedPath({ without: ['gsd_run'], basePath });
    t.after(() => cleanup(nodeBinDir));
    assert.ok(!cleanPath.split(path.delimiter).includes(leakDir), 'leak dir survived on the isolated PATH');

    const isolated = probe(probeScript, isolatedEnv({ home, base, path: cleanPath }), args);
    assert.notEqual(isolated.out, 'LEAK', 'isolated child resolved gsd_run');
    assert.equal(isolated.code, 'ENOENT');

    // Bypass: same probe, raw hostile PATH — the planted gsd_run IS reachable.
    const raw = probe(probeScript, { ...base }, args);
    assert.equal(raw.out, 'LEAK');
  });

  test('relative entries dropped', (t) => {
    const emptyDir = tmp(t, 'gsd-6033-rel-');
    const cases = {
      emptyElement: [`${emptyDir}${path.delimiter}${path.delimiter}${emptyDir}`, [emptyDir, emptyDir]],
      dotElement: [`${emptyDir}${path.delimiter}.${path.delimiter}${emptyDir}`, [emptyDir, emptyDir]],
      relativeElement: [`${emptyDir}${path.delimiter}sub/dir`, [emptyDir]],
    };
    for (const [label, [basePath, expected]] of Object.entries(cases)) {
      const result = isolatedPath({ without: ['gsd_run'], basePath });
      t.after(() => cleanup(result.nodeBinDir));
      assert.deepEqual(
        result.path.split(path.delimiter),
        [result.nodeBinDir, ...expected],
        `${label}: only absolute dirs may survive, got ${result.path}`,
      );
    }
  });

  test('every reachable name is filtered, not only the extensionless one', (t) => {
    // Written out rather than taken from the helper: sweeping a constant with itself cannot
    // catch that constant being wrong. bash resolves a bare gsd_run to gsd_run.exe on win32.
    const names = IS_WIN ? ['gsd_run', 'gsd_run.exe'] : ['gsd_run'];
    for (const name of names) {
      const dir = tmp(t, 'gsd-6033-name-');
      writeShellStub(dir, name);
      const result = isolatedPath({ without: ['gsd_run'], basePath: dir });
      t.after(() => cleanup(result.nodeBinDir));
      assert.ok(!result.path.split(path.delimiter).includes(dir), `${name} directory survived`);
    }
  });

  test('node survives co-location', (t) => {
    const fakeBinDir = tmp(t, 'gsd-6033-coloc-');
    const emptyDir = tmp(t, 'gsd-6033-coloc-empty-');
    writeShellStub(fakeBinDir, GSD_RUN);
    linkExecutable(fakeBinDir, NODE_BIN);

    const result = isolatedPath({
      without: ['gsd_run'],
      basePath: `${fakeBinDir}${path.delimiter}${emptyDir}`,
    });
    t.after(() => cleanup(result.nodeBinDir));

    const dirs = result.path.split(path.delimiter);
    assert.ok(!dirs.includes(fakeBinDir), 'co-located dir must be filtered');
    assert.ok(dirs.includes(result.nodeBinDir));
    fs.accessSync(path.join(result.nodeBinDir, NODE_BIN), fs.constants.X_OK);
    assert.deepEqual(fs.readdirSync(result.nodeBinDir), [NODE_BIN]);

    // A child that looks `node` up BY NAME on the candidate PATH (the runner's own
    // process.execPath never consults PATH, so it cannot prove anything here).
    const lookup = (candidatePath) => probe(
      [
        'const r=require("node:child_process").spawnSync("node",["-e","process.stdout.write(\\"OK\\")"],',
        '{encoding:"utf8",env:{PATH:process.argv[1],SystemRoot:process.env.SystemRoot},timeout:Number(process.argv[2])});',
        'process.stdout.write(JSON.stringify({out:r.stdout||"",code:r.error&&r.error.code||null}))',
      ].join(''),
      { ...SYSTEM_VARS, PATH: process.env.PATH },
      [candidatePath, String(PROBE_TIMEOUT_MS)],
    );

    // The prepended dir is what keeps `node` resolvable for a child.
    assert.equal(lookup(result.path).out, 'OK', `node lookup failed on ${result.path}`);

    // Bypass: the same filtered dirs WITHOUT the prepended node dir — the directory
    // node was co-located with gsd_run in is gone, so the lookup must fail.
    const withoutNodeDir = dirs.filter((dir) => dir !== result.nodeBinDir).join(path.delimiter);
    const bypass = lookup(withoutNodeDir);
    assert.notEqual(bypass.out, 'OK', 'node resolved without the prepended node dir');
    assert.equal(bypass.code, 'ENOENT');
  });

  test('a fully filtered PATH leaves only the node dir', (t) => {
    const leakDir = tmp(t, 'gsd-6033-full-');
    writeShellStub(leakDir, GSD_RUN);
    const result = isolatedPath({ without: ['gsd_run'], basePath: leakDir });
    t.after(() => cleanup(result.nodeBinDir));
    assert.deepEqual(result.path.split(path.delimiter), [result.nodeBinDir]);
  });

  test('rejects empty without', () => {
    assert.throws(() => isolatedPath());
    assert.throws(() => isolatedPath({}));
    assert.throws(() => isolatedPath({ without: [] }));
    assert.throws(() => isolatedPath({ without: undefined, basePath: os.tmpdir() }));
  });
});

describe('createHermeticRoot: ancestor config discovery', () => {
  const MODEL_PROBE = [
    'const lib=require(process.argv[1]);',
    // No homedir option: the resolver reads the home from the child's own environment.
    'const out=lib.readGsdEffectiveAgentTools(process.argv[2]);',
    'process.stdout.write(JSON.stringify(out))',
  ].join('');
  const EFFORT_PROBE = [
    'const lib=require(process.argv[1]);',
    'process.stdout.write(JSON.stringify(lib.readGsdEffectiveEffortConfig(process.argv[2])))',
  ].join('');

  function readTools(dir, home) {
    return probe(MODEL_PROBE, isolatedEnv({ home }), [MODEL_RESOLVER, dir]);
  }

  /** Bypass: the same probe, but the child's HOME/USERPROFILE come from a raw (un-isolated) merge. */
  function readToolsRaw(dir, home) {
    return probe(MODEL_PROBE, { ...SYSTEM_VARS, ...homePair(home) }, [MODEL_RESOLVER, dir]);
  }

  function ancestorWithTools(t) {
    const root = tmp(t, 'gsd-6033-anc-');
    fs.mkdirSync(path.join(root, '.planning'));
    fs.writeFileSync(
      path.join(root, '.planning', 'config.json'),
      JSON.stringify({ agent_tools: { '*': ['mcp__proof__*'] } }),
    );
    return root;
  }

  /** Make `distance - 1` intermediate dirs under root; returns the parent of a fixture `distance` below root. */
  function parentAtDistance(root, distance) {
    let dir = root;
    for (let i = 0; i < distance - 1; i += 1) {
      dir = path.join(dir, `d${i}`);
      fs.mkdirSync(dir);
    }
    return dir;
  }

  const DISTANCES = [
    ['limit-1', MAX_REACHABLE_DISTANCE - 1, true],
    ['limit', MAX_REACHABLE_DISTANCE, true],
    ['limit+1', MAX_REACHABLE_DISTANCE + 1, false],
  ];

  test('discovery stops inside hermetic root', (t) => {
    const home = tmp(t, 'gsd-6033-disc-home-');
    for (const [label, distance, reachable] of DISTANCES) {
      const root = ancestorWithTools(t);
      const parent = parentAtDistance(root, distance);

      const hermetic = createHermeticRoot('gsd-6033-hermetic-', { parent });
      assert.equal(readTools(hermetic, home), null, `${label}: hermetic root leaked ancestor tools`);

      // Bypass: a plain mkdtemp fixture at the same distance. Reaches the ancestor iff the
      // distance is within the walk bound, proving the probe can see the leak.
      const plain = fs.mkdtempSync(path.join(parent, 'plain-'));
      const seen = readTools(plain, home);
      if (reachable) {
        assert.ok(seen && JSON.stringify(seen).includes('mcp__proof__*'), `${label}: plain dir should reach the ancestor`);
      } else {
        assert.equal(seen, null, `${label}: walk bound is ${WALK_PROBES} probes`);
      }
    }
  });

  test('nested worktree positive control', (t) => {
    const outer = tmp(t, 'gsd-6033-outer-');
    const git = (args, cwd) => gitOrThrow(args, { cwd, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    git(['init', '-q'], outer);
    git(['config', 'user.name', 'gsd-test'], outer);
    git(['config', 'user.email', 'gsd-test@example.invalid'], outer);
    git(['config', 'commit.gpgsign', 'false'], outer);
    fs.writeFileSync(path.join(outer, 'README.md'), '# outer\n');
    git(['add', 'README.md'], outer);
    git(['commit', '-q', '-m', 'init'], outer);

    const worktree = path.join(outer, '.worktrees', 'wt');
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(['worktree', 'add', '-q', '-b', 'wt', worktree], outer);

    fs.mkdirSync(path.join(outer, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(outer, '.planning', 'config.json'),
      JSON.stringify({ agent_tools: { '*': ['mcp__proof__*'] } }),
    );
    fs.mkdirSync(path.join(outer, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(outer, '.claude', 'settings.local.json'),
      JSON.stringify({ mcpServers: { ancestor_settings: { command: 'proof-server' } } }),
    );

    const realLookingHome = tmp(t, 'gsd-6033-real-home-');
    fs.mkdirSync(path.join(realLookingHome, '.gsd'));
    fs.writeFileSync(
      path.join(realLookingHome, '.gsd', 'defaults.json'),
      JSON.stringify({ agent_tools: { 'gsd-planner': ['mcp__home__*'] } }), // '*' would be shadowed by the project '*' ({...global,...project}, install-model-override-resolver.cts:175)
    );
    const emptyHome = tmp(t, 'gsd-6033-empty-home-');

    const hermetic = createHermeticRoot('gsd-6033-wt-hermetic-', { parent: worktree });
    t.after(() => cleanup(hermetic));
    const sealed = readTools(hermetic, emptyHome);
    assert.equal(sealed, null);
    assert.ok(!JSON.stringify(sealed).includes('mcp__ancestor_settings__'));

    // Bypass: plain dir inside the worktree + a real-looking home (raw env merge) leaks
    // both sources.
    const plain = fs.mkdtempSync(path.join(worktree, 'plain-'));
    t.after(() => cleanup(plain));
    const leaked = JSON.stringify(readToolsRaw(plain, realLookingHome));
    assert.ok(leaked.includes('mcp__proof__*'), `project config not visible: ${leaked}`);
    assert.ok(leaked.includes('mcp__home__*'), `home defaults not visible: ${leaked}`);
    // The resolver never reads .claude/settings.local.json, so the ancestor's mcpServers
    // entry is invisible on both sides.
    assert.ok(!leaked.includes('mcp__ancestor_settings__'), `settings.local.json was read: ${leaked}`);
  });

  test('sentinel is neutral', (t) => {
    const home = tmp(t, 'gsd-6033-neutral-home-');
    const root = createHermeticRoot('gsd-6033-neutral-');
    t.after(() => cleanup(root));

    assert.ok(path.isAbsolute(root));
    assert.ok(path.basename(root).startsWith('gsd-6033-neutral-'));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, '.planning', 'config.json'), 'utf8')),
      {},
    );

    const env = isolatedEnv({ home });
    assert.equal(readTools(root, home), null);
    assert.equal(probe(EFFORT_PROBE, env, [EFFORT_RESOLVER, root]), null);

    // A test that needs its own config at the root overwrites the sentinel and it is honored.
    fs.writeFileSync(
      path.join(root, '.planning', 'config.json'),
      JSON.stringify({ effort: { default: 'high' } }),
    );
    const effort = probe(EFFORT_PROBE, env, [EFFORT_RESOLVER, root]);
    assert.ok(effort && effort.default === 'high', `overwritten config not read: ${JSON.stringify(effort)}`);
  });

  test('parent option places the root under the given directory', (t) => {
    const parent = tmp(t, 'gsd-6033-parent-');
    const root = createHermeticRoot('gsd-6033-child-', { parent });
    assert.equal(path.dirname(root), parent);
  });
});
