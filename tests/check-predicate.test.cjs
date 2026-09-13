'use strict';

/**
 * Integration tests for the `check predicate` subcommand wiring (#2008).
 *
 * These exercise the PRODUCTION stack: the real `buildPredicateDeps()` binding
 * (which wraps shell-command-projection.execTool → bounded `sh -c` spawnSync) and
 * the `parsePredicateFlags` arg parser. The pure evaluator logic is covered by
 * gate-predicate-evaluator.test.cjs; this file proves the wiring holds against
 * real subprocess exit codes and a real timeout kill.
 *
 * Commands run are instant (`true` / `false` / `exit 3`) or tightly bounded
 * (a 100ms timeout killing `sleep 1`), so there is no orphan/leak risk.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { evaluatePredicate } = require('../gsd-core/bin/lib/gate-predicate-evaluator.cjs');
const { buildPredicateDeps, parsePredicateFlags } = require('../gsd-core/bin/lib/check-command-router.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── buildPredicateDeps: real subprocess exit mapping ─────────────────────────

describe('buildPredicateDeps — real bounded sh -c subprocess', () => {
  const deps = buildPredicateDeps();
  const cwd = process.cwd();

  test('`true` => exitCode 0, not timed out', () => {
    const r = deps.runBoundedShell({ command: 'true', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  });

  test('`false` => exitCode 1, not timed out', () => {
    const r = deps.runBoundedShell({ command: 'false', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 1);
    assert.equal(r.timedOut, false);
  });

  test('`exit 3` => exitCode 3', () => {
    const r = deps.runBoundedShell({ command: 'exit 3', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 3);
  });

  test('stderr is captured from the subprocess', () => {
    const r = deps.runBoundedShell({ command: 'echo oops >&2; exit 4', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 4);
    assert.match(r.stderr, /oops/);
  });

  test('timeout kills the subprocess (SIGTERM => timedOut:true)', () => {
    const r = deps.runBoundedShell({ command: 'sleep 1', cwd, timeoutMs: 100 });
    assert.equal(r.timedOut, true);
    assert.equal(r.signal, 'SIGTERM');
  });
});

// ─── evaluatePredicate + production deps: end-to-end exit mapping ─────────────

describe('evaluatePredicate + production deps — command-exit-zero e2e', () => {
  const deps = buildPredicateDeps();
  const ctx = { cwd: process.cwd() };

  test('command `true` => block:false', () => {
    const res = evaluatePredicate({ kind: 'command-exit-zero', command: 'true' }, ctx, deps);
    assert.equal(res.block, false);
  });

  test('command `false` => block:true', () => {
    const res = evaluatePredicate({ kind: 'command-exit-zero', command: 'false' }, ctx, deps);
    assert.equal(res.block, true);
    assert.match(res.message, /1/);
  });

  test('interpolation reaches the real shell ($PHASE_NUMBER via flag context)', () => {
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'test "${PHASE_NUMBER}" = "07" && true || false' },
      { cwd: process.cwd(), phaseNumber: '07' },
      deps,
    );
    assert.equal(res.block, false);
  });
});

// ─── parsePredicateFlags ───────────────────────────────────────────────────────

describe('parsePredicateFlags', () => {
  test('extracts --flag value pairs, skips positional + bare --flags', () => {
    const out = parsePredicateFlags(['check', 'predicate', '--predicate', '{"kind":"x"}', '--phase-number', '03', '--raw']);
    assert.deepEqual(out, { predicate: '{"kind":"x"}', 'phase-number': '03' });
  });

  test('last write wins for repeated flags', () => {
    const out = parsePredicateFlags(['--phase-number', '01', '--phase-number', '02']);
    assert.equal(out['phase-number'], '02');
  });

  test('value that starts with -- is not consumed (treated as a flag)', () => {
    const out = parsePredicateFlags(['--predicate', '--phase-number']);
    assert.equal('predicate' in out, false);
  });

  test('empty args => empty map', () => {
    assert.deepEqual(parsePredicateFlags([]), {});
  });
});

// ─── #4130 follow-up: partitionPredicateArgs (flags + positionals, one parser) ─

/**
 * `partitionPredicateArgs` is the single pass behind `parsePredicateFlags`:
 * it returns BOTH the --flag value map AND the non-consumed positional tokens
 * under the exact same skip/consume/last-wins semantics. `check
 * decision-coverage-plan --context <path>` uses it so the flag and the
 * positional surface share one parser with `check predicate` — the two
 * parsers cannot diverge because there is only one.
 */
describe('partitionPredicateArgs (#4130 follow-up)', () => {
  const { partitionPredicateArgs } = require('../gsd-core/bin/lib/check-command-router.cjs');

  test('splits --flag value pairs from positionals', () => {
    const { flags, positionals } = partitionPredicateArgs(
      ['check', 'decision-coverage-plan', '--context', '/tmp/CONTEXT.md', 'phases/01-init'],
    );
    assert.deepEqual(flags, { context: '/tmp/CONTEXT.md' });
    assert.deepEqual(positionals, ['check', 'decision-coverage-plan', 'phases/01-init']);
  });

  test('parsePredicateFlags is exactly the flags half (one source of truth)', () => {
    const vectors = [
      ['check', 'predicate', '--predicate', '{"kind":"x"}', '--phase-number', '03', '--raw'],
      ['--phase-number', '01', '--phase-number', '02'],
      ['--predicate', '--phase-number'],
      [],
      ['--context'],
      ['a', '--context', 'b', '--context', 'c', 'd'],
    ];
    for (const v of vectors) {
      assert.deepEqual(partitionPredicateArgs(v).flags, parsePredicateFlags(v),
        `flags half must equal parsePredicateFlags for ${JSON.stringify(v)}`);
    }
  });

  test('value that starts with -- is not consumed: both stay flags, neither becomes positional', () => {
    const { flags, positionals } = partitionPredicateArgs(['--context', '--other']);
    assert.deepEqual(flags, {});
    assert.deepEqual(positionals, ['--context', '--other']);
  });

  test('last write wins; flag values never leak into positionals', () => {
    const { flags, positionals } = partitionPredicateArgs(['p1', '--context', 'a', 'p2', '--context', 'b', 'p3']);
    assert.equal(flags.context, 'b');
    assert.deepEqual(positionals, ['p1', 'p2', 'p3']);
  });
});

// ─── #4354: `check predicate --phase-dir` containment boundary ───────────────
//
// cmdCheckPredicate passes the `--phase-dir` flag VERBATIM into PredicateContext
// (src/check-command-router.cts) with no containment validation. Both predicate
// kinds read/interpolate that value: `artifact-frontmatter-equals` resolves it
// as `targetDir` for `findPhaseArtifact`, and `command-exit-zero` interpolates
// it into `${PHASE_DIR}` in the shelled-out command. These tests reproduce the
// issue's exact repro and prove the boundary is currently unconfined.

describe('check predicate --phase-dir — containment boundary (#4354)', () => {
  let projDir;
  let outsideDir;

  beforeEach(() => {
    projDir = createTempProject();
    fs.mkdirSync(path.join(projDir, '.planning', 'phases', '05-x'), { recursive: true });
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-predicate-outside-'));
  });

  afterEach(() => {
    cleanup(projDir);
    cleanup(outsideDir);
  });

  test('[RED #4354] the issue\'s exact repro: artifact-frontmatter-equals against a foreign SECURITY.md via an outside --phase-dir must be rejected, not evaluated', () => {
    fs.writeFileSync(
      path.join(outsideDir, 'SECURITY.md'),
      '---\nstatus: passed\n---\n# Security\n',
    );

    const predicate = JSON.stringify({
      kind: 'artifact-frontmatter-equals',
      artifact: 'SECURITY.md',
      field: 'status',
      equals: 'passed',
    });

    const result = runGsdTools(
      ['--json-errors', 'check', 'predicate', '--predicate', predicate, '--phase-dir', outsideDir, '--raw'],
      projDir,
    );

    // CURRENT BUG (documented, not asserted as desired): this command today
    // succeeds and prints {"block":false,...} — a BLOCKING gate passing on
    // foreign evidence read from OUTSIDE the project. REQUIRED behavior:
    // the outside --phase-dir must be rejected before evaluation.
    assert.strictEqual(
      result.success,
      false,
      `an outside --phase-dir must be rejected before evaluating the predicate ` +
        `(currently: ${result.success ? `SUCCEEDED with output ${result.output}` : 'failed for an unrelated reason'})`,
    );
  });

  test('[RED #4354] a command-exit-zero predicate interpolating ${PHASE_DIR} with an outside --phase-dir must also be rejected', () => {
    fs.writeFileSync(path.join(outsideDir, 'marker.txt'), 'outside-marker\n');

    const predicate = JSON.stringify({
      kind: 'command-exit-zero',
      command: 'test -f "${PHASE_DIR}/marker.txt"',
    });

    const result = runGsdTools(
      ['--json-errors', 'check', 'predicate', '--predicate', predicate, '--phase-dir', outsideDir, '--raw'],
      projDir,
    );

    assert.strictEqual(
      result.success,
      false,
      `a command-exit-zero predicate interpolating an outside --phase-dir must be rejected ` +
        `(currently: ${result.success ? `SUCCEEDED with output ${result.output}` : 'failed for an unrelated reason'})`,
    );
  });

  test('[regression] a valid in-project --phase-dir still evaluates', () => {
    const phaseDir = path.join(projDir, '.planning', 'phases', '05-x');
    fs.writeFileSync(
      path.join(phaseDir, 'SECURITY.md'),
      '---\nstatus: passed\n---\n# Security\n',
    );
    const predicate = JSON.stringify({
      kind: 'artifact-frontmatter-equals',
      artifact: 'SECURITY.md',
      field: 'status',
      equals: 'passed',
    });

    const result = runGsdTools(
      ['check', 'predicate', '--predicate', predicate, '--phase-dir', phaseDir, '--raw'],
      projDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.block, false, 'in-project phase-dir evaluation must still pass');
  });

  test('[regression #4652] a relative --phase-dir must resolve against --cwd, not the real process cwd, and must not leak the outside file', () => {
    // The real process cwd (outsideDir) contains a foreign SECURITY.md; the
    // CLI is told --cwd projDir with a relative --phase-dir '.'. Before #4652,
    // cmdCheckPredicate validated the joined (projDir + '.') path but passed
    // the RAW, un-joined '.' into ctx.phaseDir, which findPhaseArtifact then
    // resolved against the real process cwd (outsideDir) — leaking foreign
    // frontmatter. The fix must reject this, and the leaked value must never
    // appear in the output.
    fs.writeFileSync(
      path.join(outsideDir, 'SECURITY.md'),
      '---\nstatus: LEAKED_VALUE\n---\n# Security\n',
    );

    const predicate = JSON.stringify({
      kind: 'artifact-frontmatter-equals',
      artifact: 'SECURITY.md',
      field: 'status',
      equals: 'NOPE',
    });

    const result = runGsdTools(
      ['--json-errors', 'check', 'predicate', '--cwd', projDir, '--predicate', predicate, '--phase-dir', '.', '--raw'],
      outsideDir,
    );

    const combinedOutput = `${result.output || ''}${result.error || ''}`;
    assert.ok(
      !combinedOutput.includes('LEAKED_VALUE'),
      `the outside file's frontmatter value must never leak into the output (got: ${combinedOutput})`,
    );
    assert.strictEqual(
      result.success && JSON.parse(result.output).block === false,
      false,
      `a relative --phase-dir must not resolve against the real process cwd and must not pass ` +
        `(currently: ${combinedOutput})`,
    );
  });

  test('[#4652] a --phase-dir that is a symlink inside the project resolving outside the project is rejected', (t) => {
    fs.writeFileSync(
      path.join(outsideDir, 'SECURITY.md'),
      '---\nstatus: passed\n---\n# Security\n',
    );
    const linkPath = path.join(projDir, '.planning', 'phases', 'linked-out');
    try {
      fs.symlinkSync(outsideDir, linkPath, 'dir');
    } catch (e) {
      if (e.code === 'EPERM') {
        t.skip('symlink creation is not permitted on this platform (EPERM)');
        return;
      }
      throw e;
    }

    const predicate = JSON.stringify({
      kind: 'artifact-frontmatter-equals',
      artifact: 'SECURITY.md',
      field: 'status',
      equals: 'passed',
    });

    const result = runGsdTools(
      ['--json-errors', 'check', 'predicate', '--predicate', predicate, '--phase-dir', linkPath, '--raw'],
      projDir,
    );

    assert.strictEqual(
      result.success,
      false,
      `a --phase-dir symlink resolving outside the project must be rejected ` +
        `(currently: ${result.success ? `SUCCEEDED with output ${result.output}` : 'failed for an unrelated reason'})`,
    );
  });

  test('[#4652] a relative --phase-dir interpolates ${PHASE_DIR} as the resolved ABSOLUTE path, not the relative value', () => {
    const phaseDir = path.join(projDir, '.planning', 'phases', '05-x');
    fs.writeFileSync(path.join(phaseDir, 'marker.txt'), 'marker\n');

    const predicate = JSON.stringify({
      kind: 'command-exit-zero',
      command: 'echo "${PHASE_DIR}" > "${PHASE_DIR}/interpolated.txt"',
    });

    const result = runGsdTools(
      ['check', 'predicate', '--predicate', predicate, '--phase-dir', '.planning/phases/05-x', '--raw'],
      projDir,
    );

    assert.ok(result.success, `Command failed: ${result.error}`);
    const interpolated = fs.readFileSync(path.join(phaseDir, 'interpolated.txt'), 'utf-8').trim();
    assert.strictEqual(
      interpolated,
      fs.realpathSync(phaseDir),
      `${'${PHASE_DIR}'} must interpolate the resolved absolute path, not the relative --phase-dir value`,
    );
  });

  test('[regression] no --phase-dir at all still falls back to cwd and evaluates', () => {
    fs.writeFileSync(
      path.join(projDir, 'SECURITY.md'),
      '---\nstatus: passed\n---\n# Security\n',
    );
    const predicate = JSON.stringify({
      kind: 'artifact-frontmatter-equals',
      artifact: 'SECURITY.md',
      field: 'status',
      equals: 'passed',
    });

    const result = runGsdTools(
      ['check', 'predicate', '--predicate', predicate, '--raw'],
      projDir,
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.block, false, 'cwd-fallback evaluation must still pass');
  });
});
