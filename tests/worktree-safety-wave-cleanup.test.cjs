// docs-guard-exempt: docs/other.md below is a stubbed git diff output line; this file reads no docs/ file.
'use strict';

/**
 * `executeWorktreeWaveCleanupPlan` / `cmdWorktreeCleanupWave` — verdict-shape rows.
 *
 * Seam: gsd-core/bin/lib/worktree-safety.cjs
 * Interface: executeWorktreeWaveCleanupPlan, cmdWorktreeCleanupWave
 *
 * WHY A SEPARATE FILE
 * The wave-cleanup suites in tests/worktree-safety.test.cjs assert the gate
 * DECISIONS (does an entry merge or block, and on which reason). What they leave
 * open is the shape of what the gate REPORTS once it has decided: the `stderr`
 * an operator is handed for each block reason, the refusal object for a plan
 * that is not runnable, which entries are left `pending` when the wave halts,
 * and the CLI wrapper's exit codes and JSON envelope. Those are the parts an
 * orchestrator reads back, and none of them were pinned, so a regression that
 * kept every decision right while blanking the diagnostic (or misreporting
 * the pending set) passed the suite.
 *
 * Fixture shape: `execGit` is a scripted table keyed on the joined argv, and an
 * unscripted call throws — so every row states exactly which git calls its
 * scenario makes. `statSync` and `findSummaryFiles` are injected too, so the
 * executor rows never touch the real filesystem or real git. Only the CLI rows
 * use real git, and only the one that needs a merge to actually succeed.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const {
  executeWorktreeWaveCleanupPlan,
  cmdWorktreeCleanupWave,
  WAVE_CLEANUP_WARNING,
} = require('../gsd-core/bin/lib/worktree-safety.cjs');

// ─── Scripted git seam ───────────────────────────────────────────────────────

const REPO = '/repo/main';
const BASE = 'abc123';
const ABSENT_ERR = 'fatal: cannot change to the worktree: No such file or directory';

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'fatal: failed', exitCode = 128) => ({ exitCode, stdout: '', stderr });

/** A git result with `stderr` omitted entirely when `stderr` is undefined. */
function resultWith(base, stderr) {
  return stderr === undefined ? { ...base } : { ...base, stderr };
}

const mergeKey = (branch) => `merge ${branch} --no-ff --no-edit -m chore: merge executor worktree (${branch})`;

function entryFor(id, extra = {}) {
  return {
    agent_id: id,
    worktree_path: `/repo/.claude/worktrees/agent-${id}`,
    branch: `worktree-agent-${id}`,
    expected_base: BASE,
    ...extra,
  };
}

function plan(entries) {
  return { ok: true, repoRoot: REPO, action: 'cleanup_wave', discovery: 'manifest', entries };
}

/** `git worktree list --porcelain` output: main first, then each listed worktree. */
function porcelain(...worktrees) {
  let out = 'worktree /repo/main\nHEAD deadbeef\nbranch refs/heads/main\n';
  for (const wt of worktrees) {
    out += `\nworktree ${wt.path}\nHEAD deadbeef\nbranch refs/heads/${wt.branch}\n`;
    if (wt.prunable) out += 'prunable gitdir file points to non-existent location\n';
  }
  return out;
}

/** Every call a present, clean, on-branch, on-base worktree makes on the way to merged_removed. */
function presentGit(e) {
  return {
    [`-C ${e.worktree_path} rev-parse --abbrev-ref HEAD`]: ok(e.branch),
    [`merge-base HEAD ${e.branch}`]: ok(BASE),
    [`diff --diff-filter=D --name-only HEAD...${e.branch}`]: ok(''),
    [`-C ${e.worktree_path} status --porcelain --untracked-files=all`]: ok(''),
    [mergeKey(e.branch)]: ok(''),
    [`worktree remove ${e.worktree_path} --force`]: ok(''),
    [`branch -D ${e.branch}`]: ok(''),
  };
}

/** The same entry after the harness removed its checkout (git still binds path -> branch). */
function absentGit(e) {
  const table = presentGit(e);
  delete table[`-C ${e.worktree_path} status --porcelain --untracked-files=all`];
  delete table[`worktree remove ${e.worktree_path} --force`];
  return {
    ...table,
    [`-C ${e.worktree_path} rev-parse --abbrev-ref HEAD`]: fail(ABSENT_ERR),
    'worktree list --porcelain': ok(porcelain({ path: e.worktree_path, branch: e.branch, prunable: true })),
    'worktree prune': ok(''),
  };
}

/**
 * A table value is a result, or an array of results consumed in call order (the
 * last one repeats). Unscripted calls throw, so a row cannot silently make a git
 * call its scenario never stated.
 */
function scriptedGit(table) {
  const calls = [];
  const counts = new Map();
  const execGit = (args, opts) => {
    const key = args.join(' ');
    calls.push({ key, opts });
    if (!Object.prototype.hasOwnProperty.call(table, key)) {
      throw new Error(`unexpected git call: ${key}`);
    }
    const value = table[key];
    if (!Array.isArray(value)) return value;
    const n = counts.get(key) || 0;
    counts.set(key, n + 1);
    return value[Math.min(n, value.length - 1)];
  };
  return { execGit, calls };
}

const ENOENT = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
const statGone = () => { throw ENOENT; };
const statPresent = () => ({ isDirectory: () => true });

function run(entries, table, deps = {}) {
  const git = scriptedGit(table);
  const result = executeWorktreeWaveCleanupPlan(plan(entries), {
    execGit: git.execGit,
    findSummaryFiles: () => [],
    statSync: statPresent,
    ...deps,
  });
  return { result, calls: git.calls.map((c) => c.key), rawCalls: git.calls };
}

/**
 * Every call in the gauntlet passes `cwd: repoRoot`. That is what makes a
 * relative manifest `worktree_path` resolve against the repo (the `-C <path>`
 * calls) and what points the merge, prune and branch delete at the main
 * checkout rather than at whatever directory the CLI happened to start in.
 */
function assertAllRanAtRepoRoot(rawCalls) {
  assert.ok(rawCalls.length > 0, 'the scenario must have made git calls');
  for (const { key, opts } of rawCalls) {
    assert.equal(opts && opts.cwd, REPO, `git ${key} must run with cwd = repoRoot`);
  }
}

const neverGit = () => { throw new Error('a refused plan must not run git'); };

// ─── A plan that is not runnable is refused before any git call ──────────────

describe('executeWorktreeWaveCleanupPlan: a non-runnable plan is refused, not executed', () => {
  test('no plan at all reports missing_plan with action skip and empty collections', () => {
    // The CLI forwards this object to an orchestrator that branches on `reason`;
    // the fallback collections must be empty, not padded, so nothing reads as pending.
    assert.deepEqual(executeWorktreeWaveCleanupPlan(null, { execGit: neverGit }), {
      ok: false,
      action: 'skip',
      reason: 'missing_plan',
      entries: [],
      pending: [],
      warnings: [],
    });
  });

  test("a skip plan keeps the planner's own reason and action", () => {
    // planWorktreeWaveCleanup emits `action: 'skip'` with a specific reason
    // (empty_manifest, invalid_manifest_json); that reason must survive, not be
    // overwritten with a generic one.
    const skip = { ok: false, repoRoot: REPO, action: 'skip', discovery: 'manifest', reason: 'empty_manifest', entries: [] };
    assert.deepEqual(executeWorktreeWaveCleanupPlan(skip, { execGit: neverGit }), {
      ok: false,
      action: 'skip',
      reason: 'empty_manifest',
      entries: [],
      pending: [],
      warnings: [],
    });
  });

  test('a cleanup_wave plan with no entries is refused as missing_entries, not reported ok', () => {
    // Near-miss of the happy path: same action, nothing to do. "ok" here would
    // tell the orchestrator a wave merged when nothing was even looked at.
    const empty = { repoRoot: REPO, action: 'cleanup_wave', discovery: 'manifest', entries: [] };
    assert.deepEqual(executeWorktreeWaveCleanupPlan(empty, { execGit: neverGit }), {
      ok: false,
      action: 'cleanup_wave',
      reason: 'missing_entries',
      entries: [],
      pending: [],
      warnings: [],
    });
  });

  test('a non-cleanup_wave plan that carries entries never merges them; they come back pending', () => {
    // Only `cleanup_wave` authorizes merges. Entries attached to any other action
    // are returned untouched as pending so the caller can see what was NOT done.
    const e = entryFor('s1');
    const skip = { repoRoot: REPO, action: 'skip', reason: 'operator_skip', entries: [e] };
    const result = executeWorktreeWaveCleanupPlan(skip, { execGit: neverGit });
    assert.deepEqual(result, {
      ok: false,
      action: 'skip',
      reason: 'operator_skip',
      entries: [],
      pending: [e],
      warnings: [],
    });
  });
});

// ─── Happy path verdict shape ────────────────────────────────────────────────

describe('executeWorktreeWaveCleanupPlan: a clean entry reports merged_removed exactly', () => {
  test('the verdict carries the manifest entry, ok reason, an empty stderr, and runs every call at repoRoot', () => {
    const e = entryFor('h1');
    const { result, calls, rawCalls } = run([e], presentGit(e));
    assert.deepEqual(result, {
      ok: true,
      action: 'cleanup_wave',
      reason: 'ok',
      entries: [{ ...e, status: 'merged_removed', reason: 'ok', stderr: '', warnings: [] }],
      pending: [],
      warnings: [],
    });
    assert.ok(calls.includes(`worktree remove ${e.worktree_path} --force`), 'a present worktree is removed');
    assertAllRanAtRepoRoot(rawCalls);
  });

  test('raw git output with a trailing newline still matches the branch and the base', () => {
    // The gate compares `rev-parse` / `merge-base` output against manifest values;
    // it must not depend on the seam having trimmed git's newline, or every entry
    // from an untrimmed seam would block as branch_mismatch / base_mismatch.
    const e = entryFor('h2');
    const table = {
      ...presentGit(e),
      [`-C ${e.worktree_path} rev-parse --abbrev-ref HEAD`]: ok(`${e.branch}\n`),
      [`merge-base HEAD ${e.branch}`]: ok(`${BASE}\n`),
    };
    assert.equal(run([e], table).result.entries[0].status, 'merged_removed');
  });

  test('an empty allowed_bases list falls back to expected_base instead of allowing nothing', () => {
    // normalizeCleanupManifestEntry always seeds allowed_bases with expected_base,
    // but a hand-built plan may carry `[]`. "No extra bases" must mean "just the
    // expected one", not "no base is acceptable".
    const e = entryFor('h3', { allowed_bases: [] });
    assert.equal(run([e], presentGit(e)).result.entries[0].status, 'merged_removed');

    const offBase = entryFor('h4', { allowed_bases: [], expected_base: 'fff999' });
    const blocked = run([offBase], presentGit(offBase)).result.entries[0];
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.reason, 'base_mismatch');
  });
});

// ─── Each block reason hands the operator git's own diagnostic ───────────────

describe("executeWorktreeWaveCleanupPlan: a block's stderr is git's diagnostic, always a string", () => {
  // Each site: [label, reason, buildTable(entry, failingResult), deps]. The
  // failing call is the one whose stderr the verdict must quote.
  const SITES = [
    ['absent path git has no record of', 'branch_mismatch', (e, r) => ({
      ...presentGit(e),
      [`-C ${e.worktree_path} rev-parse --abbrev-ref HEAD`]: { exitCode: 128, stdout: '', ...r },
      'worktree list --porcelain': ok(porcelain()),
    }), { statSync: statGone }],
    ['present checkout on the wrong branch', 'branch_mismatch', (e, r) => ({
      ...presentGit(e),
      [`-C ${e.worktree_path} rev-parse --abbrev-ref HEAD`]: { exitCode: 0, stdout: 'worktree-agent-other', ...r },
    }), {}],
    ['merge-base failure', 'base_mismatch', (e, r) => ({
      ...presentGit(e),
      [`merge-base HEAD ${e.branch}`]: { exitCode: 1, stdout: '', ...r },
    }), {}],
    ['deletion check failure', 'deletion_check_failed', (e, r) => ({
      ...presentGit(e),
      [`diff --diff-filter=D --name-only HEAD...${e.branch}`]: { exitCode: 128, stdout: '', ...r },
    }), {}],
    ['status failure on a checkout that is still present', 'worktree_dirty', (e, r) => ({
      ...presentGit(e),
      [`-C ${e.worktree_path} status --porcelain --untracked-files=all`]: { exitCode: 128, stdout: '', ...r },
      'worktree list --porcelain': ok(porcelain({ path: e.worktree_path, branch: e.branch })),
    }), { statSync: statPresent }],
    ['worktree remove refused on a present checkout', 'worktree_remove_failed', (e, r) => ({
      ...presentGit(e),
      [`worktree remove ${e.worktree_path} --force`]: { exitCode: 128, stdout: '', ...r },
      [`worktree unlock ${e.worktree_path}`]: fail('fatal: not locked'),
      'worktree list --porcelain': ok(porcelain({ path: e.worktree_path, branch: e.branch })),
    }), { statSync: statPresent }],
    ['prune failure after a remove that found the path gone', 'worktree_remove_failed', (e, r) => ({
      ...presentGit(e),
      [`worktree remove ${e.worktree_path} --force`]: fail('fatal: is not a working tree'),
      [`worktree unlock ${e.worktree_path}`]: fail('fatal: not locked'),
      'worktree list --porcelain': ok(porcelain({ path: e.worktree_path, branch: e.branch, prunable: true })),
      'worktree prune': { exitCode: 1, stdout: '', ...r },
    }), { statSync: statGone }],
    ['prune failure on an entry accepted as absent', 'worktree_remove_failed', (e, r) => ({
      ...absentGit(e),
      'worktree prune': { exitCode: 1, stdout: '', ...r },
    }), { statSync: statGone }],
  ];

  const VARIANTS = [
    ['quotes a non-empty stderr verbatim', 'fatal: specific diagnostic', 'fatal: specific diagnostic'],
    ['keeps an empty stderr empty', '', ''],
    ['reports a missing stderr as the empty string', undefined, ''],
  ];

  for (const [label, reason, build, deps] of SITES) {
    for (const [variantLabel, stderr, expected] of VARIANTS) {
      test(`${label} -> ${reason}: ${variantLabel}`, () => {
        const e = entryFor('d1');
        const { result } = run([e], build(e, resultWith({}, stderr)), deps);
        const verdict = result.entries[0];
        assert.equal(verdict.status, 'blocked');
        assert.equal(verdict.reason, reason);
        assert.equal(verdict.stderr, expected);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'cleanup_blocked');
      });
    }
  }

  // merge_failed falls back from stderr to stdout: a conflicting merge prints its
  // "CONFLICT (content): ..." report on stdout, which is the useful diagnostic.
  const MERGE_VARIANTS = [
    ['prefers stderr when git wrote both', { stderr: 'error: refusing', stdout: 'CONFLICT (content)' }, 'error: refusing'],
    ['falls back to stdout when stderr is empty', { stderr: '', stdout: 'CONFLICT (content)' }, 'CONFLICT (content)'],
    ['is empty when git wrote neither', { stderr: '', stdout: '' }, ''],
    ['is empty when both streams are missing', {}, ''],
  ];
  for (const [variantLabel, streams, expected] of MERGE_VARIANTS) {
    test(`merge_failed ${variantLabel}`, () => {
      const e = entryFor('m1');
      const table = {
        ...presentGit(e),
        [mergeKey(e.branch)]: { exitCode: 1, ...streams },
        'merge --abort': fail('fatal: There is no merge to abort (MERGE_HEAD missing).'),
        'rev-parse --verify -q MERGE_HEAD': { exitCode: 1, stdout: '', stderr: '' },
      };
      const verdict = run([e], table).result.entries[0];
      assert.deepEqual(
        { status: verdict.status, reason: verdict.reason, stderr: verdict.stderr },
        { status: 'blocked', reason: 'merge_failed', stderr: expected },
      );
    });
  }

  test('undeclared deletions are listed one per line, declared ones left out', () => {
    // The operator is handed exactly the paths to investigate, newline-separated
    // as git reported them; a declared deletion is authorized and must not appear.
    const e = entryFor('x1', { declared_deletions: ['src/keep-deleted.ts'] });
    const table = {
      ...presentGit(e),
      [`diff --diff-filter=D --name-only HEAD...${e.branch}`]: ok('src/a.ts\nsrc/keep-deleted.ts\nsrc/b.ts'),
    };
    const verdict = run([e], table).result.entries[0];
    assert.equal(verdict.reason, 'branch_contains_deletions');
    assert.equal(verdict.stderr, 'src/a.ts\nsrc/b.ts');

    const allDeclared = entryFor('x2', { declared_deletions: ['src/a.ts', 'src/b.ts'] });
    const passTable = {
      ...presentGit(allDeclared),
      [`diff --diff-filter=D --name-only HEAD...${allDeclared.branch}`]: ok('src/a.ts\nsrc/b.ts'),
    };
    assert.equal(run([allDeclared], passTable).result.entries[0].status, 'merged_removed');
  });

  test('dirty lines are listed one per line, with a rescued SUMMARY filtered out', () => {
    // The dirty block names every uncommitted path except the SUMMARY the rescue
    // just copied into the main tree — that one is safe and is not the operator's problem.
    const e = entryFor('w1');
    const wtAbs = path.resolve(REPO, e.worktree_path);
    const summary = path.join(wtAbs, '.planning', 'q1-SUMMARY.md');
    const table = {
      ...presentGit(e),
      [`-C ${wtAbs} cat-file -e HEAD:.planning/q1-SUMMARY.md`]: fail('fatal: path not in HEAD'),
      [`-C ${e.worktree_path} status --porcelain --untracked-files=all`]:
        ok('?? .planning/q1-SUMMARY.md\n?? notes.txt\n?? scratch.log'),
    };
    const verdict = run([e], table, {
      findSummaryFiles: () => [summary],
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: () => {},
    }).result.entries[0];
    assert.equal(verdict.reason, 'worktree_dirty');
    assert.equal(verdict.stderr, '?? notes.txt\n?? scratch.log');
  });

  test('summary rescue failures name each path with its own error, joined by "; "', () => {
    // A failed copy may mean an uncommitted SUMMARY is lost; the block must say
    // WHICH file and WHY, per file, so the operator can recover each one.
    const e = entryFor('r1');
    const wtAbs = path.resolve(REPO, e.worktree_path);
    const q1 = path.join(wtAbs, '.planning', 'q1-SUMMARY.md');
    const q2 = path.join(wtAbs, '.planning', 'q2-SUMMARY.md');
    const table = {
      ...presentGit(e),
      [`-C ${wtAbs} cat-file -e HEAD:.planning/q1-SUMMARY.md`]: fail('fatal: path not in HEAD'),
      [`-C ${wtAbs} cat-file -e HEAD:.planning/q2-SUMMARY.md`]: fail('fatal: path not in HEAD'),
    };
    const verdict = run([e], table, {
      findSummaryFiles: () => [q1, q2],
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: (src) => {
        throw new Error(src === q1 ? 'EACCES: permission denied' : 'ENOSPC: no space left on device');
      },
    }).result.entries[0];
    assert.equal(verdict.reason, 'summary_rescue_failed');
    assert.equal(
      verdict.stderr,
      '.planning/q1-SUMMARY.md: EACCES: permission denied; .planning/q2-SUMMARY.md: ENOSPC: no space left on device',
    );
  });
});

// ─── Identity snapshot and the absent path ───────────────────────────────────

describe('executeWorktreeWaveCleanupPlan: absent-worktree identity', () => {
  test('a path missing from the wave snapshot is re-read once, and merges if git now binds it', () => {
    // "Absent from the snapshot: it may have been registered after the wave began."
    // The second read must use the injected seam and the same repoRoot.
    const e = entryFor('a1');
    const table = {
      ...absentGit(e),
      'worktree list --porcelain': [
        ok(porcelain()),
        ok(porcelain({ path: e.worktree_path, branch: e.branch, prunable: true })),
      ],
    };
    const { result, calls, rawCalls } = run([e], table, { statSync: statGone });
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.equal(calls.filter((k) => k === 'worktree list --porcelain').length, 2);
    assert.deepEqual(result.warnings, [{
      code: WAVE_CLEANUP_WARNING.ACCEPTED_ABSENT_WORKTREE,
      branch: e.branch,
      path: e.worktree_path,
      detail: 'gitdir file points to non-existent location',
    }]);
    assertAllRanAtRepoRoot(rawCalls);
  });

  test('near-miss: still unregistered on the re-read, the entry blocks as branch_mismatch', () => {
    const e = entryFor('a2');
    const table = { ...absentGit(e), 'worktree list --porcelain': ok(porcelain()) };
    const verdict = run([e], table, { statSync: statGone }).result.entries[0];
    assert.equal(verdict.reason, 'branch_mismatch');
    assert.equal(verdict.stderr, ABSENT_ERR);
  });

  test('a stat seam that throws a non-Error value counts as unreadable and blocks', () => {
    // Only an ENOENT proves removal. A failure without an error object proves
    // nothing, so the entry must block rather than crash the wave or merge.
    const e = entryFor('a3');
    const nothing = null;
    const verdict = run([e], absentGit(e), { statSync: () => { throw nothing; } }).result.entries[0];
    assert.equal(verdict.status, 'blocked');
    assert.equal(verdict.reason, 'branch_mismatch');
  });

  test('a checkout that vanishes before `status` is merged, pruned, and never force-removed', () => {
    // Identity was read from a present checkout, then the harness removed it.
    // The entry is accepted as absent — so teardown must be prune-only:
    // `worktree remove --force` on a path that skipped the dirty check is the
    // destructive call this branch exists to avoid.
    const e = entryFor('a4');
    const table = {
      ...presentGit(e),
      [`-C ${e.worktree_path} status --porcelain --untracked-files=all`]: fail(ABSENT_ERR),
      'worktree list --porcelain': ok(porcelain({ path: e.worktree_path, branch: e.branch, prunable: true })),
      'worktree prune': ok(''),
    };
    delete table[`worktree remove ${e.worktree_path} --force`];
    const { result, calls, rawCalls } = run([e], table, { statSync: statGone });
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.equal(calls.some((k) => k.startsWith('worktree remove')), false);
    assert.ok(calls.includes('worktree prune'));
    assert.deepEqual(result.entries[0].warnings.map((w) => w.code), [WAVE_CLEANUP_WARNING.ACCEPTED_ABSENT_WORKTREE]);
    assertAllRanAtRepoRoot(rawCalls);
  });

  test('a remove that fails because the path is gone is tidied by prune and still deletes the branch', () => {
    const e = entryFor('a5');
    const table = {
      ...presentGit(e),
      [`worktree remove ${e.worktree_path} --force`]: fail('fatal: is not a working tree'),
      [`worktree unlock ${e.worktree_path}`]: fail('fatal: not locked'),
      'worktree list --porcelain': ok(porcelain({ path: e.worktree_path, branch: e.branch, prunable: true })),
      'worktree prune': ok(''),
    };
    const { result, calls, rawCalls } = run([e], table, { statSync: statGone });
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.ok(calls.includes(`branch -D ${e.branch}`));
    assertAllRanAtRepoRoot(rawCalls);
  });
});

// ─── Scope advisory ──────────────────────────────────────────────────────────

describe('executeWorktreeWaveCleanupPlan: scope advisory', () => {
  test('a branch whose scope diff is empty raises no out-of-scope warning', () => {
    // Nothing changed means nothing is out of scope; an empty diff must not be
    // turned into a phantom path that the advisory then flags.
    const e = entryFor('s1', { files_modified: ['src/x.ts'] });
    const table = { ...presentGit(e), [`diff --name-only HEAD...${e.branch}`]: ok('') };
    const { result, rawCalls } = run([e], table);
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.deepEqual(result.warnings, []);
    assertAllRanAtRepoRoot(rawCalls);
  });

  test('near-miss: a changed path outside the declared scope is flagged and the merge still proceeds', () => {
    const e = entryFor('s2', { files_modified: ['src/x.ts'] });
    const table = { ...presentGit(e), [`diff --name-only HEAD...${e.branch}`]: ok('docs/other.md') };
    const { result } = run([e], table);
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.deepEqual(result.warnings, [{ code: WAVE_CLEANUP_WARNING.SCOPE_OUT_OF_DECLARED, branch: e.branch, path: 'docs/other.md' }]);
  });
});

// ─── Merge timeout reporting ─────────────────────────────────────────────────

describe('executeWorktreeWaveCleanupPlan: merge_timed_out names the budget and the partial output', () => {
  const PREFIX = 'git merge did not finish within 5000 ms and was killed (a merge hook such as '
    + 'pre-merge-commit may still be running; raise deps.mergeTimeoutMs or shorten the hook)';

  function timedOut(streams) {
    const e = entryFor('t1');
    const table = {
      ...presentGit(e),
      [mergeKey(e.branch)]: { exitCode: 1, signal: 'SIGTERM', timedOut: true, ...streams },
      'merge --abort': fail('fatal: There is no merge to abort (MERGE_HEAD missing).'),
      'rev-parse --verify -q MERGE_HEAD': { exitCode: 1, stdout: '', stderr: '' },
      'diff --cached --name-only': ok(''),
      'rev-parse --verify -q MERGE_AUTOSTASH': { exitCode: 1, stdout: '', stderr: '' },
    };
    const { result, rawCalls } = run([e], table, { mergeTimeoutMs: 5000 });
    const mergeCall = rawCalls.find((c) => c.key === mergeKey(e.branch));
    assert.equal(mergeCall.opts.timeout, 5000, 'the merge runs under its own injected budget');
    assert.equal(result.entries[0].reason, 'merge_timed_out');
    return result.entries[0].stderr;
  }

  test('quotes the hook output git captured before the kill, trimmed', () => {
    assert.equal(timedOut({ stderr: 'hook: still linting\n', stdout: 'ignored' }), `${PREFIX}; output before the kill: hook: still linting`);
  });

  test('falls back to stdout when the hook wrote only there', () => {
    assert.equal(timedOut({ stderr: '', stdout: 'hook stdout line' }), `${PREFIX}; output before the kill: hook stdout line`);
  });

  test('near-miss: with no captured output the message carries no empty "output before the kill" tail', () => {
    assert.equal(timedOut({ stderr: '', stdout: '' }), PREFIX);
  });
});

// ─── Wave halt: what is left pending ─────────────────────────────────────────

describe('executeWorktreeWaveCleanupPlan: a halted wave reports exactly the entries it never reached', () => {
  test('repoRoot left mid-merge halts with only the later entries pending', () => {
    // Entries already merged are results, the failing one is a result, and only
    // the ones AFTER it are pending — the orchestrator retries exactly those.
    const [e1, e2, e3] = [entryFor('p1'), entryFor('p2'), entryFor('p3')];
    const table = {
      ...presentGit(e1),
      ...presentGit(e2),
      ...presentGit(e3),
      [mergeKey(e2.branch)]: { exitCode: 1, stdout: 'CONFLICT (content)', stderr: '' },
      'merge --abort': fail('error: could not abort'),
      'rev-parse --verify -q MERGE_HEAD': ok('cafebabe'),
    };
    const { result } = run([e1, e2, e3], table);
    assert.deepEqual(result.entries.map((r) => [r.branch, r.status]), [
      [e1.branch, 'merged_removed'],
      [e2.branch, 'blocked'],
    ]);
    assert.deepEqual(result.pending, [e3]);
  });

  test('a killed merge whose staged residue cannot be restored halts with only the later entries pending', () => {
    const [e1, e2, e3] = [entryFor('k1'), entryFor('k2'), entryFor('k3')];
    const table = {
      ...presentGit(e1),
      ...presentGit(e2),
      ...presentGit(e3),
      [mergeKey(e2.branch)]: { exitCode: 1, stdout: '', stderr: '', timedOut: true },
      'merge --abort': fail('fatal: There is no merge to abort (MERGE_HEAD missing).'),
      'rev-parse --verify -q MERGE_HEAD': { exitCode: 1, stdout: '', stderr: '' },
      'diff --cached --name-only': ok('src/a.ts'),
      'rev-parse --verify -q MERGE_AUTOSTASH': { exitCode: 1, stdout: '', stderr: '' },
      'reset --merge': fail('error: could not reset'),
    };
    const { result } = run([e1, e2, e3], table);
    assert.deepEqual(result.entries.map((r) => [r.branch, r.status, r.reason]), [
      [e1.branch, 'merged_removed', 'ok'],
      [e2.branch, 'blocked', 'merge_timed_out'],
    ]);
    assert.deepEqual(result.pending, [e3]);
    assert.deepEqual(result.warnings, [{ code: WAVE_CLEANUP_WARNING.MERGE_RESIDUE_LEFT_STAGED, branch: e2.branch, path: 'src/a.ts' }]);
  });
});

// ─── Branch delete failure ───────────────────────────────────────────────────

describe('executeWorktreeWaveCleanupPlan: a branch that cannot be deleted is a warning that fails the wave', () => {
  test('the merge landed, so the entry is a warning, not a block — but the wave is not ok', () => {
    // The work is merged, so the entry must not read as blocked (nothing to retry);
    // the leftover branch still needs an operator, so the wave reports cleanup_blocked.
    const e = entryFor('b1');
    const table = { ...presentGit(e), [`branch -D ${e.branch}`]: fail('error: branch is checked out') };
    const { result } = run([e], table);
    assert.deepEqual(result.entries, [{ ...e, status: 'warning', reason: 'branch_delete_failed', stderr: 'error: branch is checked out', warnings: [] }]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'cleanup_blocked');
  });

  test('a branch delete failure with no stderr reports the empty string', () => {
    const e = entryFor('b2');
    const table = { ...presentGit(e), [`branch -D ${e.branch}`]: { exitCode: 1, stdout: '' } };
    assert.equal(run([e], table).result.entries[0].stderr, '');
  });
});

// ─── cmdWorktreeCleanupWave: CLI envelope and exit codes ─────────────────────

/** Run the command in-process, capturing stdout/stderr writes and the exit code. */
function runCmd(cwd, args) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    if (args === undefined) cmdWorktreeCleanupWave(cwd);
    else cmdWorktreeCleanupWave(cwd, args);
    return { stdout: out.join(''), stderr: err.join(''), exitCode: process.exitCode };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = origExit;
  }
}

const USAGE = 'Usage: worktree cleanup-wave --manifest <path>\n';

describe('cmdWorktreeCleanupWave: argument handling', () => {
  const dirs = [];
  after(() => { for (const d of dirs) cleanup(d); });

  for (const [label, args] of [
    ['no arguments at all', undefined],
    ['a positional path without --manifest', ['wave.json']],
    ['--manifest with no value after it', ['--manifest']],
  ]) {
    test(`${label} prints usage to stderr and exits 2 without reading anything`, () => {
      // Exit 2 is "you called it wrong", distinct from exit 1 "the wave did not
      // clean up"; nothing goes to stdout, which callers parse as JSON.
      const dir = createTempDir('gsd-wave-cli-usage-');
      dirs.push(dir);
      fs.writeFileSync(path.join(dir, 'wave.json'), '{"worktrees":[]}');
      assert.deepEqual(runCmd(dir, args), { stdout: '', stderr: USAGE, exitCode: 2 });
    });
  }

  test('an unreadable manifest reports manifest_read_failed as JSON with the fs error, exit 1', () => {
    const dir = createTempDir('gsd-wave-cli-missing-');
    dirs.push(dir);
    let expectedError;
    try { fs.readFileSync(path.join(dir, 'missing.json'), 'utf8'); } catch (e) { expectedError = e.message; }
    const r = runCmd(dir, ['--manifest', 'missing.json']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.stderr, '');
    assert.ok(r.stdout.endsWith('}\n'));
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, reason: 'manifest_read_failed', error: expectedError });
  });

  test('an empty manifest reports the skip plan and its refusal in one envelope, exit 1', () => {
    const dir = createTempDir('gsd-wave-cli-empty-');
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'wave.json'), '{"worktrees":[]}');
    const r = runCmd(dir, ['--manifest', 'wave.json']);
    assert.equal(r.exitCode, 1);
    assert.deepEqual(JSON.parse(r.stdout), {
      ok: false,
      plan: { action: 'skip', discovery: 'manifest', reason: 'empty_manifest', entries: 0 },
      result: { ok: false, action: 'skip', reason: 'empty_manifest', entries: [], pending: [], warnings: [] },
    });
  });
});

describe('cmdWorktreeCleanupWave: a real wave that merges cleanly', () => {
  const dirs = [];
  after(() => { for (const d of dirs) cleanup(d); });

  test('merges the executor branch, removes its worktree, reports ok, and leaves the exit code unset', () => {
    // Near-miss of the exit-1 rows above: success must NOT set a failing exit
    // code, or every orchestrator would treat a clean wave as a failed one.
    const tmp = createTempDir('gsd-wave-cli-real-');
    dirs.push(tmp);
    const repo = path.join(tmp, 'repo');
    const wt = path.join(tmp, 'wt-cw1');
    const branch = 'worktree-agent-cw1';
    const git = (args, cwd) => gitOrThrow(args, { cwd });
    fs.mkdirSync(repo, { recursive: true });
    git(['init', '-q'], repo);
    git(['config', 'user.email', 'test@test.com'], repo);
    git(['config', 'user.name', 'Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'initial'], repo);
    const base = git(['rev-parse', 'HEAD'], repo).trim();
    git(['worktree', 'add', '-q', '-b', branch, wt], repo);
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'done\n');
    git(['add', '-A'], wt);
    git(['commit', '-q', '-m', 'executor work'], wt);
    fs.writeFileSync(path.join(tmp, 'wave.json'), JSON.stringify({
      worktrees: [{ agent_id: 'cw1', worktree_path: wt, branch, expected_base: base }],
    }));

    const r = runCmd(repo, ['--manifest', path.join(tmp, 'wave.json')]);
    assert.equal(r.exitCode, undefined);
    const response = JSON.parse(r.stdout);
    assert.equal(response.ok, true);
    assert.deepEqual(response.plan, { action: 'cleanup_wave', discovery: 'manifest', reason: 'manifest_entries_present', entries: 1 });
    assert.deepEqual(response.result.entries.map((x) => [x.branch, x.status, x.reason]), [[branch, 'merged_removed', 'ok']]);
    assert.equal(fs.existsSync(path.join(repo, 'feature.txt')), true, 'the executor commit landed in the main checkout');
    assert.equal(git(['branch', '--list', branch], repo).trim(), '', 'the executor branch was deleted');
    assert.equal(fs.existsSync(wt), false, 'the worktree directory was removed');
  });
});
