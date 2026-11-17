'use strict';

/**
 * Unit tests for the gate-predicate evaluator (pure core) — issue #2008.
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
 * Per RULESET.TESTS.property-based: interpolation bijection property (fast-check).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

const {
  evaluatePredicate,
  COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS,
  COMMAND_MAX_OUTPUT_CHARS,
  COMMAND_MAX_LENGTH,
  EVALUATOR_KINDS,
  INTERPOLATION_VAR_NAMES,
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
      exitCode: preset.exitCode ?? 0,
      stdout: preset.stdout ?? '',
      stderr: preset.stderr ?? '',
      signal: preset.signal ?? null,
      timedOut: preset.timedOut ?? false,
    };
  };
  return { run, calls };
}

const baseCtx = { cwd: '/proj', phaseNumber: '03', phaseDir: '/proj/.planning/phases/03-x', phaseReqIds: 'R-1' };

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

// ─── interpolation ────────────────────────────────────────────────────────────

describe('evaluatePredicate — interpolation', () => {
  test('${GSD_PHASE_DIR}, ${GSD_PHASE_NUMBER}, ${GSD_PHASE_REQ_IDS} reach the shell as environment values and the text is not rewritten', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'check ${GSD_PHASE_DIR} ${GSD_PHASE_NUMBER} ${GSD_PHASE_REQ_IDS}' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].command, 'check ${GSD_PHASE_DIR} ${GSD_PHASE_NUMBER} ${GSD_PHASE_REQ_IDS}');
    assert.deepEqual(shell.calls[0].env, {
      GSD_PHASE_DIR: '/proj/.planning/phases/03-x',
      GSD_PHASE_NUMBER: '03',
      GSD_PHASE_REQ_IDS: 'R-1',
    });
  });

  test('a value with a shell-significant character is never pasted: the shell expands it from the environment', () => {
    const shell = fakeShell({ exitCode: 0 });
    const phaseDir = '/proj/.planning/phases/01-$(touch pwned) x';
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'check "${GSD_PHASE_DIR}" ${GSD_PHASE_NUMBER}' },
      { ...baseCtx, phaseDir },
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].command, 'check "${GSD_PHASE_DIR}" ${GSD_PHASE_NUMBER}');
    assert.equal(shell.calls[0].env.GSD_PHASE_DIR, phaseDir);
  });

  test('the pre-#5482 spelling is refused in every quoting form, and the message names the GSD_ replacement', () => {
    const ctx = { cwd: '/proj', phaseNumber: '01', phaseDir: '/a', phaseReqIds: 'R-1' };
    const run = (command) => evaluatePredicate({ kind: 'command-exit-zero', command }, ctx, { runBoundedShell: fakeShell({ exitCode: 0 }).run });
    for (const name of ['PHASE_NUMBER', 'PHASE_DIR', 'PHASE_REQ_IDS']) {
      const named = { message: new RegExp(`uses \\$\\{${escapeRegex(name)}\\}.*write "\\$\\{GSD_${escapeRegex(name)}\\}"`) };
      for (const form of [`'\${${name}}'`, `"\${${name}}"`, `\${${name}}`]) {
        assert.throws(() => run(`test -n ${form}`), named, form);
      }
    }
    assert.doesNotThrow(() => run('test -n "${PHASE_DIR_OTHER}"'));
    assert.doesNotThrow(() => run('PHASE_DIR=build; test -d "$PHASE_DIR"'));
  });

  test('every placeholder single-quoted throws, whatever its value; double-quoted does not', () => {
    for (const name of INTERPOLATION_VAR_NAMES) {
      const ctx = { cwd: '/proj', phaseNumber: '01', phaseDir: '/a', phaseReqIds: 'R-1' };
      const run = (command) => evaluatePredicate({ kind: 'command-exit-zero', command }, ctx, { runBoundedShell: fakeShell({ exitCode: 0 }).run });
      const single = { message: new RegExp(`single-quotes \\$\\{${escapeRegex(name)}\\}.*write "\\$\\{${escapeRegex(name)}\\}" in double quotes`) };
      assert.throws(() => run(`test -n '\${${name}}'`), single);
      assert.throws(() => run(`test -n '$${name}'`), single);
      assert.doesNotThrow(() => run(`test -n '\${${name}_X}'`));
      assert.doesNotThrow(() => run(`test -n '$${name}X'`));
      assert.doesNotThrow(() => run(`test -n "\${${name}}"`));
    }
  });

  describe('quote states: an apostrophe outside a single-quoted span pairs with nothing', () => {
    const ctx = { cwd: '/proj', phaseNumber: '01', phaseDir: '/a b', phaseReqIds: '' };
    const run = (command) => evaluatePredicate({ kind: 'command-exit-zero', command }, ctx, { runBoundedShell: fakeShell({ exitCode: 0 }).run });
    const quoted = { message: /single-quotes/ };

    test('a single-quoted placeholder after an apostrophe in double quotes still throws', () => {
      assert.throws(() => run(`echo "it's"; test ! -f '\${GSD_PHASE_DIR}/x'`), quoted);
    });
    test('a double-quoted placeholder between an apostrophe and a later single-quoted word does not throw', () => {
      assert.doesNotThrow(() => run(`echo "it's"; test -f "\${GSD_PHASE_DIR}/x"; echo 'y'`));
    });
    test('a backslash-escaped apostrophe opens no single-quote span', () => {
      assert.doesNotThrow(() => run(`echo \\' "\${GSD_PHASE_DIR}" \\'`));
    });
  });

  test('a double-quoted gate run by the real shell sees the phase values, even with shell syntax in them', () => {
    const { buildPredicateDeps } = require('../gsd-core/bin/lib/gate-predicate.cjs');
    const phaseDir = '/tmp/x $(touch PWNED) `id` y';
    const ctx = { cwd: process.cwd(), phaseNumber: '07', phaseDir, phaseReqIds: 'R-1' };
    const run = (command) => evaluatePredicate({ kind: 'command-exit-zero', command }, ctx, buildPredicateDeps());
    assert.equal(run(`test "\${GSD_PHASE_NUMBER}" = 07 && test "\${GSD_PHASE_DIR}" = '${phaseDir}'`).block, false);
    assert.equal(run('test "${GSD_PHASE_NUMBER}" = 08').block, true);
  });

  test('undefined context var => empty string, in the text and in the environment', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'check ${GSD_PHASE_REQ_IDS}' },
      { cwd: '/proj' },
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].command, 'check ${GSD_PHASE_REQ_IDS}');
    assert.deepEqual(shell.calls[0].env, { GSD_PHASE_DIR: '', GSD_PHASE_NUMBER: '', GSD_PHASE_REQ_IDS: '' });
  });

  test('foreign ${HOME} placeholder left untouched (shell interprets)', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'echo ${HOME}' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].command, 'echo ${HOME}');
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

// ─── property-based: interpolation bijection on non-placeholder strings ───────

describe('evaluatePredicate — interpolation property (fast-check)', () => {
  test('strings without the 3 placeholders pass through unchanged', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }).filter((s) => s.trim().length > 0 && !/\$\{(GSD_PHASE_NUMBER|GSD_PHASE_DIR|GSD_PHASE_REQ_IDS)\}/.test(s)),
        (cmd) => {
        const shell = fakeShell({ exitCode: 0 });
        evaluatePredicate(
          { kind: 'command-exit-zero', command: cmd },
          baseCtx,
          { runBoundedShell: shell.run },
        );
        // sh -c receives exactly the input; only the 3 known placeholders would have been rewritten.
        assert.equal(shell.calls[0].command, cmd);
      }),
      { numRuns: 100 },
    );
  });

  // The ctx field behind each placeholder: one loop covers every name, so a new placeholder cannot skip the property.
  const CTX_FIELD = { GSD_PHASE_NUMBER: 'phaseNumber', GSD_PHASE_DIR: 'phaseDir', GSD_PHASE_REQ_IDS: 'phaseReqIds' };

  for (const name of INTERPOLATION_VAR_NAMES) {
    test(`${name}: any value reaches the environment and never the command text`, () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 40 }), (value) => {
          const shell = fakeShell({ exitCode: 0 });
          evaluatePredicate(
            { kind: 'command-exit-zero', command: `x "\${${name}}"` },
            { ...baseCtx, [CTX_FIELD[name]]: value },
            { runBoundedShell: shell.run },
          );
          assert.equal(shell.calls[0].env[name], value);
          assert.equal(shell.calls[0].command, `x "\${${name}}"`);
        }),
        { numRuns: 100 },
      );
    });
  }
});
