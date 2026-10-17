'use strict';

/**
 * Pure-core tests for the gate-predicate evaluator — #2008 / #5318.
 *
 * The evaluator is a pure, deps-injected function:
 *   evaluatePredicate(predicate, context, deps) -> { block, message, details? }
 * Malformed predicates / unknown kinds THROW (the CLI wrapper maps a throw to a
 * check-command failure so the workflow's `onError` step-1 contract applies).
 *
 * Built-in kind: `command-exit-zero` — runs a declared command via an injected
 * bounded-shell seam; exit 0 => pass, non-zero => block, timeout => block.
 *
 * Per RULESET.TESTS.boundary-coverage: exit code boundary (0/1/2), timedOut
 * true/false, message-trim boundary (MAX / MAX+1), timeout pass-through.
 * Per RULESET.TESTS.property-based-testing: command identity and environment round-trip properties (fast-check).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  evaluatePredicate,
  COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS,
  COMMAND_MAX_OUTPUT_CHARS,
  COMMAND_MAX_LENGTH,
  EVALUATOR_KINDS,
} = require('../gsd-core/bin/lib/gate-predicate-evaluator.cjs');

/**
 * NOT a subprocess spawn timeout. Fixture DATA: an arbitrary declarative
 * `timeout` value (seconds) feeding a canned timedOut:true fake-shell
 * response -- the value itself is not asserted on, only the resulting
 * block/message behavior.
 */
const PREDICATE_TIMEOUT_FIXTURE_SECONDS = 5;
/**
 * NOT a subprocess spawn timeout. Fixture DATA: specifically tests the
 * predicate's own seconds-to-milliseconds conversion -- the assertion
 * below checks the converted value is exactly this times 1000.
 */
const PREDICATE_TIMEOUT_CUSTOM_SECONDS = 90;
/** NOT a subprocess spawn timeout. Fixture DATA: a deliberately-invalid (zero) declarative timeout value, proving the predicate validator rejects a non-positive timeout. */
const INVALID_PREDICATE_TIMEOUT_ZERO = 0;
/** NOT a subprocess spawn timeout. Fixture DATA: a deliberately-invalid (negative) declarative timeout value, proving the predicate validator rejects a non-positive timeout. */
const INVALID_PREDICATE_TIMEOUT_NEGATIVE = -5;

// ─── Fake bounded-shell seam ──────────────────────────────────────────────────

/** Build a fake runBoundedShell that records the invocation and returns a preset result. */
function fakeShell(preset) {
  const calls = [];
  const run = (opts) => {
    calls.push(opts);
    return {
      exitCode: preset.exitCode === undefined ? 0 : preset.exitCode,
      stdout: preset.stdout ?? '',
      stderr: preset.stderr ?? '',
      signal: preset.signal ?? null,
      timedOut: preset.timedOut ?? false,
    };
  };
  return { run, calls };
}

const baseCtx = { cwd: '/proj', phaseNumber: '03', phaseDir: '/proj/.planning/phases/03-x', phaseReqIds: 'R-1' };

/** Discover the context namespace from the actual shell seam, rather than a second name roster. */
function phaseContextVariableNames() {
  const shell = fakeShell({ exitCode: 0 });
  evaluatePredicate({ kind: 'command-exit-zero', command: 'true' }, baseCtx, { runBoundedShell: shell.run });
  assert.deepEqual(shell.calls[0].env, {
    GSD_GATE_PHASE_NUMBER: baseCtx.phaseNumber,
    GSD_GATE_PHASE_DIR: baseCtx.phaseDir,
    GSD_GATE_PHASE_REQ_IDS: baseCtx.phaseReqIds,
  });
  return Object.keys(shell.calls[0].env).map((name) => name.slice('GSD_GATE_'.length));
}


// ─── command-exit-zero: exit-code boundary (0 / 1 / 2) ─────────────────────────

describe('evaluatePredicate — command-exit-zero exit mapping', () => {
  test('exit 0 => block:false (gate passes)', () => {
    const shell = fakeShell({ exitCode: 0 });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'true' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, false);
    assert.match(res.message, /exit/i);
  });

  test('exit 1 => block:true', () => {
    const shell = fakeShell({ exitCode: 1, stderr: 'boom' });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'false' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
    assert.match(res.message, /1/);
    assert.match(res.message, /boom/);
  });

  test('exit 2 => block:true (boundary above 1)', () => {
    const shell = fakeShell({ exitCode: 2 });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'bad' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
  });

  test('a signal-only result with a null exit code blocks', () => {
    const shell = fakeShell({ exitCode: null, signal: 'SIGKILL' });
    const result = evaluatePredicate({ kind: 'command-exit-zero', command: 'x' }, baseCtx, { runBoundedShell: shell.run });
    assert.equal(result.block, true);
    assert.equal(result.details.exitCode, null);
    assert.equal(result.details.signal, 'SIGKILL');
  });

  test('exit 127 (ENOENT) => block:true, surfaces not-found', () => {
    const shell = fakeShell({ exitCode: 127, stderr: 'sh: not found' });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'nope' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
    assert.match(res.message, /not found|127/);
  });

  test('non-zero exit with empty stderr still yields a block message', () => {
    const shell = fakeShell({ exitCode: 3, stderr: '', stdout: '' });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'x' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
    assert.match(res.message, /3/);
  });
});

// ─── timeout ──────────────────────────────────────────────────────────────────

describe('evaluatePredicate — command-exit-zero timeout', () => {
  test('timedOut => block:true with timed-out message', () => {
    const shell = fakeShell({ timedOut: true, exitCode: null, signal: 'SIGTERM' });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'sleep 100', timeout: PREDICATE_TIMEOUT_FIXTURE_SECONDS },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
    assert.match(res.message, /timed out|timeout/i);
  });

  test('default timeout applied when predicate.timeout absent', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'true' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].timeoutMs, COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS);
  });

  test('custom timeout (seconds) honored and converted to ms', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'true', timeout: PREDICATE_TIMEOUT_CUSTOM_SECONDS },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].timeoutMs, 90_000);
  });
});

// ─── phase context transport ──────────────────────────────────────────────────

describe('evaluatePredicate — phase context environment', () => {
  test('phase values are environment data and command text is unchanged', () => {
    const shell = fakeShell({ exitCode: 0 });
    const command = 'check "$GSD_GATE_PHASE_DIR" "$GSD_GATE_PHASE_NUMBER" "$GSD_GATE_PHASE_REQ_IDS" ${HOME} $PHASE_DIR';
    evaluatePredicate(
      { kind: 'command-exit-zero', command },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].command, command);
    assert.deepEqual(shell.calls[0].env, {
      GSD_GATE_PHASE_NUMBER: baseCtx.phaseNumber,
      GSD_GATE_PHASE_DIR: baseCtx.phaseDir,
      GSD_GATE_PHASE_REQ_IDS: baseCtx.phaseReqIds,
    });
  });

  test('missing phase values are explicit empty environment values', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'check "$GSD_GATE_PHASE_REQ_IDS"' },
      { cwd: '/proj' },
      { runBoundedShell: shell.run },
    );
    assert.deepEqual(shell.calls[0].env, {
      GSD_GATE_PHASE_NUMBER: '', GSD_GATE_PHASE_DIR: '', GSD_GATE_PHASE_REQ_IDS: '',
    });
  });

  test('each retired context spelling is rejected before execution, including quoted forms', () => {
    for (const name of phaseContextVariableNames()) {
      for (const quote of ['', "'", '"']) {
        const shell = fakeShell({ exitCode: 0 });
        assert.throws(
          () => evaluatePredicate(
            { kind: 'command-exit-zero', command: 'check ' + quote + '${' + name + '}' + quote },
            baseCtx,
            { runBoundedShell: shell.run },
          ),
          (err) => {
            assert.ok(err.message.includes('${' + name + '}'));
            assert.ok(err.message.includes('$GSD_GATE_' + name));
            return true;
          },
        );
        assert.deepEqual(shell.calls, []);
      }
    }
  });
});

// ─── output trimming ──────────────────────────────────────────────────────────

describe('evaluatePredicate — message trimming', () => {
  test('stderr longer than COMMAND_MAX_OUTPUT_CHARS is trimmed', () => {
    const long = 'E'.repeat(COMMAND_MAX_OUTPUT_CHARS + 50);
    const shell = fakeShell({ exitCode: 1, stderr: long });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'x' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.block, true);
    assert.equal(res.message.length, COMMAND_MAX_OUTPUT_CHARS);
  });

  test('stderr exactly at COMMAND_MAX_OUTPUT_CHARS is not trimmed (boundary)', () => {
    const exact = 'E'.repeat(COMMAND_MAX_OUTPUT_CHARS);
    const shell = fakeShell({ exitCode: 1, stderr: exact });
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'x' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(res.message.length, COMMAND_MAX_OUTPUT_CHARS);
  });
});

// ─── malformed predicate / fail-closed ────────────────────────────────────────

describe('evaluatePredicate — malformed predicate throws (maps to check-cmd failure)', () => {
  test('missing command throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero' }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /command/i,
    );
  });

  test('non-string command throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: 42 }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /command/i,
    );
  });

  test('empty-string command throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: '   ' }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /command/i,
    );
  });

  test('command-length boundary accepts max-1 and max without rewriting', () => {
    for (const length of [COMMAND_MAX_LENGTH - 1, COMMAND_MAX_LENGTH]) {
      const shell = fakeShell({ exitCode: 0 });
      const command = 'x'.repeat(length);
      evaluatePredicate({ kind: 'command-exit-zero', command }, baseCtx, { runBoundedShell: shell.run });
      assert.equal(shell.calls[0].command, command);
    }
  });

  test('oversized command throws (ARGV-overflow guard)', () => {
    const huge = 'a'.repeat(COMMAND_MAX_LENGTH + 1);
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: huge }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /max length/i,
    );
  });

  test('non-positive timeout throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: 'x', timeout: INVALID_PREDICATE_TIMEOUT_ZERO }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /timeout/i,
    );
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: 'x', timeout: INVALID_PREDICATE_TIMEOUT_NEGATIVE }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /timeout/i,
    );
  });

  test('non-finite timeout throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'command-exit-zero', command: 'x', timeout: 'forever' }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /timeout/i,
    );
  });

  test('unknown kind throws', () => {
    assert.throws(
      () => evaluatePredicate({ kind: 'no-such-kind', command: 'x' }, baseCtx, { runBoundedShell: fakeShell({}).run }),
      /kind|unknown|no-such-kind/i,
    );
  });

  test('predicate not an object throws', () => {
    assert.throws(
      () => evaluatePredicate('nope', baseCtx, { runBoundedShell: fakeShell({}).run }),
      /predicate/i,
    );
  });
});

// ─── contract surface ─────────────────────────────────────────────────────────

describe('evaluatePredicate — exported contract surface', () => {
  test('EVALUATOR_KINDS advertises every built-in predicate kind', () => {
    assert.ok(Array.isArray(EVALUATOR_KINDS));
    assert.ok(EVALUATOR_KINDS.includes('command-exit-zero'));
    assert.ok(EVALUATOR_KINDS.includes('artifact-frontmatter-equals'));
  });

  test('default timeout is 30s', () => {
    assert.equal(COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS, 30_000);
  });

  test('cwd is passed through to the shell seam', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'true' },
      { cwd: '/custom/proj' },
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].cwd, '/custom/proj');
  });
});

// ─── properties: command identity and context round-trip ───────────────────────

describe('evaluatePredicate — phase transport properties (fast-check)', () => {
  test('accepted commands are byte-for-byte identical regardless of context', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0 && !/\$\{(PHASE_NUMBER|PHASE_DIR|PHASE_REQ_IDS)\}/.test(s)),
      fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
      fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
      fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
      (command, phaseNumber, phaseDir, phaseReqIds) => {
        const shell = fakeShell({ exitCode: 0 });
        evaluatePredicate(
          { kind: 'command-exit-zero', command },
          { cwd: '/proj', phaseNumber, phaseDir, phaseReqIds },
          { runBoundedShell: shell.run },
        );
        assert.equal(shell.calls[0].command, command);
        assert.deepEqual(shell.calls[0].env, {
          GSD_GATE_PHASE_NUMBER: phaseNumber ?? '',
          GSD_GATE_PHASE_DIR: phaseDir ?? '',
          GSD_GATE_PHASE_REQ_IDS: phaseReqIds ?? '',
        });
      },
    ), { numRuns: 100 });
  });
});
