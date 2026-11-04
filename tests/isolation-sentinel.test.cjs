'use strict';

/**
 * Tests for hooks/lib/isolation-sentinel.js's resolveSentinelRoot() — specifically
 * the #3582 self-heal call it makes before resolving a linked-worktree/ancestor
 * project root. That call is reached ONLY when '.planning' is NOT directly under
 * the cwd passed in (the early return at the top of the function fires first
 * otherwise).
 *
 * #3582 review finding 1a: every existing #3582 cold-tree fixture
 * (tests/helpers/cold-runtime-lib-fixture.cjs) puts '.planning' directly under
 * the fixture project root, so none of them ever reach this branch — deleting
 * the seam call would fail nothing in those suites. The one existing test that
 * DOES pass a cwd whose '.planning' is not directly present
 * (tests/gsd-agent-isolation-guard.test.cjs's "#3045 MINOR" linked-worktree
 * test) runs against the REAL, already-built dev tree, where
 * ensureRuntimeBuild() is a fast successful no-op — removing the seam call
 * there would not change that test's outcome either, since the next require
 * (worktree-safety.cjs) would resolve identically either way.
 *
 * This file closes that gap. Rather than a real tsc build (which would need
 * this repo's own node_modules/typescript to be reachable from a throwaway
 * fixture root, or a directory symlink into it — the latter a privileged,
 * CI-unsafe operation on Windows per tests/ensure-runtime-build.test.cjs's own
 * comment), it substitutes the THREE modules resolveSentinelRoot requires
 * (the seam itself, worktree-safety.cjs, project-root.cjs) via require.cache,
 * keyed by their real resolved absolute paths. This directly OBSERVES whether
 * the seam call ran (a spy counter), rather than inferring it from a return
 * value that a missing call could coincidentally also produce — and never
 * touches gsd-core/bin/lib on disk. Injected cache entries are restored (or
 * deleted, if absent beforehand) in `t.after()` so no other test sharing this
 * worker process ever observes the substitution.
 *
 * Mutation check performed while authoring this test (not re-run on every CI
 * pass — see the assertions' own doc comments): removing the two-line seam
 * call from resolveSentinelRoot makes `seamCalls` stay 0 and
 * `worktreeSafetyCalls` become 1 (the fake, reachable stub now answers), so
 * this test fails exactly when the fix regresses.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup, runGsdTools } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { createFixture } = require('./fixtures/index.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SENTINEL_MODULE_PATH = path.join(REPO_ROOT, 'hooks', 'lib', 'isolation-sentinel.js');
const SEAM_PATH = require.resolve(path.join(REPO_ROOT, 'gsd-core', 'bin', 'ensure-runtime-build.cjs'));
const WORKTREE_SAFETY_PATH = require.resolve(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'worktree-safety.cjs'));
const PROJECT_ROOT_PATH = require.resolve(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'project-root.cjs'));
const SENTINEL_RESOLVED = require.resolve(SENTINEL_MODULE_PATH);

/** Minimal shape Node's Module cache expects; only `.exports` is read by require(). */
function fakeModule(filename, exportsObj) {
  return { id: filename, filename, loaded: true, exports: exportsObj, children: [], paths: [] };
}

describe('hooks/lib/isolation-sentinel.js: resolveSentinelRoot self-heal reachability (#3582 review finding 1a)', () => {
  test('the seam call fires — and short-circuits the downstream requires — when .planning is not directly under cwd', (t) => {
    const savedSeam = require.cache[SEAM_PATH];
    const savedWorktreeSafety = require.cache[WORKTREE_SAFETY_PATH];
    const savedProjectRoot = require.cache[PROJECT_ROOT_PATH];
    const savedSentinel = require.cache[SENTINEL_RESOLVED];

    t.after(() => {
      const restore = (key, saved) => { if (saved) require.cache[key] = saved; else delete require.cache[key]; };
      restore(SEAM_PATH, savedSeam);
      restore(WORKTREE_SAFETY_PATH, savedWorktreeSafety);
      restore(PROJECT_ROOT_PATH, savedProjectRoot);
      restore(SENTINEL_RESOLVED, savedSentinel);
    });

    let seamCalls = 0;
    let worktreeSafetyCalls = 0;
    let projectRootCalls = 0;

    class FakeRuntimeBuildError extends Error {}
    require.cache[SEAM_PATH] = fakeModule(SEAM_PATH, {
      RuntimeBuildError: FakeRuntimeBuildError,
      ensureRuntimeBuild: () => {
        seamCalls += 1;
        throw new FakeRuntimeBuildError('fake cold-tree build failure (#3582 reachability test)');
      },
    });
    require.cache[WORKTREE_SAFETY_PATH] = fakeModule(WORKTREE_SAFETY_PATH, {
      resolveWorktreeRoot: () => {
        worktreeSafetyCalls += 1;
        return { root: 'SHOULD-NOT-BE-REACHED' };
      },
    });
    require.cache[PROJECT_ROOT_PATH] = fakeModule(PROJECT_ROOT_PATH, {
      findProjectRoot: () => {
        projectRootCalls += 1;
        return 'SHOULD-NOT-BE-REACHED';
      },
    });
    // Fresh require of isolation-sentinel.js itself — not strictly required
    // (its own three requires live inside the function body and are
    // re-evaluated on every call regardless of module-cache state), but keeps
    // this test independent of whatever load order other files in the same
    // worker already forced.
    delete require.cache[SENTINEL_RESOLVED];
    const { resolveSentinelRoot } = require(SENTINEL_MODULE_PATH);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-iso-sentinel-reach-'));
    t.after(() => cleanup(cwd));
    assert.equal(
      fs.existsSync(path.join(cwd, '.planning')),
      false,
      'precondition: no .planning directly under cwd, so the early return must NOT fire',
    );

    const result = resolveSentinelRoot(cwd);

    assert.equal(seamCalls, 1, 'ensureRuntimeBuild() must be called exactly once when .planning is not directly under cwd');
    assert.equal(worktreeSafetyCalls, 0, 'a thrown RuntimeBuildError must short-circuit before resolveWorktreeRoot is ever reached');
    assert.equal(projectRootCalls, 0, 'a thrown RuntimeBuildError must short-circuit before findProjectRoot is ever reached');
    assert.equal(result, cwd, 'resolveSentinelRoot degrades to the raw cwd on a build failure, same as any other resolution failure');
  });
});

describe('hooks/lib/isolation-sentinel.js: per-dispatch keyed records (#5682)', () => {
  const sentinel = require(SENTINEL_MODULE_PATH);
  const { readSentinel, agedNoneGovernsDispatch, sentinelAppliesToDispatch, SENTINEL_STALE_MS, AGED_NONE_MAX_MS, VALID_ISOLATION } = sentinel;
  const guard = require('../hooks/gsd-agent-isolation-guard.js');

  const FLAG = 'isolation="worktree"';
  const LEGACY_FILE = path.join('.gsd', 'dispatch-isolation-sentinel.json');
  const KEYED_DIR = path.join('.gsd', 'dispatch-isolation');
  const keyedFile = (root, phase, plan) => path.join(root, KEYED_DIR, `${phase}--${plan}.json`);
  const A = { phase: '21', plan: '21-13' };
  const B = { phase: '23', plan: '23-15' };

  let project;
  let savedGsdRuntime;

  beforeEach(() => {
    savedGsdRuntime = process.env.GSD_RUNTIME;
    delete process.env.GSD_RUNTIME;
    project = createFixture({ prefix: 'gsd-5682-', planning: true, git: true, projectDoc: false });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  });
  afterEach(() => {
    cleanup(project);
    if (savedGsdRuntime === undefined) delete process.env.GSD_RUNTIME;
    else process.env.GSD_RUNTIME = savedGsdRuntime;
  });

  /** Persist one decision through the real `record-dispatch-isolation` CLI writer. */
  function record(root, { isolation, phase, plan, flag }) {
    const args = ['record-dispatch-isolation', '--isolation', isolation];
    if (flag) args.push(`--harness-flag=${flag}`);
    if (phase) args.push('--phase', phase);
    if (plan) args.push('--plan', plan);
    const result = runGsdTools(args, root);
    assert.ok(result.success, `record-dispatch-isolation failed: ${result.error}`);
    assert.equal(JSON.parse(result.output).recorded, true);
  }

  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));
  const clockAt = (ms) => ({ now: () => ms });

  /** A's decision, then B's: the legacy single slot now holds B. */
  function interleave(root) {
    record(root, { isolation: 'none', ...A });
    record(root, { isolation: 'harness-worktree', flag: FLAG, ...B });
    return clockAt(readJson(path.join(root, LEGACY_FILE)).written_at + 1);
  }

  test('#5682: interleaved records each resolve for their own dispatch', () => {
    const clock = interleave(project);

    const forA = readSentinel(project, { clock, dispatchIds: A });
    assert.equal(forA.present, true);
    assert.equal(forA.stale, false);
    assert.equal(forA.malformed, false);
    assert.equal(forA.isolation, 'none');
    assert.equal(forA.phase, '21');
    assert.equal(forA.plan, '21-13');
    assert.equal(forA.harnessFlag, null);

    const forB = readSentinel(project, { clock, dispatchIds: B });
    assert.equal(forB.stale, false);
    assert.equal(forB.isolation, 'harness-worktree');
    assert.equal(forB.phase, '23');
    assert.equal(forB.plan, '23-15');
    assert.equal(forB.harnessFlag, FLAG);
  });

  test('#5682: an earlier phase\'s record does not authorize a later dispatch', () => {
    record(project, { isolation: 'none', phase: '21', plan: '21-01' });
    const later = { phase: '22', plan: '22-01' };
    const clock = clockAt(readJson(path.join(project, LEGACY_FILE)).written_at + 1);

    const read = readSentinel(project, { clock, dispatchIds: later });
    assert.equal(read.phase, '21', 'a keyed miss falls through to the legacy record');
    assert.equal(sentinelAppliesToDispatch(read, later), false, 'the legacy logic rejects the foreign phase');
    assert.equal(
      guard.resolveIsolationState(project, { clock, dispatchIds: later }).isolation,
      'harness-worktree',
      'the registry fallback governs the later phase, not the earlier phase\'s none',
    );
  });

  test('#5682: single orchestrator unchanged', () => {
    record(project, { isolation: 'none', ...A });
    const clock = clockAt(readJson(path.join(project, LEGACY_FILE)).written_at + 1);
    const legacy = readSentinel(project, { clock });
    assert.deepEqual(readSentinel(project, { clock, dispatchIds: A }), legacy, 'dispatch with ids');
    assert.deepEqual(readSentinel(project, { clock, dispatchIds: { phase: null, plan: null } }), legacy, 'dispatch with no ids');
    assert.deepEqual(readSentinel(project, { clock, dispatchIds: { phase: '21', plan: null } }), legacy, 'dispatch with a phase only');
    assert.equal(legacy.isolation, 'none');
  });

  test('#5682: single orchestrator unchanged for a phase-level record (no plan)', () => {
    record(project, { isolation: 'none', phase: '21' });
    assert.deepEqual(fs.readdirSync(path.join(project, KEYED_DIR)), ['21.json'], 'a plan-less record writes the phase-level keyed file');
    const clock = clockAt(readJson(path.join(project, LEGACY_FILE)).written_at + 1);
    const legacy = readSentinel(project, { clock });
    assert.deepEqual(readSentinel(project, { clock, dispatchIds: A }), legacy);
    assert.equal(legacy.phase, '21');
    assert.equal(legacy.plan, null);
  });

  test('#5682: keyed record keeps the trust window', () => {
    interleave(project);
    const file = keyedFile(project, A.phase, A.plan);
    const written = 1_000_000;
    fs.writeFileSync(file, JSON.stringify({ ...readJson(file), written_at: written }));

    const at = (age) => readSentinel(project, { clock: clockAt(written + age), dispatchIds: A });
    assert.equal(at(SENTINEL_STALE_MS - 1).stale, false, 'limit-1 is fresh');
    assert.equal(at(SENTINEL_STALE_MS).stale, true, 'limit is stale');
    assert.equal(at(SENTINEL_STALE_MS + 1).stale, true, 'limit+1 is stale');
    assert.equal(at(SENTINEL_STALE_MS + 1).phase, '21', 'the stale answer still comes from the keyed record');
    assert.equal(at(SENTINEL_STALE_MS + 1).isolation, 'none');
    assert.equal(at(-5000).stale, false, 'the future tolerance edge is fresh');
    assert.equal(at(-5001).stale, true, 'beyond the future tolerance is stale');
  });

  test('#5682: keyed none keeps the aged-none window and a future-dated keyed record never governs', () => {
    interleave(project);
    const file = keyedFile(project, A.phase, A.plan);
    const written = 1_000_000;
    fs.writeFileSync(file, JSON.stringify({ ...readJson(file), written_at: written }));

    const governs = (age) => {
      const clock = clockAt(written + age);
      return agedNoneGovernsDispatch(readSentinel(project, { clock, dispatchIds: A }), A, { clock });
    };
    assert.equal(governs(SENTINEL_STALE_MS), true, 'past the trust window the aged none governs its own phase');
    assert.equal(governs(AGED_NONE_MAX_MS - 1), true);
    assert.equal(governs(AGED_NONE_MAX_MS), true);
    assert.equal(governs(AGED_NONE_MAX_MS + 1), false);
    assert.equal(governs(-5001), false, 'future-dated');
    const future = readSentinel(project, { clock: clockAt(written - 6000), dispatchIds: A });
    assert.equal(future.stale, true);
    assert.equal(future.phase, '21');
  });

  test('#5682: key/content mismatch is ignored', () => {
    const clock = interleave(project);
    const file = keyedFile(project, A.phase, A.plan);
    fs.writeFileSync(file, JSON.stringify({ ...readJson(file), phase: '99', plan: '99-01' }));

    const read = readSentinel(project, { clock, dispatchIds: A });
    assert.equal(read.phase, '23', 'a keyed file that disagrees with its own filename falls through to the legacy record');
    assert.equal(read.plan, '23-15');
    assert.equal(read.isolation, 'harness-worktree');
  });

  /** Persist one decision through the CLI writer with the clock pinned to `now`. */
  function recordAt(root, now, { isolation, phase, plan, flag }) {
    const args = ['record-dispatch-isolation', '--isolation', isolation];
    if (flag) args.push(`--harness-flag=${flag}`);
    if (phase) args.push('--phase', phase);
    if (plan) args.push('--plan', plan);
    const result = runGsdTools(args, root, { GSD_TEST_MODE: '1', GSD_NOW_MS: String(now) });
    assert.ok(result.success, `record-dispatch-isolation failed: ${result.error}`);
    assert.equal(JSON.parse(result.output).recorded, true);
  }

  test('#5682: a newer applicable phase-level record beats an older fresh keyed record', () => {
    const T = Date.now();
    recordAt(project, T, { isolation: 'none', ...A });
    recordAt(project, T + 1000, { isolation: 'harness-worktree', flag: FLAG, phase: '21' });
    const read = readSentinel(project, { clock: clockAt(T + 2000), dispatchIds: A });
    assert.equal(read.stale, false);
    assert.equal(read.isolation, 'harness-worktree', 'the newer phase-level decision governs plan 21-13');
    assert.equal(read.plan, null);
    assert.equal(read.writtenAt, T + 1000);
  });

  test('#5682: an older phase-level record does not beat a newer keyed record', () => {
    const T = Date.now();
    recordAt(project, T, { isolation: 'harness-worktree', flag: FLAG, phase: '21' });
    recordAt(project, T + 1000, { isolation: 'none', ...A });
    recordAt(project, T + 2000, { isolation: 'harness-worktree', flag: FLAG, ...B });
    const read = readSentinel(project, { clock: clockAt(T + 3000), dispatchIds: A });
    assert.equal(read.isolation, 'none');
    assert.equal(read.plan, '21-13');
  });

  test('#5682: two phase-level orchestrators each resolve their own record', () => {
    const T = Date.now();
    recordAt(project, T, { isolation: 'none', phase: '21' });
    recordAt(project, T + 1000, { isolation: 'harness-worktree', flag: FLAG, phase: '23' });
    const clock = clockAt(T + 2000);
    const for21 = readSentinel(project, { clock, dispatchIds: A });
    assert.equal(for21.isolation, 'none');
    assert.equal(for21.phase, '21');
    const for23 = readSentinel(project, { clock, dispatchIds: B });
    assert.equal(for23.isolation, 'harness-worktree');
    assert.equal(for23.phase, '23');
    assert.equal(readSentinel(project, { clock, dispatchIds: { phase: '21', plan: null } }).isolation, 'none', 'a plan-less dispatch of phase 21');
  });

  test('#5682: a phase-level keyed file whose content disagrees with its filename is ignored', () => {
    const T = Date.now();
    recordAt(project, T, { isolation: 'none', phase: '21' });
    const file = path.join(project, KEYED_DIR, '21.json');
    fs.writeFileSync(file, JSON.stringify({ ...readJson(file), phase: '99' }));
    recordAt(project, T + 1000, { isolation: 'harness-worktree', flag: FLAG, ...B });
    const read = readSentinel(project, { clock: clockAt(T + 2000), dispatchIds: A });
    assert.equal(read.phase, '23', 'falls through to the legacy record');
  });

  test('#5682 F4: isSafeSentinelKey accepts 99 and 100 characters and rejects 101', () => {
    assert.equal(sentinel.isSafeSentinelKey('k'.repeat(99)), true, 'limit-1');
    assert.equal(sentinel.isSafeSentinelKey('k'.repeat(100)), true, 'limit');
    assert.equal(sentinel.isSafeSentinelKey('k'.repeat(101)), false, 'limit+1');
    assert.equal(sentinel.keyedSentinelPath(project, 'k'.repeat(100), 'p'), path.join(project, KEYED_DIR, `${'k'.repeat(100)}--p.json`));
    assert.equal(sentinel.keyedSentinelPath(project, 'k'.repeat(101), 'p'), null);
    assert.equal(sentinel.keyedSentinelPath(project, 'k', 'p'.repeat(101)), null);
  });

  test('#5682 F5 property: an accepted key pair stays inside the keyed directory, a rejected one yields null', () => {
    const root = path.join(os.tmpdir(), 'gsd-5682-prop-root');
    const keyed = path.join(root, KEYED_DIR);
    const key = fc.oneof(
      fc.stringMatching(/^[A-Za-z0-9._-]{0,110}$/),
      fc.string({ maxLength: 12 }),
      fc.constantFrom('.', '..', '../x', 'a/b', 'a\\b', '', 'x\0y', '..\\..', '21', '21-13'),
    );
    fc.assert(
      fc.property(key, key, (k, k2) => {
        const out = sentinel.keyedSentinelPath(root, k, k2);
        if (sentinel.isSafeSentinelKey(k) && sentinel.isSafeSentinelKey(k2)) {
          return typeof out === 'string' && path.dirname(out) === keyed && path.basename(out) === `${k}--${k2}.json`;
        }
        return out === null;
      }),
      { seed: 5682, numRuns: 300 },
    );
  });

  test('#5682 property: any interleaving of records over distinct keys reads back each key\'s last write', () => {
    // Records are laid out exactly as the writer lays them (one keyed file per phase/plan plus the
    // legacy single slot, last writer wins); the writer itself is driven through the real CLI above.
    const KEYS = [A, B, { phase: '22', plan: '22-01' }, { phase: '24', plan: '24-02' }];
    const T0 = 1_000_000;
    const op = fc.record({ key: fc.integer({ min: 0, max: KEYS.length - 1 }), isolation: fc.constantFrom(...VALID_ISOLATION) });
    const gsd = path.join(project, '.gsd');

    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 12 }), (ops) => {
        cleanup(gsd);
        fs.mkdirSync(path.join(project, KEYED_DIR), { recursive: true });
        const last = new Map();
        ops.forEach((o, i) => {
          const { phase, plan } = KEYS[o.key];
          const body = JSON.stringify({ isolation: o.isolation, harness_flag: null, phase, plan, written_at: T0 + i });
          fs.writeFileSync(keyedFile(project, phase, plan), body);
          fs.writeFileSync(path.join(project, LEGACY_FILE), body);
          last.set(o.key, o.isolation);
        });
        const clock = clockAt(T0 + ops.length);
        for (const [k, isolation] of last) {
          const read = readSentinel(project, { clock, dispatchIds: KEYS[k] });
          if (read.isolation !== isolation || read.phase !== KEYS[k].phase || read.plan !== KEYS[k].plan) return false;
        }
        return true;
      }),
      { seed: 5682, numRuns: 200 },
    );
  });
});
