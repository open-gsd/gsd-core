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

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
const os = require('node:os');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { runHook } = require('./helpers/process-seam.cjs');

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
      { kind: 'command-exit-zero', command: 'check "${GSD_PHASE_DIR}" "${GSD_PHASE_NUMBER}" "${GSD_PHASE_REQ_IDS}"' },
      baseCtx,
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].command, 'check "${GSD_PHASE_DIR}" "${GSD_PHASE_NUMBER}" "${GSD_PHASE_REQ_IDS}"');
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
      { kind: 'command-exit-zero', command: 'check "${GSD_PHASE_DIR}" "${GSD_PHASE_NUMBER}"' },
      { ...baseCtx, phaseDir },
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].command, 'check "${GSD_PHASE_DIR}" "${GSD_PHASE_NUMBER}"');
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

  describe('every placeholder must be provably in plain double quotes (a conservative refusal)', () => {
    const ctx = { cwd: '/proj', phaseNumber: '01', phaseDir: '/a b', phaseReqIds: 'R-1' };
    const run = (command) => evaluatePredicate({ kind: 'command-exit-zero', command }, ctx, { runBoundedShell: fakeShell({ exitCode: 0 }).run });
    // `@` is the braced placeholder `${NAME}`, `%` the bare `$NAME`; each row runs once per placeholder name.
    const spell = (template, name) => template.replaceAll('@', `\${${name}}`).replaceAll('%', `$${name}`);
    const REFUSED = [
      'echo @',
      'echo %',
      "echo '@'",
      "echo '%'",
      "echo $'@'",
      'echo \\@',
      'echo "\\@"',
      'echo "$$@"',
      'echo "$%"',
      'echo "$(ls -A "@")"',
      'echo "`ls "@"`"',
      'echo "`echo \'@\'`"',
      'cat <<EOF\n@\nEOF',
      "cat <<'EOF'\n@\nEOF",
      'cat <<<"@"',
      '# it\'s\ntest -d "@"',
      'echo ok # it\'s\ntest -d "@"',
      'echo ok;# it\'s\ntest -d "@"',
      'echo "${x:-\'@\'}"',
      'echo "${x:-"@"}"',
      "echo \"${GSD_PHASE_DIR#'@'}\"",
      'for id in %; do :; done',
      'test -d "@" && for id in @; do :; done',
      "sh -c 'test -d \"%\"'",
      // A double-quoted placeholder in the text a consumer parses again: the value would run as code.
      'sh -c "test -e @"',
      'sh -ec "test -e @"',
      'bash -o pipefail -c "test -e @"',
      '/bin/sh -c -e "test -e @"',
      'sh -c -o pipefail "test -e @"',
      'sh -c +e "test -e @"',
      'eval "test -e @"',
      'eval echo "@"',
      'trap "rm @" EXIT',
      'printf x | xargs sh -c "test -e @"',
      'find . -exec sh -c "test -e @" \\;',
      'echo "@" | xargs ls',
      'echo "@" | xargs -n 10 ls',
      'echo "@" | xargs --replace ls -0',
      'test -d "@" && echo "@" | xargs ls',
      `sh -${'e'.repeat(15)}c "test -e @"`,
      `sh -${'e'.repeat(16)}c "test -e @"`,
      `sh -${'e'.repeat(17)}c "test -e @"`,
      `sh -${'e'.repeat(40)}c "test -e @"`,
      '"eval" "test -e @"',
      '\\sh -c "test -e @"',
      "'bash' -c \"test -e @\"",
      'echo "$\\\n(echo \'@\')"',
      "cat <\\\n<'EOF'\n\"@\"\nEOF",
    ];
    // Each row makes `sh` print its placeholder in plain double quotes, so the real shell proves the check keeps them.
    const ALLOWED = [
      'echo "@"',
      'echo "%"',
      'echo "@/x" "@"',
      'echo "it\'s" "@"',
      'echo "a # b" "@"',
      'echo \\" "@"',
      'echo "${x:-@}"',
      'echo "@"; echo \'single\' "it\'s"',
      'd="@"; echo "$d"',
      'd="@"; echo "$(echo "$d")"',
      'ids="@"; for id in $ids; do echo "$id"; done',
      "sh -c 'echo \"$1\"' sh \"@\"",
      'd="@"; eval \'echo "$d"\'',
      'echo "@" | tr "\\n" "\\0" | xargs -0 echo',
      'echo "@" | xargs -0r echo',
      'echo "@" | xargs -r0 echo',
      'echo "@" | xargs -n 1 -0 echo',
      'grep -c x /dev/null; echo "@"',
      "trap 'rm -f tmp' EXIT; echo \"@\"",
      'sh -c true; echo "@"',
      'echo \\\n"@"',
      'echo "$\\\nd" "@"',
    ];
    const unprovable = (name) => new RegExp(`uses \\$\\{${escapeRegex(name)}\\} where this check cannot prove sh expands it as one plain value: write "\\$\\{${escapeRegex(name)}\\}" in plain double quotes`);

    test('a placeholder outside plain double quotes, or after a construct the check does not read, throws and names it', () => {
      for (const name of INTERPOLATION_VAR_NAMES) {
        for (const template of REFUSED) {
          assert.throws(() => run(spell(template, name)), unprovable(name), JSON.stringify(template));
        }
      }
    });
    test('a quote inside ${...} that holds a % operator is refused, and the same operator without the quote is not', () => {
      for (const name of INTERPOLATION_VAR_NAMES) {
        const command = String.raw`echo "${'$'}{${name}%'${'$'}{${name}}'}"`;
        assert.ok(command.includes(`${name}%'`), command);
        assert.throws(() => run(command), unprovable(name), command);
        const unquoted = String.raw`echo "${'$'}{${name}%x}" "${'$'}{${name}}"`;
        assert.doesNotThrow(() => run(unquoted), unquoted);
      }
    });
    test('a similar name, a construct without a placeholder and a non-GSD variable throw nothing', () => {
      for (const command of [
        "echo '${GSD_PHASE_DIR_X}' '$GSD_PHASE_DIRX' '${HOME}'",
        'echo "$(date)" `date` $HOME ${HOME}',
        "cat <<'EOF'\nx\nEOF",
        '# a comment\necho ok',
        "echo \"${GSD_PHASE_DIR_X}\" $'x'",
      ]) {
        assert.doesNotThrow(() => run(command), JSON.stringify(command));
      }
    });
    test('each rewrite that ADR-2008 and gate-predicates.md give for a refused command passes, and the original throws', () => {
      const PAIRS = [
        ['test -z "$(ls -A "${GSD_PHASE_DIR}")"', 'd="${GSD_PHASE_DIR}"; test -z "$(ls -A "$d")"'],
        ['for id in $GSD_PHASE_REQ_IDS; do :; done', 'ids="${GSD_PHASE_REQ_IDS}"; for id in $ids; do :; done'],
        ['sh -c \'test -d "$GSD_PHASE_DIR"\'', 'sh -c \'test -d "$1"\' sh "${GSD_PHASE_DIR}"'],
        ['sh -c "test -d ${GSD_PHASE_DIR}"', 'sh -c \'test -d "$1"\' sh "${GSD_PHASE_DIR}"'],
        ['eval "test -d \\"${GSD_PHASE_DIR}\\""', 'd="${GSD_PHASE_DIR}"; eval \'test -d "$d"\''],
        ['trap "rm ${GSD_PHASE_DIR}" EXIT', 'd="${GSD_PHASE_DIR}"; trap \'rm "$d"\' EXIT'],
        ['echo "${GSD_PHASE_DIR}" | xargs ls', 'printf "%s\\0" "${GSD_PHASE_DIR}" | xargs -0 ls'],
        ['# note\ntest -d "${GSD_PHASE_DIR}"', 'test -d "${GSD_PHASE_DIR}" # note'],
      ];
      for (const [refused, rewrite] of PAIRS) {
        assert.throws(() => run(refused), /cannot prove sh expands it/, refused);
        assert.doesNotThrow(() => run(rewrite), rewrite);
      }
    });
    test('the refusal of a gate that runs xargs names the xargs -0 spelling and a path-spelled xargs is refused too', () => {
      for (const refused of ['echo "${GSD_PHASE_DIR}" | xargs ls', 'echo "${GSD_PHASE_DIR}" | /usr/bin/xargs ls']) {
        assert.throws(() => run(refused), /xargs -0/, refused);
      }
      assert.doesNotThrow(() => run('echo "${GSD_PHASE_DIR}" | /usr/bin/xargs --delimiter=x ls'));
    });
    test('the beads ship gate (gsd-beads-i7e7) in its migrated spelling passes the check', () => {
      const beads = '_B="${GSD_HOME:-${HOME:-}}"; case "$_B" in /?*) ;; *) echo "gsd-beads: no absolute GSD_HOME or HOME" >&2; exit 1;; esac; exec python3 -I "$_B/.gsd/capabilities/beads/scripts/sync.py" ship-gate "${GSD_PHASE_NUMBER}"';
      assert.doesNotThrow(() => run(beads));
    });
    test('every ALLOWED row passes the check', () => {
      for (const name of INTERPOLATION_VAR_NAMES) {
        for (const template of ALLOWED) {
          assert.doesNotThrow(() => run(spell(template, name)), JSON.stringify(template));
        }
      }
    });
    test('the real shell expands every allowed row and prints no literal placeholder', () => {
      const env = isolatedEnv({ home: os.tmpdir(), override: { GSD_PHASE_NUMBER: 'SENT-NUM', GSD_PHASE_DIR: 'SENT-DIR', GSD_PHASE_REQ_IDS: 'SENT-REQ' } });
      for (const name of INTERPOLATION_VAR_NAMES) {
        for (const template of ALLOWED) {
          const { stdout } = runHook('-c', [spell(template, name)], { interpreter: 'sh', env, input: '', timeoutMs: PROBE_TIMEOUT_MS });
          assert.match(stdout, /SENT-(NUM|DIR|REQ)/, JSON.stringify(template));
          assert.doesNotMatch(stdout, /GSD_PHASE_/, JSON.stringify(template));
        }
      }
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

  // One row per consumer that parses its argument as shell again. `@` is the placeholder. The refused spelling pastes
  // the value into that text; the supported one hands it over as a later argument or a variable.
  describe('a consumer that re-parses its argument never runs the phase directory name', () => {
    const PAYLOAD_DIR = 'x$(touch PWNED)';
    const CONSUMERS = [
      ['eval', 'eval "test -e \\"@/BLOCKER\\""', 'd="@"; eval \'test -n "$d"\''],
      ['sh -c', 'sh -c "test -e @/BLOCKER"', 'sh -c \'test -n "$1"\' sh "@"'],
      ['bash -c', 'bash -c "test -e @/BLOCKER"', 'bash -c \'test -n "$1"\' bash "@"'],
      ['trap', 'trap "test -e @/BLOCKER" EXIT', 'd="@"; trap \'test -n "$d"\' EXIT'],
      ['xargs sh -c', 'echo x | xargs sh -c "test -e @/BLOCKER"', 'printf "x\\0" | xargs -0 sh -c \'test -n "$1"\' sh "@"'],
      ['find -exec sh -c', 'find . -prune -exec sh -c "test -e @/BLOCKER" \\;', 'find . -prune -exec sh -c \'test -n "$1"\' sh "@" \\;'],
    ];
    const { buildPredicateDeps } = require('../gsd-core/bin/lib/gate-predicate.cjs');
    const spell = (template) => template.replaceAll('@', '${GSD_PHASE_DIR}');
    const marker = (dir) => fs.existsSync(path.join(dir, 'PWNED'));
    let control;
    let guarded;
    beforeEach(() => { control = createTempDir(); guarded = createTempDir(); });
    afterEach(() => { cleanup(control); cleanup(guarded); });

    for (const [consumer, refused, supported] of CONSUMERS) {
      test(`${consumer}: the real shell runs the payload from the refused spelling, the evaluator refuses it and creates nothing`, () => {
        const env = isolatedEnv({ home: control, override: { GSD_PHASE_DIR: PAYLOAD_DIR } });
        runHook('-c', [spell(refused)], { interpreter: 'sh', env, cwd: control, input: '', timeoutMs: PROBE_TIMEOUT_MS });
        assert.equal(marker(control), true, 'positive control: this spelling executes the directory name');

        const run = (command) => evaluatePredicate({ kind: 'command-exit-zero', command }, { cwd: guarded, phaseNumber: '01', phaseDir: PAYLOAD_DIR, phaseReqIds: 'R-1' }, buildPredicateDeps());
        assert.throws(() => run(spell(refused)), /cannot prove sh expands it as one plain value/);
        assert.equal(marker(guarded), false);
        assert.equal(run(spell(supported)).block, false, 'the supported spelling runs and passes');
        assert.equal(marker(guarded), false);
      });
    }
  });

  test('undefined context var => empty string, in the text and in the environment', () => {
    const shell = fakeShell({ exitCode: 0 });
    evaluatePredicate(
      { kind: 'command-exit-zero', command: 'check "${GSD_PHASE_REQ_IDS}"' },
      { cwd: '/proj' },
      { runBoundedShell: shell.run },
    );
    assert.equal(shell.calls[0].command, 'check "${GSD_PHASE_REQ_IDS}"');
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
      );
    });
  }
});
