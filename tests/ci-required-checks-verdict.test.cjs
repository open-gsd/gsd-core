'use strict';

// #4990 — merge-queue readiness: single-shot required-check verdict, sourced
// from `gh api .../check-runs` cross-referenced against the ruleset file's
// required contexts (never `gh pr checks --required`, which omits a context
// with no check run yet — see scripts/ci-required-checks-verdict.cjs's
// header for the full BLOCKER-fix rationale).
//
// Risk asymmetry: a false "green" here lets an untested/broken back-merge
// land on `next` with `--admin` (this workflow IS the complete gate — see
// backmerge-merge-when-green.yml's header, live protection on `next` does
// not enforce anything server-side today). A false "pending"/"red"/"error"
// only costs one skipped merge attempt. So every classifier here fails
// CLOSED on anything not positively recognized as green.
//
// Windows note (review fix, BLOCKER): no test in this file spawns a fake
// `gh` binary on PATH. `execFileSync('gh', ...)` without a shell cannot
// resolve a PATH-shadowed `gh.cmd` on win32 — a prior version of this suite
// did that and would have silently fallen through to the REAL gh.exe on a
// Windows runner. Every test here drives `main`/`readVerdict` in-process
// with an injected `run`.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('fast-check');

const {
  GITHUB_ACTIONS_APP_ID,
  STATE,
  normalizeCheckRunState,
  isNewerRun,
  reduceCheckRunsToContextStates,
  classifyRequiredChecks,
  parseRequiredContexts,
  loadRequiredContexts,
  parseCheckRunsPages,
  buildCheckRunsArgv,
  readVerdict,
  parseArgs,
  isPositiveIntegerString,
  main,
} = require('../scripts/ci-required-checks-verdict.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const REAL_RULESET_PATH = path.join(REPO_ROOT, '.github', 'rulesets', 'main-protection.json');

function run(name, overrides = {}) {
  return { name, status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z', app: { id: GITHUB_ACTIONS_APP_ID }, ...overrides };
}

// ---------------------------------------------------------------------------
// A. normalizeCheckRunState — pure, one run -> STATE
// ---------------------------------------------------------------------------

describe('ci-required-checks-verdict: normalizeCheckRunState', () => {
  test('not completed -> pending (queued/in_progress)', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'requested']) {
      assert.equal(normalizeCheckRunState({ status, conclusion: null }), STATE.PENDING);
    }
  });

  test('completed + success/skipped/neutral -> pass', () => {
    for (const conclusion of ['success', 'skipped', 'neutral']) {
      assert.equal(normalizeCheckRunState({ status: 'completed', conclusion }), STATE.PASS);
    }
  });

  test('completed + cancelled -> pending (concurrency supersession)', () => {
    assert.equal(normalizeCheckRunState({ status: 'completed', conclusion: 'cancelled' }), STATE.PENDING);
  });

  test('completed + failure/timed_out/action_required/startup_failure/stale -> red', () => {
    for (const conclusion of ['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
      assert.equal(normalizeCheckRunState({ status: 'completed', conclusion }), STATE.RED);
    }
  });

  test('completed + an unrecognized conclusion -> red (fail closed)', () => {
    assert.equal(normalizeCheckRunState({ status: 'completed', conclusion: 'some-future-value' }), STATE.RED);
  });

  test('a malformed run object -> red', () => {
    for (const value of [null, undefined, 'x', 42]) {
      assert.equal(normalizeCheckRunState(value), STATE.RED);
    }
  });
});

// ---------------------------------------------------------------------------
// A2. isNewerRun — pure, ordering key
// ---------------------------------------------------------------------------

describe('ci-required-checks-verdict: isNewerRun', () => {
  test('a run with NO started_at or created_at is the newest, even against a completed run (review fix, NIT)', () => {
    const queued = { status: 'in_progress', conclusion: null };
    const completed = { status: 'completed', conclusion: 'success', started_at: '2099-01-01T00:00:00Z' };
    assert.equal(isNewerRun(queued, completed), true);
    assert.equal(isNewerRun(completed, queued), false);
  });

  test('falls back to created_at when started_at is missing', () => {
    const a = { created_at: '2026-01-01T00:05:00Z' };
    const b = { started_at: '2026-01-01T00:00:00Z' };
    assert.equal(isNewerRun(a, b), true);
  });

  test('started_at, when present on both, wins over created_at', () => {
    const a = { started_at: '2026-01-01T00:00:00Z', created_at: '2099-01-01T00:00:00Z' };
    const b = { started_at: '2026-01-01T00:05:00Z', created_at: '2000-01-01T00:00:00Z' };
    assert.equal(isNewerRun(a, b), false);
    assert.equal(isNewerRun(b, a), true);
  });

  test('ties on the primary key break on completed_at', () => {
    const a = { started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:01:00Z' };
    const b = { started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:02:00Z' };
    assert.equal(isNewerRun(b, a), true);
  });

  test('two runs with neither timestamp are equal (neither newer)', () => {
    assert.equal(isNewerRun({}, {}), false);
  });
});

// ---------------------------------------------------------------------------
// A3. parseCheckRunsPages / buildCheckRunsArgv — the gh --paginate fix
// ---------------------------------------------------------------------------

describe('ci-required-checks-verdict: parseCheckRunsPages (gh --paginate multi-document stdout)', () => {
  test('buildCheckRunsArgv pins the exact argv — --paginate alone, no --jq/--slurp', () => {
    // Review fix (BLOCKER, code#1): --paginate --slurp --jq together is not
    // a valid gh invocation; the fix drops --slurp/--jq entirely.
    assert.deepEqual(
      buildCheckRunsArgv({ sha: 'a'.repeat(40), repo: 'open-gsd/gsd-core' }),
      ['api', `repos/open-gsd/gsd-core/commits/${'a'.repeat(40)}/check-runs`, '--paginate'],
    );
  });

  test('parses a single-page document', () => {
    const page = JSON.stringify({ total_count: 1, check_runs: [{ name: 'a', status: 'completed', conclusion: 'success' }] });
    assert.deepEqual(parseCheckRunsPages(page), [{ name: 'a', status: 'completed', conclusion: 'success' }]);
  });

  test('parses TWO pages concatenated with no separator (the real gh --paginate shape)', () => {
    const page1 = JSON.stringify({ total_count: 2, check_runs: [{ name: 'a', status: 'completed', conclusion: 'success' }] });
    const page2 = JSON.stringify({ total_count: 2, check_runs: [{ name: 'b', status: 'completed', conclusion: 'failure' }] });
    const result = parseCheckRunsPages(page1 + page2);
    assert.deepEqual(result.map((r) => r.name), ['a', 'b']);
  });

  test('a string value containing brace-like characters does not confuse the bracket scanner', () => {
    const page = JSON.stringify({ total_count: 1, check_runs: [{ name: 'weird } { name', status: 'completed', conclusion: 'success' }] });
    const result = parseCheckRunsPages(page);
    assert.equal(result[0].name, 'weird } { name');
  });

  test('empty/whitespace-only stdout parses to [] (a legitimate zero-page response)', () => {
    for (const value of ['', '   ', '\n']) {
      assert.deepEqual(parseCheckRunsPages(value), []);
    }
  });

  test('garbage (non-JSON) stdout throws', () => {
    assert.throws(() => parseCheckRunsPages('not json at all'));
  });

  test('truncated/unbalanced JSON throws', () => {
    assert.throws(() => parseCheckRunsPages('{"total_count":1,"check_runs":['));
  });

  test('a page object with no check_runs array contributes nothing (tolerated, not an error)', () => {
    assert.deepEqual(parseCheckRunsPages(JSON.stringify({ total_count: 0 })), []);
  });

  test('a bare top-level array document is flattened as-is (test-fixture convenience)', () => {
    const doc = JSON.stringify([{ name: 'a', status: 'completed', conclusion: 'success' }]);
    assert.deepEqual(parseCheckRunsPages(doc), [{ name: 'a', status: 'completed', conclusion: 'success' }]);
  });
});

// ---------------------------------------------------------------------------
// B. reduceCheckRunsToContextStates — pure, raw API array -> per-context state
// ---------------------------------------------------------------------------

describe('ci-required-checks-verdict: reduceCheckRunsToContextStates', () => {
  const REQUIRED = ['check-branch', 'changeset-lint'];

  test('a run whose app.id is not GitHub Actions is ignored (context stays missing)', () => {
    const runs = [run('check-branch', { app: { id: 99999 } })];
    const states = reduceCheckRunsToContextStates(runs, REQUIRED);
    assert.deepEqual(states, {});
  });

  test('a run whose name does not match any required context is ignored', () => {
    const runs = [run('some-other-check')];
    const states = reduceCheckRunsToContextStates(runs, REQUIRED);
    assert.deepEqual(states, {});
  });

  test('duplicate name: a newer PASS supersedes an older RED', () => {
    const runs = [
      run('check-branch', { conclusion: 'failure', started_at: '2026-01-01T00:00:00Z' }),
      run('check-branch', { conclusion: 'success', started_at: '2026-01-01T00:05:00Z' }),
    ];
    const states = reduceCheckRunsToContextStates(runs, REQUIRED);
    assert.equal(states['check-branch'], STATE.PASS);
  });

  test('duplicate name: an older PASS never masks a newer RED', () => {
    const runs = [
      run('check-branch', { conclusion: 'success', started_at: '2026-01-01T00:00:00Z' }),
      run('check-branch', { conclusion: 'failure', started_at: '2026-01-01T00:05:00Z' }),
    ];
    const states = reduceCheckRunsToContextStates(runs, REQUIRED);
    assert.equal(states['check-branch'], STATE.RED);
  });

  test('a newer cancelled run supersedes an older pass into pending', () => {
    const runs = [
      run('check-branch', { conclusion: 'success', started_at: '2026-01-01T00:00:00Z' }),
      run('check-branch', { conclusion: 'cancelled', started_at: '2026-01-01T00:05:00Z' }),
    ];
    const states = reduceCheckRunsToContextStates(runs, REQUIRED);
    assert.equal(states['check-branch'], STATE.PENDING);
  });

  // #4990 review fix (NIT 15): auto-backmerge.yml's `gh pr edit --add-label`
  // re-triggers `labeled`-typed workflow listeners on every re-run of "Open
  // or update PR" — any run that was already in flight when the labels
  // change shows up as `cancelled` (GitHub's own concurrency supersession),
  // never as a real failure. This is the same "cancelled -> pending" rule
  // above, exercised against a superseded-by-a-newer-run shape rather than a
  // bare two-run fixture, so the scenario the finding names has its own
  // named regression test.
  test('a labeled-workflow re-trigger that supersedes an in-flight run reads pending, not red', () => {
    const runs = [
      run('check-branch', { conclusion: 'cancelled', started_at: '2026-01-01T00:00:00Z' }), // superseded, in-flight run
      run('check-branch', { status: 'in_progress', conclusion: null, started_at: '2026-01-01T00:05:00Z' }), // the re-triggered run
    ];
    const states = reduceCheckRunsToContextStates(runs, REQUIRED);
    assert.equal(states['check-branch'], STATE.PENDING, 'must never read red just because an older run was cancelled by the re-trigger');
  });

  test('ties on started_at break on completed_at (newer completed wins)', () => {
    const runs = [
      run('check-branch', { conclusion: 'failure', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:01:00Z' }),
      run('check-branch', { conclusion: 'success', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:02:00Z' }),
    ];
    const states = reduceCheckRunsToContextStates(runs, REQUIRED);
    assert.equal(states['check-branch'], STATE.PASS);
  });

  test('a required context with zero matching runs is absent from the result (caller treats as missing/pending)', () => {
    const states = reduceCheckRunsToContextStates([run('check-branch')], REQUIRED);
    assert.deepEqual(Object.keys(states), ['check-branch']);
  });

  test('a non-array input reduces to {}', () => {
    for (const value of [undefined, null, 'x', {}]) {
      assert.deepEqual(reduceCheckRunsToContextStates(value, REQUIRED), {});
    }
  });
});

// ---------------------------------------------------------------------------
// C. classifyRequiredChecks — THE pure classifier, over normalized states
// ---------------------------------------------------------------------------

describe('ci-required-checks-verdict: classifyRequiredChecks', () => {
  const REQUIRED = ['a', 'b', 'c'];

  test('every required context present and pass -> green', () => {
    const result = classifyRequiredChecks(REQUIRED, { a: STATE.PASS, b: STATE.PASS, c: STATE.PASS });
    assert.equal(result.verdict, 'green');
  });

  test('a missing context (absent from contextStates) -> pending, never green', () => {
    const result = classifyRequiredChecks(REQUIRED, { a: STATE.PASS, b: STATE.PASS }); // c missing
    assert.equal(result.verdict, 'pending');
    assert.equal(result.perContext.c, STATE.PENDING);
  });

  test('a subset of required contexts all green is NOT green overall', () => {
    const result = classifyRequiredChecks(REQUIRED, { a: STATE.PASS });
    assert.notEqual(result.verdict, 'green');
    assert.equal(result.verdict, 'pending');
  });

  test('any red -> red, even alongside passes and pendings', () => {
    const result = classifyRequiredChecks(REQUIRED, { a: STATE.PASS, b: STATE.RED, c: STATE.PENDING });
    assert.equal(result.verdict, 'red');
  });

  test('empty contextStates with a non-empty required list -> pending, never crashes', () => {
    const result = classifyRequiredChecks(REQUIRED, {});
    assert.equal(result.verdict, 'pending');
    assert.deepEqual(result.perContext, { a: STATE.PENDING, b: STATE.PENDING, c: STATE.PENDING });
  });

  // Property 1: green iff every required context is present in contextStates
  // AND its state is pass.
  const stateArb = fc.constantFrom(STATE.PASS, STATE.PENDING, STATE.RED);
  const partialStatesArb = (contexts) => fc.dictionary(fc.constantFrom(...contexts), stateArb);

  test('green iff every required context present and pass (property)', () => {
    fc.assert(
      fc.property(partialStatesArb(REQUIRED), (contextStates) => {
        const verdict = classifyRequiredChecks(REQUIRED, contextStates).verdict;
        const allPresentAndPass = REQUIRED.every((c) => contextStates[c] === STATE.PASS);
        return (verdict === 'green') === allPresentAndPass;
      }),
      { seed: 4990, numRuns: 500, verbose: true },
    );
  });

  test('any missing required context never yields green (property)', () => {
    const missingOneArb = fc.tuple(
      fc.constantFrom(...REQUIRED),
      partialStatesArb(REQUIRED),
    ).map(([omit, states]) => {
      const { [omit]: _dropped, ...rest } = states;
      return rest;
    });
    fc.assert(
      fc.property(missingOneArb, (contextStates) => classifyRequiredChecks(REQUIRED, contextStates).verdict !== 'green'),
      { seed: 4991, numRuns: 300, verbose: true },
    );
  });
});

// ---------------------------------------------------------------------------
// D. parseRequiredContexts / loadRequiredContexts
// ---------------------------------------------------------------------------

describe('ci-required-checks-verdict: parseRequiredContexts / loadRequiredContexts', () => {
  test('extracts contexts from a well-formed ruleset doc', () => {
    const doc = {
      rules: [
        { type: 'deletion' },
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'a' }, { context: 'b' }] } },
      ],
    };
    assert.deepEqual(parseRequiredContexts(doc), ['a', 'b']);
  });

  test('throws when no required_status_checks rule is present', () => {
    assert.throws(() => parseRequiredContexts({ rules: [{ type: 'deletion' }] }), /required_status_checks/);
  });

  test('throws when the rule has zero contexts', () => {
    const doc = { rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [] } }] };
    assert.throws(() => parseRequiredContexts(doc), /zero contexts/);
  });

  test('loadRequiredContexts reads the REAL repo ruleset and matches the 7 documented contexts', () => {
    const contexts = loadRequiredContexts(REAL_RULESET_PATH);
    assert.deepEqual(
      contexts.sort(),
      [
        'Issue link required', 'Pull request template format', 'Required tests',
        'changeset-lint', 'check-branch', 'docs-lint', 'validate-target',
      ].sort(),
    );
  });

  test('loadRequiredContexts throws (not silently empty) on an unreadable path', () => {
    assert.throws(() => loadRequiredContexts(path.join(REPO_ROOT, 'no-such-ruleset.json')));
  });
});

// ---------------------------------------------------------------------------
// E. readVerdict — dependency-injected single-shot read
// ---------------------------------------------------------------------------

describe('ci-required-checks-verdict: readVerdict', () => {
  const REQUIRED = ['check-branch', 'changeset-lint'];

  test('resolves green from a clean run() that returns all-pass JSON', async () => {
    const calls = [];
    const runFn = async (args) => { calls.push(args); return JSON.stringify(REQUIRED.map((c) => run(c))); };
    const result = await readVerdict({ sha: 'a'.repeat(40), repo: 'o/r', requiredContexts: REQUIRED, run: runFn });
    assert.equal(result.verdict, 'green');
    assert.deepEqual(calls, [{ sha: 'a'.repeat(40), repo: 'o/r' }]);
  });

  test('resolves pending when a required context has no matching run', async () => {
    const runFn = async () => JSON.stringify([run('check-branch')]); // changeset-lint missing
    const result = await readVerdict({ sha: 'a'.repeat(40), repo: 'o/r', requiredContexts: REQUIRED, run: runFn });
    assert.equal(result.verdict, 'pending');
  });

  test('resolves red when a required context failed', async () => {
    const runFn = async () => JSON.stringify([run('check-branch'), run('changeset-lint', { conclusion: 'failure' })]);
    const result = await readVerdict({ sha: 'a'.repeat(40), repo: 'o/r', requiredContexts: REQUIRED, run: runFn });
    assert.equal(result.verdict, 'red');
  });

  test('a thrown run() error -> error', async () => {
    const runFn = async () => { throw new Error('ECONNRESET'); };
    const result = await readVerdict({ sha: 'a'.repeat(40), repo: 'o/r', requiredContexts: REQUIRED, run: runFn });
    assert.deepEqual(result, { verdict: 'error', perContext: {} });
  });

  // Review fix (MINOR): a CLEAN resolve with unparseable stdout is 'error',
  // not 'none' — the old 'none' verdict no longer exists in this design.
  test('a clean resolve with malformed JSON -> error (not silently pending/green)', async () => {
    const runFn = async () => '{not json';
    const result = await readVerdict({ sha: 'a'.repeat(40), repo: 'o/r', requiredContexts: REQUIRED, run: runFn });
    assert.deepEqual(result, { verdict: 'error', perContext: {} });
  });

  test('a clean resolve with a real gh --paginate page-object shape (check_runs: []) is pending, not error', async () => {
    // {check_runs:[]} is the REAL single-page response shape (review fix,
    // BLOCKER, code#1 — this used to be tested as "not an array -> error"
    // under the old, invalid --slurp --jq assumption that flattened stdout
    // into a bare array; the real shape is a page object).
    const runFn = async () => JSON.stringify({ total_count: 0, check_runs: [] });
    const result = await readVerdict({ sha: 'a'.repeat(40), repo: 'o/r', requiredContexts: REQUIRED, run: runFn });
    assert.equal(result.verdict, 'pending');
  });

  test('a clean resolve with genuinely unparseable JSON -> error', async () => {
    const runFn = async () => 'not json at all';
    const result = await readVerdict({ sha: 'a'.repeat(40), repo: 'o/r', requiredContexts: REQUIRED, run: runFn });
    assert.equal(result.verdict, 'error');
  });

  test('a clean resolve with an empty array -> pending (real data: zero runs recorded)', async () => {
    const runFn = async () => '[]';
    const result = await readVerdict({ sha: 'a'.repeat(40), repo: 'o/r', requiredContexts: REQUIRED, run: runFn });
    assert.equal(result.verdict, 'pending');
  });

  test('non-Actions app runs with the exact required name are ignored -> still missing -> pending', async () => {
    const runFn = async () => JSON.stringify([
      run('check-branch', { app: { id: 1 } }),
      run('changeset-lint'),
    ]);
    const result = await readVerdict({ sha: 'a'.repeat(40), repo: 'o/r', requiredContexts: REQUIRED, run: runFn });
    assert.equal(result.verdict, 'pending');
    assert.equal(result.perContext['check-branch'], STATE.PENDING);
  });
});

// ---------------------------------------------------------------------------
// F. main() — in-process, injected argv/run/stdout/stderr (no subprocess)
// ---------------------------------------------------------------------------

function captureStream() {
  const chunks = [];
  return { write: (c) => { chunks.push(String(c)); return true; }, text: () => chunks.join('') };
}

describe('ci-required-checks-verdict: main()', () => {
  const SHA = 'b'.repeat(40);

  test('exit 0 on green, and run() receives exactly {sha, repo}', async () => {
    const calls = [];
    const runFn = async (args) => {
      calls.push(args);
      const contexts = loadRequiredContexts(REAL_RULESET_PATH);
      return JSON.stringify(contexts.map((c) => run(c)));
    };
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await main({
      argv: ['--sha', SHA, '--repo', 'open-gsd/gsd-core', '--required-from', REAL_RULESET_PATH],
      run: runFn, stdout, stderr,
    });
    assert.equal(code, 0);
    assert.match(stdout.text(), /"verdict":"green"/);
    assert.deepEqual(calls, [{ sha: SHA, repo: 'open-gsd/gsd-core' }]);
  });

  test('exit 2 on pending', async () => {
    const runFn = async () => '[]';
    const stdout = captureStream();
    const code = await main({
      argv: ['--sha', SHA, '--repo', 'o/r', '--required-from', REAL_RULESET_PATH],
      run: runFn, stdout, stderr: captureStream(),
    });
    assert.equal(code, 2);
    assert.match(stdout.text(), /"verdict":"pending"/);
  });

  test('exit 1 on red, with a ::error:: annotation naming the failing context', async () => {
    const runFn = async () => JSON.stringify([run('check-branch', { conclusion: 'failure' })]);
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await main({
      argv: ['--sha', SHA, '--repo', 'o/r', '--required-from', REAL_RULESET_PATH, '--pr', '7'],
      run: runFn, stdout, stderr,
    });
    assert.equal(code, 1);
    assert.match(stdout.text(), /"verdict":"red"/);
    assert.ok(stderr.text().includes('::error::'));
    assert.ok(stderr.text().includes('check-branch'));
  });

  test('exit 1 on a read error', async () => {
    const runFn = async () => { throw new Error('boom'); };
    const stderr = captureStream();
    const code = await main({
      argv: ['--sha', SHA, '--repo', 'o/r', '--required-from', REAL_RULESET_PATH],
      run: runFn, stdout: captureStream(), stderr,
    });
    assert.equal(code, 1);
    assert.ok(stderr.text().includes('::error::'));
  });

  test('rejects --sha that is not 40 hex chars', async () => {
    await assert.rejects(
      () => main({ argv: ['--sha', 'nope', '--repo', 'o/r', '--required-from', REAL_RULESET_PATH], run: async () => '[]' }),
      /--sha/,
    );
  });
});

// ---------------------------------------------------------------------------
// G. parseArgs / isPositiveIntegerString — boundary (limit-1/limit/limit+1)
// ---------------------------------------------------------------------------

describe('ci-required-checks-verdict: parseArgs', () => {
  const SHA = 'c'.repeat(40);

  test('parses --sha/--repo/--required-from', () => {
    const out = parseArgs(['--sha', SHA, '--repo', 'o/r', '--required-from', 'x.json']);
    assert.deepEqual(out, { sha: SHA, repo: 'o/r', requiredFrom: 'x.json', pr: undefined });
  });

  test('accepts an optional --pr', () => {
    const out = parseArgs(['--sha', SHA, '--repo', 'o/r', '--required-from', 'x.json', '--pr', '5']);
    assert.equal(out.pr, '5');
  });

  test('--pr boundary: 0 is rejected, 1 and 2 are accepted', () => {
    assert.throws(
      () => parseArgs(['--sha', SHA, '--repo', 'o/r', '--required-from', 'x.json', '--pr', '0']),
      /--pr/,
    );
    for (const value of ['1', '2']) {
      const out = parseArgs(['--sha', SHA, '--repo', 'o/r', '--required-from', 'x.json', '--pr', value]);
      assert.equal(out.pr, value);
    }
  });

  test('isPositiveIntegerString boundary: "0" false, "1"/"2" true', () => {
    assert.equal(isPositiveIntegerString('0'), false);
    assert.equal(isPositiveIntegerString('1'), true);
    assert.equal(isPositiveIntegerString('2'), true);
  });

  test('rejects a missing --sha', () => {
    assert.throws(() => parseArgs(['--repo', 'o/r', '--required-from', 'x.json']), /--sha/);
  });

  test('rejects a --sha that is not exactly 40 hex characters', () => {
    for (const bad of ['', 'zz'.repeat(20), 'a'.repeat(39), 'a'.repeat(41)]) {
      assert.throws(() => parseArgs(['--sha', bad, '--repo', 'o/r', '--required-from', 'x.json']), /--sha/);
    }
  });

  test('rejects a missing --repo', () => {
    assert.throws(() => parseArgs(['--sha', SHA, '--required-from', 'x.json']), /--repo/);
  });

  test('rejects a missing --required-from', () => {
    assert.throws(() => parseArgs(['--sha', SHA, '--repo', 'o/r']), /--required-from/);
  });

  test('rejects an unknown argument', () => {
    assert.throws(() => parseArgs(['--sha', SHA, '--repo', 'o/r', '--required-from', 'x.json', '--nope']), /unknown argument/);
  });
});
