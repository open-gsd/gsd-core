'use strict';

/**
 * #4020 — the runner's run-scoped temp root.
 *
 * Fixture trees leak under os.tmpdir() on the success path; on a tmpfs /tmp a full
 * `npm test` exhausts the filesystem and the failure surfaces as misleading EDQUOT
 * (-122) copyfile errors in whichever suite runs next. The fix bounds the run: a
 * dedicated `gsd-test-run-*` root repointed via TMPDIR (so every child's
 * mkdtempSync(os.tmpdir()) lands inside it), a sweep between chunks that spares the
 * two reserved sandboxes, a leak-count fail-fast, and removal on exit.
 *
 * Unit rows exercise the runner's exported helpers in-process (the harness
 * convention); the spawn row drives the real CLI.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const { runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const RUNNER = path.join(__dirname, '..', 'scripts', 'run-tests.cjs');

/**
 * A `node -e` snippet that requires `scripts/run-tests.cjs` and calls one of
 * its exported functions in an isolated child process, purely so the call
 * doesn't poison the PARENT process's own os.tmpdir() resolution for every
 * other subtest. No subprocess fan-out beneath the single node child.
 * Coincides numerically with GENERATOR_SCRIPT_TIMEOUT_MS, BUILD_TIMEOUT_MS,
 * and others in tests/helpers/timeouts.cjs, none of which describe this
 * shape (scripts/run-tests.cjs is the test runner itself, not a generator/
 * lint script, a hooks bundle, or a git plumbing call) -- kept file-local
 * and separately named rather than forced onto an unrelated shared norm.
 */
const RUN_TESTS_ISOLATED_PROBE_TIMEOUT_MS = 30000;

/**
 * A REAL end-to-end spawn of scripts/run-tests.cjs itself, running one
 * trivial test file through its full lifecycle (temp-root setup, discovery,
 * execution, sweep, teardown) -- heavier than
 * RUN_TESTS_ISOLATED_PROBE_TIMEOUT_MS above, which only calls one exported
 * function in isolation. Coincides numerically with INSTALL_TIMEOUT_MS (a
 * full bin/install.js run) but describes a completely unrelated operation
 * -- disclosed, not merged.
 */
const RUN_TESTS_HARNESS_SPAWN_TIMEOUT_MS = 120000;

/**
 * The environment for a REAL nested run-tests spawn rooted at `sandbox`. This file runs as a
 * test-file child, so NODE_TEST_CONTEXT is set; a nested `node --test` that inherits it refuses to
 * run any file ("run() is being called recursively within a test file. skipping running files"),
 * executes nothing and exits 0 with no report. The runner now FAILS such a chunk (its accounting
 * evidence is unreadable, #5170), so the nested spawn clears the context like
 * tests/run-tests-harness.test.cjs does and the probe file really runs.
 */
function nestedRunnerEnv(sandbox) {
  const env = { ...process.env, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox };
  delete env.NODE_TEST_CONTEXT;
  delete env.GSD_RUN_TESTS_LEDGER_FILE;
  delete env.GSD_RUN_TESTS_EVENTS_FILE;
  return env;
}

describe('#4020 — run-tests temp root', () => {
  // setupRunTempRoot mutates the PROCESS env (TMPDIR/TEMP/TMP), so these rows
  // drive it in an isolated child — an in-process call would poison every other
  // subtest's os.tmpdir() resolution (observed: ENOENT cascades in the bench).
  const setupProbe = `
    const runner = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'run-tests.cjs'))});
    const root = runner.setupRunTempRoot();
    console.log(JSON.stringify({
      root,
      base: require('path').basename(root),
      parent: require('path').dirname(root),
      TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    }));
  `;

  test('setupRunTempRoot creates a dedicated run temp root and repoints the env', (t) => {
    const outer = createTempDir('gsd-4020-outer-');
    t.after(() => cleanup(outer));

    const r = runNode(['-e', setupProbe], {
      timeoutMs: RUN_TESTS_ISOLATED_PROBE_TIMEOUT_MS,
      env: { ...process.env, TMPDIR: outer, TEMP: outer, TMP: outer },
    });
    assert.equal(r.exitCode, 0, `probe failed: ${r.stderr.slice(-300)}`);
    const out = JSON.parse(r.stdout.trim().split(/\n/).pop());
    assert.ok(out.base.startsWith('gsd-test-run-'),
      'the root is a gsd-test-run-* directory, so a sweep is scoped to it');
    assert.equal(out.parent, outer,
      'the root lives INSIDE the operator-provided TMPDIR, preserving the workaround');
    assert.equal(out.TMPDIR, out.root, 'TMPDIR is repointed so children allocate inside the root');
    assert.equal(out.TEMP, out.root, 'TEMP repointed (Windows children read TEMP, not TMPDIR)');
    assert.equal(out.TMP, out.root, 'TMP repointed (Windows fallback)');
    cleanup(out.root);
  });

  test('setupRunTempRoot is idempotent for nested run-tests spawns', (t) => {
    // Mirrors the GSD_HOME sandbox contract: a nested run-tests spawn (the harness
    // regression test) inherits the root via env and must REUSE it, never mkdtemp a
    // fresh root per invocation.
    const probe = setupProbe.replace('const root = runner.setupRunTempRoot();',
      'const first = runner.setupRunTempRoot(); const root = runner.setupRunTempRoot(); console.error(JSON.stringify({ reuse: root === first }));');
    const outer = createTempDir('gsd-4020-idem-');
    t.after(() => cleanup(outer));

    const r = runNode(['-e', probe], {
      timeoutMs: RUN_TESTS_ISOLATED_PROBE_TIMEOUT_MS,
      env: { ...process.env, TMPDIR: outer, TEMP: outer, TMP: outer },
    });
    assert.equal(r.exitCode, 0, `probe failed: ${r.stderr.slice(-300)}`);
    assert.ok(JSON.parse(r.stderr.trim().split('\n').pop()).reuse === true,
      'a second invocation with the root active reuses it');
  });

  test('sweepRunTempRoot removes leaked fixtures and spares the reserved sandboxes', (t) => {
    const runner = require('../scripts/run-tests.cjs');
    assert.equal(typeof runner.sweepRunTempRoot, 'function',
      'the runner must export sweepRunTempRoot for in-process verification');
    const root = createTempDir('gsd-test-run-sweep-');
    t.after(() => cleanup(root));
    for (const name of ['gsd-2930-overlay-a', 'gsd-slurm-b', 'spec-section-c', 'unprefixed-d']) {
      fs.mkdirSync(path.join(root, name));
    }
    fs.mkdirSync(path.join(root, 'gsd-test-home-keep'));
    fs.writeFileSync(path.join(root, 'gsd-run-tests-events-keep'), '');

    const removed = runner.sweepRunTempRoot(root);
    assert.equal(removed, 4, 'exactly the four leaked fixture entries are removed');
    for (const name of ['gsd-2930-overlay-a', 'gsd-slurm-b', 'spec-section-c', 'unprefixed-d']) {
      assert.ok(!fs.existsSync(path.join(root, name)), `${name} removed`);
    }
    assert.ok(fs.existsSync(path.join(root, 'gsd-test-home-keep')),
      'the GSD_HOME sandbox survives the sweep (nested-spawn reuse contract)');
    assert.ok(fs.existsSync(path.join(root, 'gsd-run-tests-events-keep')),
      'the events dir survives the sweep (timeout diagnostics)');

    // #4020 CI fix: ancestors of the runner's own selected files must survive —
    // the harness stages synthetic test files under the temp root and later
    // chunks still need them (tests/run-tests-harness.test.cjs #3597).
    for (const name of ['gsd-leak-x', 'gsd-leak-y']) fs.mkdirSync(path.join(root, name));
    const protectedSwept = runner.sweepRunTempRoot(root, new Set([path.join(root, 'gsd-leak-x')]));
    assert.equal(protectedSwept, 1, 'only the unprotected entry is removed');
    assert.ok(fs.existsSync(path.join(root, 'gsd-leak-x')), 'the protected entry survives');
    assert.ok(!fs.existsSync(path.join(root, 'gsd-leak-y')), 'the unprotected entry is removed');
  });

  test('the leak guard fails fast naming the leaked roots', (t) => {
    const runner = require('../scripts/run-tests.cjs');
    assert.equal(typeof runner.assertTempRootBounded, 'function',
      'the runner must export assertTempRootBounded for in-process verification');
    const root = createTempDir('gsd-test-run-guard-');
    t.after(() => cleanup(root));
    // Boundary: at the limit it passes (limit-1 and limit), at limit+1 it throws.
    for (let i = 0; i < 3; i++) fs.mkdirSync(path.join(root, `gsd-leak-${i}`));

    assert.doesNotThrow(() => runner.assertTempRootBounded(root, 3), 'residue at the limit passes');
    assert.throws(
      () => runner.assertTempRootBounded(root, 2),
      (err) => /temp root leak/i.test(err.message) && err.message.includes('gsd-leak-0'),
      'one over the limit throws a message naming the leaked roots (not EDQUOT)');
  });

  test('the runner removes its temp root on exit', (t) => {
    const sandbox = createTempDir('gsd-4020-spawn-');
    t.after(() => cleanup(sandbox));
    // A single trivial real test file so the runner has work to do and exits 0.
    const target = path.join(__dirname, 'helpers-4020-probe.test.cjs');
    fs.writeFileSync(target, "require('node:test').test('noop #4020', () => {});\n");
    // A single file in the repo tree, not a temp dir — cleanup() refuses
    // out-of-temp-root paths by design, so unlink it directly.
    t.after(() => fs.unlinkSync(target));

    const r = runNode(
      [RUNNER, '--files', path.basename(target)],
      { timeoutMs: RUN_TESTS_HARNESS_SPAWN_TIMEOUT_MS, env: nestedRunnerEnv(sandbox) },
    );
    assert.equal(r.exitCode, 0, `runner should pass: ${r.stderr.slice(-400)}`);
    const m = /tmp-root=(\S+)/.exec(r.stderr);
    assert.ok(m, 'runner stderr must announce its temp root');
    assert.ok(m[1].startsWith(sandbox), 'the announced root lives inside the sandboxed TMPDIR');
    assert.ok(!fs.existsSync(m[1]), 'the temp root is removed after the run');
  });

  test('a nested runner reuses an inherited root and never removes it', (t) => {
    // #4020 review: the harness regression test spawns run-tests INSIDE a live
    // run — the nested process must reuse the outer root and leave it standing
    // on ITS exit, or the outer suite mass-ENOENTs every later fixture.
    const inherited = createTempDir('gsd-test-run-inherited');
    t.after(() => cleanup(inherited));
    const target = path.join(__dirname, 'helpers-4020-probe.test.cjs');
    fs.writeFileSync(target, "require('node:test').test('noop #4020 nested', () => {});\n");
    // A single file in the repo tree, not a temp dir — cleanup() refuses
    // out-of-temp-root paths by design, so unlink it directly.
    t.after(() => fs.unlinkSync(target));

    const r = runNode(
      [RUNNER, '--files', path.basename(target)],
      { timeoutMs: RUN_TESTS_HARNESS_SPAWN_TIMEOUT_MS, env: nestedRunnerEnv(inherited) },
    );
    assert.equal(r.exitCode, 0, `nested runner should pass: ${r.stderr.slice(-400)}`);
    const m = /tmp-root=(\S+)/.exec(r.stderr);
    assert.ok(m, 'nested runner announces its root');
    assert.equal(m[1], inherited, 'the nested runner REUSES the inherited root');
    // The sweep may legitimately clean the root's CONTENTS between chunks; the
    // property under test is that the nested runner never rmSyncs the root ITSELF.
    assert.ok(fs.existsSync(inherited), 'the inherited root survives the nested runner\'s exit');
    // OWNER-ONLY SWEEP: the nested runner runs while the OUTER chunk's sibling
    // test files may be live — it must not sweep THEIR fixtures out from under
    // them (macOS CI: template.test.cjs lost its plan file to exactly that).
    const sibling = path.join(inherited, 'gsd-sibling-live-fixture');
    fs.mkdirSync(sibling);
    const r2 = runNode(
      [RUNNER, '--files', path.basename(target)],
      { timeoutMs: RUN_TESTS_HARNESS_SPAWN_TIMEOUT_MS, env: nestedRunnerEnv(inherited) },
    );
    assert.equal(r2.exitCode, 0, `second nested runner should pass: ${r2.stderr.slice(-300)}`);
    assert.ok(fs.existsSync(sibling),
      'a nested runner never sweeps the shared root — sibling fixtures survive');
  });

  describe('#5688 — relative TMPDIR yields absolute temp paths', () => {
    // In-process: env + cwd are saved and restored in finally, and the whole
    // sandbox is removed by the caller. os.tmpdir() reads the env on every call.
    const runner = require('../scripts/run-tests.cjs');
    const { createFixture } = require('./fixtures/index.cjs');

    // os.tmpdir() reads TMPDIR on POSIX but TEMP then TMP on Windows, so TEMP and
    // TMP default to the TMPDIR value when the key is absent: the relative value
    // must reach every variable os.tmpdir() consults on the current platform.
    // An explicit `temp: undefined` / `tmp: undefined` means unset.
    function withTmpEnv(opts, fn) {
      const { cwd, tmpdir } = opts;
      const temp = 'temp' in opts ? opts.temp : tmpdir;
      const tmp = 'tmp' in opts ? opts.tmp : tmpdir;
      const keys = ['TMPDIR', 'TEMP', 'TMP'];
      const savedEnv = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      const savedCwd = process.cwd();
      try {
        process.chdir(cwd);
        const want = { TMPDIR: tmpdir, TEMP: temp, TMP: tmp };
        for (const k of keys) {
          if (want[k] === undefined) delete process.env[k];
          else process.env[k] = want[k];
        }
        return fn();
      } finally {
        process.chdir(savedCwd);
        for (const k of keys) {
          if (savedEnv[k] === undefined) delete process.env[k];
          else process.env[k] = savedEnv[k];
        }
      }
    }

    function sandboxWithRel(t, rel) {
      const base = createTempDir('gsd-5688-');
      t.after(() => cleanup(base));
      fs.mkdirSync(path.join(base, rel), { recursive: true });
      return base;
    }

    test('#5688: setupRunTempRoot resolves relative TMPDIR to absolute', (t) => {
      const base = sandboxWithRel(t, 'reltmp');
      withTmpEnv({ cwd: base, tmpdir: 'reltmp' }, () => {
        const expectedParent = path.resolve('reltmp');
        const root = runner.setupRunTempRoot();
        assert.ok(path.isAbsolute(root), `root must be absolute, got ${root}`);
        assert.equal(path.dirname(root), expectedParent);
        for (const k of ['TMPDIR', 'TEMP', 'TMP']) {
          assert.equal(process.env[k], root, `${k} exported absolute`);
        }
      });
    });

    test('#5688: createFixture returns absolute dir under relative TMPDIR', (t) => {
      const base = sandboxWithRel(t, 'reltmp');
      withTmpEnv({ cwd: base, tmpdir: 'reltmp' }, () => {
        const dir = createFixture({ planning: false });
        assert.ok(path.isAbsolute(dir), `fixture must be absolute, got ${dir}`);
        assert.equal(path.dirname(dir), path.resolve('reltmp'));
      });
    });

    test('#5688: absolute TMPDIR redirect preserved', (t) => {
      const base = createTempDir('gsd-5688-abs-');
      t.after(() => cleanup(base));
      const outer = path.join(base, 'outer');
      fs.mkdirSync(outer);
      withTmpEnv({ cwd: base, tmpdir: outer }, () => {
        const root = runner.setupRunTempRoot();
        assert.equal(path.dirname(root), outer, 'absolute base is byte-identical (no realpath)');
        assert.equal(createFixture({ planning: false }).startsWith(root + path.sep), true);
      });
    });

    test('#5688: dot TMPDIR resolves to cwd', (t) => {
      const base = createTempDir('gsd-5688-dot-');
      t.after(() => cleanup(base));
      withTmpEnv({ cwd: base, tmpdir: '.' }, () => {
        const cwd = process.cwd();
        const root = runner.setupRunTempRoot();
        assert.ok(path.isAbsolute(root));
        assert.equal(path.dirname(root), cwd);
      });
    });

    describe('#5688 — variables follow os.tmpdir() per platform (injected env)', () => {
      // The seam takes an env object, a tmpdir function and a platform, so these
      // rows are host-independent: no process.env mutation, no reliance on the
      // host's os.tmpdir(). POSIX reads TMPDIR only; win32 reads TEMP then TMP.
      function twoDirs(t) {
        const base = createTempDir('gsd-5688-order-');
        t.after(() => cleanup(base));
        const a = path.join(base, 'a');
        const b = path.join(base, 'b');
        const fallback = path.join(base, 'fallback');
        for (const d of [a, b, fallback]) fs.mkdirSync(d);
        return { a, b, fallback };
      }

      function run(platform, env, fallback) {
        return runner.setupRunTempRoot({ env, tmpdirFn: () => fallback, platform });
      }

      function runRootIn(dir, name) {
        const root = path.join(dir, `gsd-test-run-${name}`);
        fs.mkdirSync(root);
        return root;
      }

      test('#5688: parent equals resolve(os.tmpdir()) of the same child env on this platform', (t) => {
        const { a, b, fallback } = twoDirs(t);
        // Roots under this test's own dirs (twoDirs' base) are removed by twoDirs.
        // A root that lands elsewhere (the real system temp, e.g. %SystemRoot%\temp
        // on win32, outside the parent's cleanup helper) is removed by the CHILD
        // after it reports the root. A child that is killed or times out before
        // that point can still leave its root behind.
        // The child removes ONLY a fresh root it created (parent === want). An
        // inherited root (root === want) is never removed: on win32 libuv's spawn
        // (process.c make_program_env) re-adds TEMP, SYSTEMROOT etc. from the
        // PARENT's environment when the env object given to spawn omits them, so
        // a combo without TEMP still sees the parent's TEMP, which in a gsd-test
        // run is the live outer run root. The child therefore inherits it, and
        // deleting it would destroy the outer run's temp root.
        const ownDirs = path.dirname(a) + path.sep;
        const parentTmp = path.resolve(os.tmpdir());
        const script = `
          const os = require('node:os');
          const path = require('node:path');
          const fs = require('node:fs');
          const want = path.resolve(os.tmpdir());
          const runner = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'run-tests.cjs'))});
          const root = runner.setupRunTempRoot();
          process.stdout.write(JSON.stringify({ want, root }));
          if (path.dirname(root) === want &&
              path.basename(root).startsWith('gsd-test-run-') &&
              !root.startsWith(process.env.GSD_5688_OWN_DIRS)) {
            fs.rmSync(root, { recursive: true, force: true });
          }
        `;
        const runRoot = runRootIn(a, 'parity5688');
        const inheritKey = process.platform === 'win32' ? 'TEMP' : 'TMP';
        const combos = [
          { env: { TMPDIR: a, TMP: b, TEMP: fallback } },
          { env: { TMPDIR: a } },
          { env: { TMP: b, TEMP: fallback } },
          { env: { TEMP: fallback } },
          { env: { TMPDIR: '', TMP: '', TEMP: fallback } },
          { env: {} },
          // The highest-precedence set variable is a run root: inherited, not a parent.
          { env: { [inheritKey]: runRoot }, inherited: true },
        ];
        for (const { env: combo, inherited } of combos) {
          const env = { ...process.env };
          for (const k of Object.keys(env)) {
            if (['TMPDIR', 'TEMP', 'TMP'].includes(k.toUpperCase())) delete env[k];
          }
          Object.assign(env, combo, { GSD_5688_OWN_DIRS: ownDirs });
          const r = runNode(['-e', script], {
            timeoutMs: RUN_TESTS_ISOLATED_PROBE_TIMEOUT_MS,
            env,
          });
          assert.equal(r.exitCode, 0, `${JSON.stringify(combo)}: ${String(r.stderr).slice(-300)}`);
          const { want, root } = JSON.parse(r.stdout);
          // Expected inheritance is derived from the platform contract, not from what
          // the child reports. POSIX: only a run root in the set variable is
          // inherited. win32: additionally, a combo without TEMP gets the PARENT's
          // TEMP re-added by libuv, so it inherits iff the parent's os.tmpdir() is
          // itself a run root (true under gsd-test).
          const parentIsRunRoot = path.basename(parentTmp).startsWith('gsd-test-run-');
          const libuvReaddsTemp = process.platform === 'win32' && !('TEMP' in combo);
          const expectInherit = Boolean(inherited) || (libuvReaddsTemp && parentIsRunRoot);
          const childInherits = path.basename(want).startsWith('gsd-test-run-');
          assert.equal(childInherits, expectInherit, `unexpected inheritance for ${JSON.stringify(combo)}`);
          if (inherited || childInherits) {
            assert.equal(root, want, `inherited root expected for ${JSON.stringify(combo)}`);
          } else {
            assert.equal(path.dirname(root), want, `parent mismatch for ${JSON.stringify(combo)}`);
          }
        }
        // Safety: no child may have removed the parent's own temp root.
        assert.ok(fs.existsSync(parentTmp), `parent temp root removed: ${parentTmp}`);
        assert.ok(fs.existsSync(runRoot), `inherited run root removed: ${runRoot}`);
      });

      describe('linux (TMPDIR, then TMP, then TEMP)', () => {
        test('#5688: TMPDIR (not a run root) is the parent, TEMP ignored', (t) => {
          const { a, b, fallback } = twoDirs(t);
          const env = { TMPDIR: a, TEMP: b };
          const root = run('linux', env, fallback);
          assert.equal(path.dirname(root), path.resolve(a));
          for (const k of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(env[k], root);
        });

        test('#5688: unset TMPDIR falls to TMP before TEMP', (t) => {
          const { a, b, fallback } = twoDirs(t);
          const root = run('linux', { TMP: a, TEMP: b }, fallback);
          assert.equal(path.dirname(root), path.resolve(a));
        });

        test('#5688: TMPDIR and TMP unset falls to TEMP', (t) => {
          const { b, fallback } = twoDirs(t);
          const root = run('linux', { TEMP: b }, fallback);
          assert.equal(path.dirname(root), path.resolve(b));
        });

        test('#5688: empty TMPDIR falls to TMP', (t) => {
          const { a, b, fallback } = twoDirs(t);
          const root = run('linux', { TMPDIR: '', TMP: a, TEMP: b }, fallback);
          assert.equal(path.dirname(root), path.resolve(a));
        });

        test('#5688: all variables empty or unset use tmpdirFn', (t) => {
          const { fallback } = twoDirs(t);
          const root = run('linux', { TMPDIR: '', TMP: '', TEMP: '' }, fallback);
          assert.equal(path.dirname(root), path.resolve(fallback));
        });

        test('#5688: a run root in TMP is inherited when TMPDIR is unset', (t) => {
          const { a, b, fallback } = twoDirs(t);
          const inheritedRoot = runRootIn(a, 'tmp5688');
          const env = { TMP: inheritedRoot, TEMP: b };
          assert.equal(run('linux', env, fallback), inheritedRoot);
          for (const k of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(env[k], inheritedRoot);
        });

        test('#5688: a run root in TEMP is inherited when TMPDIR and TMP are unset', (t) => {
          const { a, fallback } = twoDirs(t);
          const inheritedRoot = runRootIn(a, 'temp5688');
          const env = { TEMP: inheritedRoot };
          assert.equal(run('linux', env, fallback), inheritedRoot);
          for (const k of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(env[k], inheritedRoot);
        });

        test('#5688: TMPDIR run root is inherited', (t) => {
          const { a, b, fallback } = twoDirs(t);
          const inheritedRoot = runRootIn(a, 'linux5688');
          const env = { TMPDIR: inheritedRoot, TEMP: b };
          assert.equal(run('linux', env, fallback), inheritedRoot);
          for (const k of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(env[k], inheritedRoot);
        });

        test('#5688: a run root in TEMP is not inherited', (t) => {
          const { a, b, fallback } = twoDirs(t);
          const stale = runRootIn(b, 'stale5688');
          const root = run('linux', { TMPDIR: a, TEMP: stale }, fallback);
          assert.notEqual(root, stale);
          assert.equal(path.dirname(root), path.resolve(a));
        });
      });

      describe('win32 (TEMP then TMP)', () => {
        test('#5688: TEMP is the parent, TMPDIR ignored', (t) => {
          const { b, fallback } = twoDirs(t);
          const env = { TMPDIR: '/tmp', TEMP: b };
          const root = run('win32', env, fallback);
          assert.equal(path.dirname(root), path.resolve(b));
          for (const k of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(env[k], root);
        });

        test('#5688: unset TEMP falls to TMP', (t) => {
          const { a, fallback } = twoDirs(t);
          const root = run('win32', { TMP: a }, fallback);
          assert.equal(path.dirname(root), path.resolve(a));
        });

        test('#5688: empty TEMP falls to TMP', (t) => {
          const { a, fallback } = twoDirs(t);
          const root = run('win32', { TEMP: '', TMP: a }, fallback);
          assert.equal(path.dirname(root), path.resolve(a));
        });

        test('#5688: TEMP run root is inherited', (t) => {
          const { a, b, fallback } = twoDirs(t);
          const inheritedRoot = runRootIn(a, 'win5688');
          const env = { TEMP: inheritedRoot, TMP: b };
          assert.equal(run('win32', env, fallback), inheritedRoot);
          for (const k of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(env[k], inheritedRoot);
        });

        test('#5688: a run root in TMPDIR is not inherited', (t) => {
          const { a, b, fallback } = twoDirs(t);
          const stale = runRootIn(a, 'stale5688');
          const root = run('win32', { TMPDIR: stale, TEMP: b }, fallback);
          assert.notEqual(root, stale);
          assert.equal(path.dirname(root), path.resolve(b));
        });

        test('#5688: all variables empty or unset use tmpdirFn', (t) => {
          const { fallback } = twoDirs(t);
          const root = run('win32', { TEMP: '', TMP: '' }, fallback);
          assert.equal(path.dirname(root), path.resolve(fallback));
        });
      });
    });

    for (const [label, tmpdir] of [['empty', ''], ['unset', undefined]]) {
      test(`#5688: ${label} TMPDIR yields absolute root`, (t) => {
        const base = createTempDir('gsd-5688-def-');
        t.after(() => cleanup(base));
        withTmpEnv({ cwd: base, tmpdir }, () => {
          const root = runner.setupRunTempRoot();
          try {
            assert.ok(path.isAbsolute(root), `root must be absolute, got ${root}`);
            assert.ok(path.isAbsolute(process.env.TMPDIR));
          } finally {
            cleanup(root);
          }
        });
      });
    }

    test('#5688: inherited relative run root exported absolute', (t) => {
      const rel = 'gsd-test-run-inherited5688';
      const base = sandboxWithRel(t, rel);
      withTmpEnv({ cwd: base, tmpdir: rel }, () => {
        const expected = path.resolve(rel);
        const root = runner.setupRunTempRoot();
        assert.equal(root, expected, 'the inherited root is reused, resolved');
        assert.ok(path.isAbsolute(root));
        for (const k of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(process.env[k], expected);
        assert.ok(fs.existsSync(expected), 'the reused root is not removed');
      });
    });

    test('#5688: child with changed cwd sees same temp dir', (t) => {
      const base = sandboxWithRel(t, 'reltmp');
      const elsewhere = createTempDir('gsd-5688-elsewhere-');
      t.after(() => cleanup(elsewhere));
      withTmpEnv({ cwd: base, tmpdir: 'reltmp' }, () => {
        const root = runner.setupRunTempRoot();
        const r = runNode(['-e', 'process.stdout.write(require("os").tmpdir())'], {
          timeoutMs: RUN_TESTS_ISOLATED_PROBE_TIMEOUT_MS,
          cwd: elsewhere,
          env: { ...process.env },
        });
        assert.equal(r.exitCode, 0, r.stderr.slice(-300));
        assert.ok(path.isAbsolute(r.stdout), `child tmpdir must be absolute, got ${r.stdout}`);
        assert.equal(r.stdout, root, 'the child resolves the parent\'s root, not a cwd-relative one');
        assert.ok(fs.existsSync(path.resolve(elsewhere, r.stdout)),
          'the dir exists when resolved from the child\'s cwd');
      });
    });

    test('#5688: runner and fixtures temp base parity', (t) => {
      const base = sandboxWithRel(t, 'reltmp');
      withTmpEnv({ cwd: base, tmpdir: 'reltmp' }, () => {
        const fixtureParent = path.dirname(createFixture({ planning: false }));
        const runnerParent = path.dirname(runner.setupRunTempRoot());
        assert.equal(fixtureParent, runnerParent);
      });
    });

    test('#5688: prop: any relative TMPDIR yields absolute root', (t) => {
      const base = createTempDir('gsd-5688-prop-');
      t.after(() => cleanup(base));
      const segment = fc.stringMatching(/^[a-z0-9]{1,8}$/);
      fc.assert(
        fc.property(
          fc.array(segment, { minLength: 1, maxLength: 3 }),
          fc.option(segment, { nil: undefined }),
          (segments, runSuffix) => {
          // runSuffix generated => last segment is an inherited run root (gsd-test-run-*)
          const rel = (runSuffix === undefined ? segments : [...segments, `gsd-test-run-${runSuffix}`]).join('/');
          fs.mkdirSync(path.join(base, rel), { recursive: true });
          withTmpEnv({ cwd: base, tmpdir: rel }, () => {
            const expectedParent = path.resolve(rel);
            const root = runner.setupRunTempRoot();
            const dir = createFixture({ planning: false });
            assert.ok(path.isAbsolute(root));
            assert.ok(path.isAbsolute(dir));
            if (runSuffix !== undefined) {
              assert.equal(root, expectedParent);
            } else {
              assert.equal(path.dirname(root), expectedParent);
            }
            assert.ok(path.basename(root).startsWith('gsd-test-run-'));
          });
          },
        ),
        { seed: 5688, numRuns: 25 },
      );
    });
  });

  describe('#4220 — computeSweepProtectSet ancestor-walk termination', () => {
    // The original inline block stopped the ancestor walk on
    // `cur !== runTempRoot && cur.length > 1`, a POSIX-only sentinel:
    // path.posix.dirname('/') === '/' (length 1) correctly stops, but
    // path.win32.dirname('C:\\') === 'C:\\' (length 3) never satisfies a
    // length check — dirname returns the SAME string forever, so the loop
    // never terminates on Windows whenever a selected file lives outside
    // runTempRoot (the common case: most selected test files are in the repo
    // checkout, not the temp root). This bounds every assertion below with a
    // hard iteration cap so a genuinely-hanging implementation fails FAST in
    // this test run rather than wedging the suite.
    const HARD_ITERATION_CAP = 10_000;

    // A dirnameImpl wrapper that throws once it has been called more times
    // than a real ancestor walk could ever need, turning an infinite loop
    // into a fast, loud test failure instead of a hang.
    function boundedDirname(realDirnameImpl) {
      let calls = 0;
      return (p) => {
        calls++;
        if (calls > HARD_ITERATION_CAP) {
          throw new Error(
            `computeSweepProtectSet: dirname called >${HARD_ITERATION_CAP} times — ` +
            `the ancestor walk did not terminate (regression of #4220)`,
          );
        }
        return realDirnameImpl(p);
      };
    }

    test('terminates and protects ancestors on win32 paths outside runTempRoot', () => {
      const runner = require('../scripts/run-tests.cjs');
      assert.equal(typeof runner.computeSweepProtectSet, 'function',
        'the runner must export computeSweepProtectSet for in-process verification');
      const win32 = require('node:path').win32;
      // A file living entirely outside runTempRoot (the common case — most
      // selected test files are in the repo checkout), walked with the
      // Windows dirname implementation whose drive-root is NOT length 1.
      const selected = ['C:\\repo\\tests\\a\\b.test.cjs'];
      const runTempRoot = 'C:\\Users\\ci\\AppData\\Local\\Temp\\gsd-test-run-xyz';

      const protectSet = runner.computeSweepProtectSet(
        selected, runTempRoot, boundedDirname(win32.dirname),
      );

      assert.ok(protectSet.has('C:\\repo\\tests\\a\\b.test.cjs'), 'the file itself is protected');
      assert.ok(protectSet.has('C:\\repo\\tests\\a'), 'immediate parent is protected');
      assert.ok(protectSet.has('C:\\repo\\tests'), 'grandparent is protected');
      assert.ok(protectSet.has('C:\\repo'), 'walk reaches up to the drive-relative root');
      // The walk must have stopped — it must NOT contain the drive root
      // itself looping forever, and the protect set must be finite/small.
      assert.ok(protectSet.size < 20, 'the walk terminates with a small, bounded protect set');
    });

    test('terminates and protects ancestors on win32 paths INSIDE runTempRoot (exact-file case)', () => {
      const runner = require('../scripts/run-tests.cjs');
      const win32 = require('node:path').win32;
      const runTempRoot = 'C:\\Users\\ci\\AppData\\Local\\Temp\\gsd-test-run-xyz';
      const selected = [`${runTempRoot}\\fixture\\nested\\c.test.cjs`];

      const protectSet = runner.computeSweepProtectSet(
        selected, runTempRoot, boundedDirname(win32.dirname),
      );

      assert.ok(protectSet.has(selected[0]), 'the file itself is protected');
      assert.ok(protectSet.has(`${runTempRoot}\\fixture\\nested`), 'immediate parent is protected');
      assert.ok(protectSet.has(`${runTempRoot}\\fixture`), 'grandparent is protected');
      assert.ok(!protectSet.has(win32.dirname(runTempRoot)),
        'the walk stops at runTempRoot and never protects its parent');
    });

    test('terminates and protects ancestors on posix paths (parity with win32)', () => {
      const runner = require('../scripts/run-tests.cjs');
      const posix = require('node:path').posix;
      const selected = ['/repo/tests/a/b.test.cjs'];
      const runTempRoot = '/synthetic-root/gsd-test-run-xyz';

      const protectSet = runner.computeSweepProtectSet(
        selected, runTempRoot, boundedDirname(posix.dirname),
      );

      assert.ok(protectSet.has('/repo/tests/a/b.test.cjs'), 'the file itself is protected');
      assert.ok(protectSet.has('/repo/tests/a'), 'immediate parent is protected');
      assert.ok(protectSet.has('/repo/tests'), 'grandparent is protected');
      assert.ok(protectSet.has('/repo'), 'walk reaches up toward the root');
      assert.ok(!protectSet.has('/'),
        'the walk stops before adding the filesystem root itself, mirroring win32 behavior');
    });

    test('exact-file case on posix: selected file lies directly under runTempRoot', () => {
      const runner = require('../scripts/run-tests.cjs');
      const posix = require('node:path').posix;
      const runTempRoot = '/synthetic-root/gsd-test-run-xyz';
      const selected = [runTempRoot];

      const protectSet = runner.computeSweepProtectSet(
        selected, runTempRoot, boundedDirname(posix.dirname),
      );
      assert.ok(protectSet.has(runTempRoot), 'the exact-file case protects runTempRoot itself');
    });

    test('defaults dirnameImpl to the real platform path.dirname when not injected', () => {
      const runner = require('../scripts/run-tests.cjs');
      const path = require('node:path');
      const os = require('node:os');
      const runTempRoot = path.join(os.tmpdir(), 'gsd-test-run-default');
      const selected = [path.join(runTempRoot, 'fixture', 'd.test.cjs')];

      const protectSet = runner.computeSweepProtectSet(selected, runTempRoot);
      assert.ok(protectSet.has(selected[0]), 'default dirnameImpl still protects the selected file');
      assert.ok(protectSet.has(path.join(runTempRoot, 'fixture')), 'default dirnameImpl walks ancestors');
    });
  });
});
