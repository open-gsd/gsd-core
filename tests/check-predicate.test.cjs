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
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runHook } = require('./helpers/process-seam.cjs');

const NO_SH = process.platform === 'win32' || runHook('-c', ['exit 0'], {
  interpreter: 'sh', timeoutMs: PROBE_TIMEOUT_MS,
}).exitCode !== 0;

/**
 * A real, bounded `sh -c` subprocess spawned via the production
 * runBoundedShell dependency -- the describe block's own name is "real
 * bounded sh -c subprocess."
 */
// #4378 (windows conformance lane): the local 5000ms bound timed out on a
// cold sh.exe spawn under windows-latest shard load while the identical code
// passed twice earlier the same day -- the probe now uses the class norm
// (tests/helpers/timeouts.cjs PROBE_TIMEOUT_MS) instead of a local override.
const BOUNDED_SHELL_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;

/**
 * The same runBoundedShell call as BOUNDED_SHELL_PROBE_TIMEOUT_MS, but
 * deliberately tiny (not generous headroom) to force a `sleep 1` command
 * past the bound within this test's own lifetime, proving "timeout kills
 * the subprocess (SIGTERM => timedOut:true)."
 */
const BOUNDED_SHELL_FORCED_TIMEOUT_MS = 100;

// ─── buildPredicateDeps: real subprocess exit mapping ─────────────────────────

describe('buildPredicateDeps — real bounded sh -c subprocess', () => {
  const deps = buildPredicateDeps();
  const cwd = process.cwd();

  test('`true` => exitCode 0, not timed out', () => {
    const r = deps.runBoundedShell({ command: 'true', cwd, timeoutMs: BOUNDED_SHELL_PROBE_TIMEOUT_MS, env: {} });
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  });

  test('`false` => exitCode 1, not timed out', () => {
    const r = deps.runBoundedShell({ command: 'false', cwd, timeoutMs: BOUNDED_SHELL_PROBE_TIMEOUT_MS, env: {} });
    assert.equal(r.exitCode, 1);
    assert.equal(r.timedOut, false);
  });

  test('`exit 3` => exitCode 3', () => {
    const r = deps.runBoundedShell({ command: 'exit 3', cwd, timeoutMs: BOUNDED_SHELL_PROBE_TIMEOUT_MS, env: {} });
    assert.equal(r.exitCode, 3);
  });

  test('stderr is captured from the subprocess', () => {
    const r = deps.runBoundedShell({ command: 'echo oops >&2; exit 4', cwd, timeoutMs: BOUNDED_SHELL_PROBE_TIMEOUT_MS, env: {} });
    assert.equal(r.exitCode, 4);
    assert.match(r.stderr, /oops/);
  });

  test('timeout kills the subprocess (SIGTERM => timedOut:true)', () => {
    const r = deps.runBoundedShell({ command: 'sleep 1', cwd, timeoutMs: BOUNDED_SHELL_FORCED_TIMEOUT_MS, env: {} });
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

  test('phase environment reaches the real shell (GSD_GATE_PHASE_NUMBER via flag context)', () => {
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'test "$GSD_GATE_PHASE_NUMBER" = "07" && true || false' },
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
// evaluateCheckPredicate validates and resolves the flag before either predicate
// kind is evaluated. Artifact predicates read that directory; command predicates
// receive its resolved absolute path as GSD_GATE_PHASE_DIR environment data.
// These tests preserve #4354 confinement through the #5318 transport migration.

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

  test('[RED #4354] a command-exit-zero predicate receiving GSD_GATE_PHASE_DIR with an outside --phase-dir must also be rejected', () => {
    fs.writeFileSync(path.join(outsideDir, 'marker.txt'), 'outside-marker\n');

    const predicate = JSON.stringify({
      kind: 'command-exit-zero',
      command: 'test -f "$GSD_GATE_PHASE_DIR/marker.txt"',
    });

    const result = runGsdTools(
      ['--json-errors', 'check', 'predicate', '--predicate', predicate, '--phase-dir', outsideDir, '--raw'],
      projDir,
    );

    assert.strictEqual(
      result.success,
      false,
      `a command-exit-zero predicate receiving an outside --phase-dir must be rejected ` +
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

  test('[#4652] a relative --phase-dir supplies GSD_GATE_PHASE_DIR as the resolved ABSOLUTE path, not the relative value', () => {
    const phaseDir = path.join(projDir, '.planning', 'phases', '05-x');
    fs.writeFileSync(path.join(phaseDir, 'marker.txt'), 'marker\n');

    const predicate = JSON.stringify({
      kind: 'command-exit-zero',
      command: 'echo "$GSD_GATE_PHASE_DIR" > "$GSD_GATE_PHASE_DIR/context-path.txt"',
    });

    const result = runGsdTools(
      ['check', 'predicate', '--predicate', predicate, '--phase-dir', '.planning/phases/05-x', '--raw'],
      projDir,
    );

    assert.ok(result.success, `Command failed: ${result.error}`);
    const contextPath = fs.readFileSync(path.join(phaseDir, 'context-path.txt'), 'utf-8').trim();
    assert.strictEqual(
      contextPath,
      fs.realpathSync(phaseDir),
      'GSD_GATE_PHASE_DIR must contain the resolved absolute path, not the relative --phase-dir value',
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

// ─── published CLI and actual bounded shell ────────────────────────────────────

describe('check predicate — literal phase data through the CLI', { skip: NO_SH ? 'requires a POSIX host with sh on PATH' : false }, () => {
  for (const name of ['11-$(touch PWNED)-x', '11-`touch PWNED2`-x', "11-o'brien", '11-double"quote', '11-$(touch PWNED)-`touch PWNED2`-\'"']) {
    test(`phase directory ${name} reaches argv literally without substitution side effects`, () => {
      const dir = createTempProject('gate-phase-env-');
      try {
        const phaseDir = path.join(dir, '.planning', 'phases', name);
        fs.mkdirSync(phaseDir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'check.cjs'), `
          const fs = require('node:fs');
          const expected = [process.env.EXPECTED_DIR, process.env.EXPECTED_NUMBER, process.env.EXPECTED_IDS, process.env.INHERITED_GATE_SENTINEL];
          const actual = process.argv.slice(2);
          process.exitCode = JSON.stringify(actual) === JSON.stringify(expected)
            && fs.statSync(actual[0]).isDirectory()
            && process.env.INHERITED_GATE_SENTINEL === 'inherited' ? 0 : 8;
        `);
        const phaseNumber = '11-$(touch NUMBER_PWNED)-\'"';
        const phaseReqIds = 'R-1 `touch IDS_PWNED` $(touch IDS_PWNED2) \'"';
        const command = 'node check.cjs "$GSD_GATE_PHASE_DIR" "$GSD_GATE_PHASE_NUMBER" "$GSD_GATE_PHASE_REQ_IDS" "${INHERITED_GATE_SENTINEL}"';
        const result = runGsdTools([
          'check', 'predicate', '--predicate', JSON.stringify({ kind: 'command-exit-zero', command }),
          '--phase-dir', path.relative(dir, phaseDir), '--phase-number', phaseNumber, '--phase-req-ids', phaseReqIds,
        ], dir, {
          EXPECTED_DIR: fs.realpathSync(phaseDir), EXPECTED_NUMBER: phaseNumber, EXPECTED_IDS: phaseReqIds,
          INHERITED_GATE_SENTINEL: 'inherited', GSD_GATE_PHASE_DIR: 'ambient-wrong-value',
        });
        assert.equal(result.exitCode, 0, result.output);
        const payload = JSON.parse(result.output);
        assert.equal(payload.block, false, JSON.stringify(payload));
        assert.equal(payload.details.exitCode, 0);
        for (const marker of ['PWNED', 'PWNED2', 'NUMBER_PWNED', 'IDS_PWNED', 'IDS_PWNED2']) {
          assert.equal(fs.existsSync(path.join(dir, marker)), false, marker);
        }
      } finally { cleanup(dir); }
    });
  }

  test('absent context overwrites inherited gate values with empty data', () => {
    const dir = createTempProject('gate-phase-empty-');
    try {
      const result = runGsdTools(['check', 'predicate', '--predicate', JSON.stringify({
        kind: 'command-exit-zero', command: 'test "$GSD_GATE_PHASE_DIR$GSD_GATE_PHASE_NUMBER$GSD_GATE_PHASE_REQ_IDS" = ""',
      })], dir, { GSD_GATE_PHASE_DIR: 'old-dir', GSD_GATE_PHASE_NUMBER: 'old-number', GSD_GATE_PHASE_REQ_IDS: 'old-ids' });
      assert.equal(result.exitCode, 0);
      assert.equal(JSON.parse(result.output).block, false);
    } finally { cleanup(dir); }
  });

  test('real command failures and shell spawn errors remain blocking predicate results', () => {
    const dir = createTempProject('gate-phase-outcome-');
    try {
      const predicate = JSON.stringify({ kind: 'command-exit-zero', command: 'exit 3' });
      const failed = runGsdTools(['check', 'predicate', '--predicate', predicate], dir);
      assert.equal(failed.exitCode, 0, 'a negative verdict is a successful check dispatch');
      assert.equal(JSON.parse(failed.output).block, true);
      assert.equal(JSON.parse(failed.output).details.exitCode, 3);
      const missing = runGsdTools(['check', 'predicate', '--predicate', predicate], dir, { PATH: '' });
      assert.equal(missing.exitCode, 0);
      assert.equal(JSON.parse(missing.output).block, true);
      assert.equal(JSON.parse(missing.output).details.exitCode, 127);
    } finally { cleanup(dir); }
  });

  test('actual timeout is distinguished from a command terminating itself', () => {
    const dir = createTempProject('gate-phase-timeout-');
    try {
      const deps = buildPredicateDeps();
      // Fixture timeout: a busy shell has no background descendants; the tiny budget forces its own timeout.
      const EXPIRING_TIMEOUT_SECONDS = 0.025;
      const timedOut = evaluatePredicate({ kind: 'command-exit-zero', command: 'while :; do :; done', timeout: EXPIRING_TIMEOUT_SECONDS }, { cwd: dir }, deps);
      assert.equal(timedOut.block, true);
      assert.equal(timedOut.details.timedOut, true);
      const terminated = evaluatePredicate({ kind: 'command-exit-zero', command: 'kill -TERM $$' }, { cwd: dir }, deps);
      assert.equal(terminated.block, true);
      assert.equal(terminated.details.exitCode, 1, 'execTool maps a signal-only termination to exit 1');
      assert.equal(terminated.details.signal, 'SIGTERM');
      assert.equal(terminated.details.timedOut, undefined);
    } finally { cleanup(dir); }
  });
});

test('check predicate rejects old context spellings as usage errors before shell side effects', () => {
  const dir = createTempProject('gate-phase-legacy-');
  try {
    for (const variable of ['GSD_GATE_PHASE_DIR', 'GSD_GATE_PHASE_NUMBER', 'GSD_GATE_PHASE_REQ_IDS']) {
      const name = variable.slice('GSD_GATE_'.length);
      const result = runGsdTools(['check', 'predicate', '--predicate', JSON.stringify({
        kind: 'command-exit-zero', command: 'touch SHOULD_NOT_RUN; echo "${' + name + '}"',
      })], dir, { GSD_JSON_ERRORS: '1', GSD_EXIT_CONTRACT: 'v2' });
      assert.equal(result.exitCode, 64);
      const diagnostic = JSON.parse(result.error);
      assert.equal(diagnostic.reason, 'usage');
      assert.ok(diagnostic.message.includes('$GSD_GATE_' + name));
      assert.equal(fs.existsSync(path.join(dir, 'SHOULD_NOT_RUN')), false);
    }
  } finally { cleanup(dir); }
});
