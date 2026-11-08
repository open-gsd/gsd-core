'use strict';

/**
 * #4310: opt-in `verify plan-structure --replay` (ADR-4310).
 *
 * Failing-first suite for the Criterion Replay Module
 * (`src/criterion-replay.cts` -> `gsd-core/bin/lib/criterion-replay.cjs`), the
 * `execArgvQuarantined` seam primitive, and the `--replay` CLI path. Row ids
 * `[R<n>]` cite `.gsd/phase/feat-4310-criterion-replay/50-test-matrix.md`.
 * Assertions are on typed fields only (status code, outcome, value kind, argv,
 * counts, valid, exit code), never on message text.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');
const { runGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { GIT_TIMEOUT_MS, PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const replay = require(path.join(LIB, 'criterion-replay.cjs'));
const baseline = require(path.join(LIB, 'criterion-baseline.cjs'));
const projection = require(path.join(LIB, 'shell-command-projection.cjs'));

const {
  REPLAY_STATUS,
  REPLAY_LIMITS,
  extractCriterionCommand,
  tokenizeCriterionCommand,
  checkReplayQuarantine,
  deriveObservedValue,
  replayBaselineCriteria,
} = replay;

const PLAN_HEAD = [
  '---',
  'phase: 01-test',
  'plan: 01',
  'type: execute',
  'wave: 1',
  'depends_on: []',
  'files_modified: [some/file.ts]',
  'autonomous: true',
  'must_haves:',
  '  truths:',
  '    - "something is true"',
  '---',
  '',
];

function makePlan({ criteria = '  - Plain criterion.', automated = 'echo ok', eol = '\n' } = {}) {
  return PLAN_HEAD.concat([
    '<acceptance_criteria>',
    criteria,
    '</acceptance_criteria>',
    '',
    '<task type="auto">',
    '  <name>Task 1: Do something</name>',
    '  <files>some/file.ts</files>',
    '  <action>Do the thing</action>',
    `  <verify><automated>${automated}</automated></verify>`,
    '  <done>Thing is done</done>',
    '</task>',
    '',
  ]).join(eol);
}

/** An acceptance line carrying one backtick command and a notation. */
function critLine(command, notation) {
  return makePlan({ criteria: `  - \`${command}\` -ge 1 ${notation}` });
}

const exited = (exitCode, stdout = '') => ({ outcome: 'exited', exitCode, stdout });

/** Injected runner that records every argv and answers from a table. */
function recordingRunner(answer = () => exited(0, '1')) {
  const calls = [];
  const run = (argv, opts) => {
    calls.push({ argv: argv.slice(), timeoutMs: opts && opts.timeoutMs });
    return answer(argv, calls.length);
  };
  return { run, calls };
}

function fixedClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function codes(r) {
  return r.statuses.map((s) => s.code);
}

describe('#4310 module surface', () => {
  test('[R0] the status vocabulary is the closed set ADR-4310 names', () => {
    assert.deepStrictEqual(Object.values(REPLAY_STATUS).sort(), [
      'ambiguous_command', 'budget_exhausted', 'cannot_run', 'disallowed', 'malformed_command',
      'no_command', 'output_cap', 'replay_error', 'timeout', 'truncated',
    ]);
    assert.ok(Object.isFrozen(REPLAY_STATUS));
    assert.deepStrictEqual({ ...REPLAY_LIMITS }, {
      MAX_COMMANDS: 50,
      PER_COMMAND_TIMEOUT_MS: 10000,
      TOTAL_BUDGET_MS: 60000,
      OUTPUT_CAP_BYTES: 65536,
      MAX_COMMAND_LENGTH: 1000,
      MAX_TOKENS: 64,
    });
  });
});

describe('#4310 command extraction', () => {
  test('[R3] one backtick span on an acceptance line is the command', () => {
    const line = '  - `git rev-list --count HEAD` -ge 1 [HEAD=1 EXPECT>=2]';
    const r = extractCriterionCommand(line, line.indexOf('[HEAD='));
    assert.deepStrictEqual(r, { command: 'git rev-list --count HEAD' });
  });

  test('[R4] a trailing shell comment on an automated line; zone tags are stripped', () => {
    const line = '  <verify><automated>git rev-list --count HEAD   # [HEAD=1 EXPECT>=2]';
    const r = extractCriterionCommand(line, line.indexOf('[HEAD='));
    assert.deepStrictEqual(r, { command: 'git rev-list --count HEAD' });
    const bare = 'grep -c x f # [HEAD=1 EXPECT>=2]';
    assert.deepStrictEqual(extractCriterionCommand(bare, bare.indexOf('[HEAD=')), { command: 'grep -c x f' });
  });

  test('[R5] only the trailing comment is removed, not a quoted # inside the command', () => {
    const line = "grep -c '#' f # [HEAD=1 EXPECT>=2]";
    assert.deepStrictEqual(extractCriterionCommand(line, line.indexOf('[HEAD=')), { command: "grep -c '#' f" });
  });

  test('[R6] two backtick spans are ambiguous', () => {
    const line = '  - `grep -c a f` or `grep -c b f` [HEAD=1 EXPECT>=2]';
    assert.strictEqual(extractCriterionCommand(line, line.indexOf('[HEAD=')).status, REPLAY_STATUS.AMBIGUOUS_COMMAND);
  });

  test('[R7] no span and no trailing # means no command', () => {
    const line = '  - the count rises [HEAD=1 EXPECT>=2]';
    assert.strictEqual(extractCriterionCommand(line, line.indexOf('[HEAD=')).status, REPLAY_STATUS.NO_COMMAND);
  });

  test('[R8] an empty span or a whitespace-only comment prefix is no command', () => {
    const a = '  - `` [HEAD=1 EXPECT>=2]';
    assert.strictEqual(extractCriterionCommand(a, a.indexOf('[HEAD=')).status, REPLAY_STATUS.NO_COMMAND);
    const b = '<automated>   # [HEAD=1 EXPECT>=2]';
    assert.strictEqual(extractCriterionCommand(b, b.indexOf('[HEAD=')).status, REPLAY_STATUS.NO_COMMAND);
  });

  test('[R36] HTML entities in the command are decoded', () => {
    const amp = '  - `grep -c a&amp;b f` [HEAD=1 EXPECT>=2]';
    assert.deepStrictEqual(extractCriterionCommand(amp, amp.indexOf('[HEAD=')), { command: 'grep -c a&b f' });
    const gt = '  - `grep -c a&gt;b f` [HEAD=1 EXPECT>=2]';
    assert.deepStrictEqual(extractCriterionCommand(gt, gt.indexOf('[HEAD=')), { command: 'grep -c a>b f' });
  });
});

describe('#4310 tokenizer (a recognizer, not a shell)', () => {
  test('[R12] metacharacters inside single quotes are literal', () => {
    assert.deepStrictEqual(tokenizeCriterionCommand("grep -c 'a|b;c$(d)' f"), { argv: ['grep', '-c', 'a|b;c$(d)', 'f'] });
  });

  test('[R13] double-quote escapes decode', () => {
    assert.deepStrictEqual(tokenizeCriterionCommand('grep -c "a\\"b\\\\c" f'), { argv: ['grep', '-c', 'a"b\\c', 'f'] });
    assert.deepStrictEqual(tokenizeCriterionCommand('grep -c "## Quickstart" README.md'), { argv: ['grep', '-c', '## Quickstart', 'README.md'] });
  });

  test('[R9] unterminated quotes and a trailing backslash are malformed', () => {
    for (const cmd of ["grep -c 'x f", 'grep -c "x f', 'grep -c x\\']) {
      assert.strictEqual(tokenizeCriterionCommand(cmd).status, REPLAY_STATUS.MALFORMED_COMMAND, cmd);
    }
  });

  test('[R10] every unquoted shell metacharacter is disallowed', () => {
    for (const ch of ['|', '&', ';', '<', '>', '(', ')', '$', '`', '*', '?', '[', '{', '}', '~']) {
      const r = tokenizeCriterionCommand(`grep -c a${ch}b f`);
      assert.strictEqual(r.status, REPLAY_STATUS.DISALLOWED, ch);
    }
    assert.strictEqual(tokenizeCriterionCommand('grep -c x f #comment').status, REPLAY_STATUS.DISALLOWED);
  });

  test('[R11] $ and backtick inside double quotes are disallowed', () => {
    assert.strictEqual(tokenizeCriterionCommand('grep -c "$(id)" f').status, REPLAY_STATUS.DISALLOWED);
    assert.strictEqual(tokenizeCriterionCommand('grep -c "`id`" f').status, REPLAY_STATUS.DISALLOWED);
    assert.strictEqual(tokenizeCriterionCommand('grep -c "$HOME" f').status, REPLAY_STATUS.DISALLOWED);
    assert.deepStrictEqual(tokenizeCriterionCommand('grep -c "\\$HOME" f'), { argv: ['grep', '-c', '$HOME', 'f'] });
  });

  test('[R14] the step/gate hostile set never reaches the runner', () => {
    // loop-hook-dispatch.md names: a quote, `;`, a backtick, `$(`, a newline.
    const hostile = ["grep -c x f' ; touch P", 'grep -c x f; touch P', 'grep -c `touch P` f', 'grep -c $(touch P) f', 'grep -c x f\ntouch P', 'grep -c x f\rtouch P', 'grep -c x\u0000 f'];
    for (const cmd of hostile) {
      assert.ok('status' in tokenizeCriterionCommand(cmd), JSON.stringify(cmd));
    }
    // The single-line variants, carried in a real plan, never reach the runner.
    const { run, calls } = recordingRunner();
    for (const cmd of ["grep -c x f' ; touch P", 'grep -c x f; touch P', 'grep -c $(touch P) f']) {
      replayBaselineCriteria(critLine(cmd, '[HEAD=1 EXPECT>=2]'), { run, now: () => 0, headSha: null });
    }
    replayBaselineCriteria(makePlan({ automated: 'grep -c `touch P` f # [HEAD=1 EXPECT>=2]' }), { run, now: () => 0, headSha: null });
    assert.strictEqual(calls.length, 0);
  });

  test('[R20] command length 1000 is allowed, 1001 is disallowed', () => {
    const at = `grep -c ${'a'.repeat(1000 - 'grep -c  f'.length)} f`;
    assert.strictEqual(at.length, 1000);
    assert.ok('argv' in tokenizeCriterionCommand(at));
    assert.ok('argv' in tokenizeCriterionCommand(at.slice(1)));
    assert.strictEqual(tokenizeCriterionCommand(`${at}a`).status, REPLAY_STATUS.DISALLOWED);
  });

  test('[R21] 64 tokens are allowed, 65 are disallowed', () => {
    const toks = (n) => ['grep'].concat(Array.from({ length: n - 1 }, () => 'a')).join(' ');
    assert.strictEqual(tokenizeCriterionCommand(toks(63)).argv.length, 63);
    assert.strictEqual(tokenizeCriterionCommand(toks(64)).argv.length, 64);
    assert.strictEqual(tokenizeCriterionCommand(toks(65)).status, REPLAY_STATUS.DISALLOWED);
  });

  test('[R47] property: an accepted command is exactly its words, with nothing a shell could add', () => {
    const safe = fc.stringMatching(/^[A-Za-z0-9_.,:=@%+\-/]{1,12}$/);
    const quoted = fc.string({ maxLength: 12 }).filter((s) => !s.includes("'") && !s.includes('\r') && !s.includes('\n') && !s.includes('\u0000'));
    fc.assert(
      fc.property(fc.array(fc.oneof(safe, quoted.map((s) => ({ q: s }))), { minLength: 1, maxLength: 10 }), (parts) => {
        const cmd = ['grep'].concat(parts.map((p) => (typeof p === 'string' ? p : `'${p.q}'`))).join(' ');
        const r = tokenizeCriterionCommand(cmd);
        assert.ok('argv' in r, cmd);
        assert.deepStrictEqual(r.argv, ['grep'].concat(parts.map((p) => (typeof p === 'string' ? p : p.q))));
        return true;
      }),
      { seed: 4310, numRuns: 300 },
    );
  });
});

describe('#4310 quarantine', () => {
  test('[R15] only the bare names grep and git may run', () => {
    for (const prog of ['./grep', '/usr/bin/grep', 'grep.exe', 'GREP', 'rg', 'wc', 'sh', 'node', 'bash']) {
      assert.strictEqual(checkReplayQuarantine([prog, '-c', 'x', 'f']).status, REPLAY_STATUS.DISALLOWED, prog);
    }
    assert.strictEqual(checkReplayQuarantine(['grep', '-c', 'x', 'f']), null);
  });

  test('[R16] git needs an allowed subcommand directly, with no global option', () => {
    for (const argv of [['git', '-C', 'x', 'grep', 'y'], ['git', '--git-dir=x', 'ls-files'], ['git', 'log'], ['git', 'diff'], ['git', 'config', 'x'], ['git']]) {
      assert.strictEqual(checkReplayQuarantine(argv).status, REPLAY_STATUS.DISALLOWED, argv.join(' '));
    }
    for (const sub of ['grep', 'ls-files', 'rev-parse', 'rev-list']) {
      assert.strictEqual(checkReplayQuarantine(['git', sub, 'HEAD']), null, sub);
    }
  });

  test('[R17] git flags that run a program or write a file are disallowed', () => {
    for (const flag of ['--output=f', '--output', '-O', '-Ovim', '--open-files-in-pager', '--open-files-in-pager=less', '--textconv', '--ext-diff', '-iO']) {
      assert.strictEqual(checkReplayQuarantine(['git', 'grep', flag, 'x']).status, REPLAY_STATUS.DISALLOWED, flag);
    }
    assert.strictEqual(checkReplayQuarantine(['git', 'grep', '-c', '-i', 'x']), null);
  });

  test('[R18] arguments that leave the project are disallowed', () => {
    for (const arg of ['/etc/passwd', 'C:\\x', 'c:/x', '\\\\srv\\s', '../x', 'a/../b', 'a\\..\\b', '--file=/etc/x', '-f/etc/x', '..']) {
      assert.strictEqual(checkReplayQuarantine(['grep', '-c', 'x', arg]).status, REPLAY_STATUS.DISALLOWED, arg);
    }
  });

  test('[R19] ordinary relative arguments pass', () => {
    for (const arg of ['src/a.ts', '-c', 'a..b', '.', './src', 'a:b', '--include=x.ts', 'x/..y']) {
      assert.strictEqual(checkReplayQuarantine(['grep', '-c', 'x', arg]), null, arg);
    }
  });

  test('[R50] git option abbreviations are not allowed (F1)', () => {
    for (const argv of [
      ['git', 'grep', '--open-files=sh', '-e', 'x'],
      ['git', 'grep', '--open-files-in-p=true', '-e', 'x'],
      ['git', 'grep', '--out=f', 'x'],
      ['git', 'grep', '--text', 'x'],
      ['git', 'grep', '--ext', 'x'],
      ['git', 'grep', '--cou', 'x'],
    ]) {
      assert.strictEqual(checkReplayQuarantine(argv).status, REPLAY_STATUS.DISALLOWED, argv.join(' '));
    }
    assert.strictEqual(checkReplayQuarantine(['git', 'grep', '--count', '-e', 'x']), null);
  });

  test('[R51] a short-option cluster cannot smuggle a file option (F2)', () => {
    for (const argv of [
      ['grep', '-ncf/etc/passwd', 'x'],
      ['grep', '-rf', 'pats', 'x'],
      ['grep', '-f', 'pats', 'x'],
      ['grep', '-m1', 'x', 'f'],
      ['grep', '-A2', 'x', 'f'],
      ['grep', '-e'],
    ]) {
      assert.strictEqual(checkReplayQuarantine(argv).status, REPLAY_STATUS.DISALLOWED, argv.join(' '));
    }
    assert.strictEqual(checkReplayQuarantine(['grep', '-nci', 'x', 'f']), null);
    assert.strictEqual(checkReplayQuarantine(['grep', '-e', '-x', 'f']), null);
  });

  test('[R52] long options match exactly and value-taking ones need =', () => {
    for (const argv of [
      ['grep', '--include', 'x'],
      ['grep', '--count=3', 'x', 'f'],
      ['grep', '--include=/etc/x', '-c', 'x', '.'],
    ]) {
      assert.strictEqual(checkReplayQuarantine(argv).status, REPLAY_STATUS.DISALLOWED, argv.join(' '));
    }
    for (const argv of [
      ['grep', '--include=src/a.ts', '-c', 'x', '.'],
      ['git', 'rev-parse', '--short=7', 'HEAD'],
      ['git', 'rev-list', '-n', '3', 'HEAD'],
      ['git', 'rev-list', '--max-count=3', 'HEAD'],
    ]) {
      assert.strictEqual(checkReplayQuarantine(argv), null, argv.join(' '));
    }
  });

  test('[R53] after -- every token is an operand', () => {
    assert.strictEqual(checkReplayQuarantine(['grep', '-c', '--', '-x', 'f']), null);
    assert.strictEqual(checkReplayQuarantine(['grep', '-c', '--', '/etc/x']).status, REPLAY_STATUS.DISALLOWED);
  });

  test('[R55] an operand that resolves outside the project is disallowed (F4)', () => {
    const isInsideRoot = (p) => p !== 'link';
    assert.strictEqual(checkReplayQuarantine(['grep', '-c', 'x', 'link'], { isInsideRoot }).status, REPLAY_STATUS.DISALLOWED);
    assert.strictEqual(checkReplayQuarantine(['grep', '-c', 'x', 'f'], { isInsideRoot }), null);
    assert.strictEqual(checkReplayQuarantine(['grep', '-R', 'x', '.']).status, REPLAY_STATUS.DISALLOWED);
    assert.strictEqual(checkReplayQuarantine(['grep', '--include=link', '-c', 'x', '.'], { isInsideRoot }).status, REPLAY_STATUS.DISALLOWED);
  });
});

describe('#4310 observed value', () => {
  test('[R24] exit 1 printing 0 is the integer 0 (grep -c, no match)', () => {
    assert.deepStrictEqual(deriveObservedValue(exited(1, '0\n')), { value: { kind: 'integer', value: 0 } });
  });

  test('[R25] exit 0 printing an integer is that integer', () => {
    assert.deepStrictEqual(deriveObservedValue(exited(0, ' 3\r\n')), { value: { kind: 'integer', value: 3 } });
    assert.deepStrictEqual(deriveObservedValue(exited(0, '-2')), { value: { kind: 'integer', value: -2 } });
  });

  test('[R26] exit 0 with empty or non-integer output is present', () => {
    for (const out of ['', 'true', 'a:1\nb:2', '1 2', '1234567890123456']) {
      assert.deepStrictEqual(deriveObservedValue(exited(0, out)), { value: { kind: 'present' } }, out);
    }
  });

  test('[R27] exit 1 with empty or non-integer output is absent', () => {
    for (const out of ['', 'nope']) {
      assert.deepStrictEqual(deriveObservedValue(exited(1, out)), { value: { kind: 'absent' } }, out);
    }
  });

  test('[R28] exit 2..255 is error:<code>; outside 0..255 cannot run', () => {
    assert.deepStrictEqual(deriveObservedValue(exited(2, '0')), { value: { kind: 'error', code: 2 } });
    assert.deepStrictEqual(deriveObservedValue(exited(255)), { value: { kind: 'error', code: 255 } });
    assert.strictEqual(deriveObservedValue(exited(256)).status, REPLAY_STATUS.CANNOT_RUN);
    assert.strictEqual(deriveObservedValue(exited(-1)).status, REPLAY_STATUS.CANNOT_RUN);
    assert.strictEqual(deriveObservedValue(exited(null)).status, REPLAY_STATUS.CANNOT_RUN);
  });

  test('[R29] non-exit outcomes map to statuses', () => {
    const expect = { not_found: 'cannot_run', refused: 'cannot_run', timed_out: 'timeout', overflow: 'output_cap', killed: 'cannot_run', error: 'cannot_run', bogus: 'cannot_run' };
    for (const [outcome, code] of Object.entries(expect)) {
      assert.strictEqual(deriveObservedValue({ outcome, exitCode: null, stdout: '' }).status, code, outcome);
    }
  });

  test('[R48] property: deriveObservedValue is total and never throws', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('exited', 'not_found', 'refused', 'timed_out', 'overflow', 'killed', 'error'),
        fc.oneof(fc.integer({ min: -5, max: 300 }), fc.constant(null)),
        fc.string({ maxLength: 20 }),
        (outcome, exitCode, stdout) => {
          const r = deriveObservedValue({ outcome, exitCode, stdout });
          return ('value' in r) !== ('status' in r);
        },
      ),
      { seed: 4310, numRuns: 300 },
    );
  });
});

describe('#4310 replayBaselineCriteria', () => {
  test('[R2] a plan with no notation replays nothing', () => {
    const { run, calls } = recordingRunner();
    const r = replayBaselineCriteria(makePlan(), { run, now: () => 0, headSha: null });
    assert.deepStrictEqual(r.results, []);
    assert.deepStrictEqual(r.statuses, []);
    assert.strictEqual(r.mismatch_count, 0);
    assert.strictEqual(calls.length, 0);
  });

  test('[R30] a printed value equal to HEAD matches', () => {
    const { run, calls } = recordingRunner(() => exited(0, '1'));
    const r = replayBaselineCriteria(critLine('git rev-list --count HEAD', '[HEAD=1 EXPECT>=2]'), { run, now: () => 0, headSha: null });
    assert.deepStrictEqual(calls.map((c) => c.argv), [['git', 'rev-list', '--count', 'HEAD']]);
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].outcome, 'match');
    assert.deepStrictEqual(r.results[0].observed, { kind: 'integer', value: 1 });
    assert.deepStrictEqual(r.results[0].recorded, { kind: 'integer', value: 1 });
    assert.strictEqual(r.mismatch_count, 0);
    assert.deepStrictEqual(r.warnings, []);
  });

  test('[R31] a printed value differing from HEAD is a mismatch with a warning', () => {
    const { run } = recordingRunner(() => exited(0, '3'));
    const r = replayBaselineCriteria(critLine('grep -c x f', '[HEAD=2 EXPECT>=5]'), { run, now: () => 0, headSha: null });
    assert.strictEqual(r.results[0].outcome, 'mismatch');
    assert.strictEqual(r.mismatch_count, 1);
    assert.strictEqual(r.warnings.length, 1);
    const kind = replayBaselineCriteria(critLine('grep -c x f', '[HEAD=0 EXPECT>=1]'), { run: () => exited(2), now: () => 0, headSha: null });
    assert.strictEqual(kind.results[0].outcome, 'mismatch');
    assert.deepStrictEqual(kind.results[0].observed, { kind: 'error', code: 2 });
  });

  test('[R4] an automated-zone notation is replayed', () => {
    const { run, calls } = recordingRunner(() => exited(1, '0'));
    const r = replayBaselineCriteria(makePlan({ automated: 'grep -c "## Quickstart" README.md   # [HEAD=0 EXPECT>=1]' }), { run, now: () => 0, headSha: null });
    assert.deepStrictEqual(calls.map((c) => c.argv), [['grep', '-c', '## Quickstart', 'README.md']]);
    assert.strictEqual(r.results[0].outcome, 'match');
  });

  test('[R10] a disallowed command is a status and never reaches the runner', () => {
    const { run, calls } = recordingRunner();
    const r = replayBaselineCriteria(critLine("grep -v '^#' f | grep -c x", '[HEAD=1 EXPECT>=2]'), { run, now: () => 0, headSha: null });
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(codes(r), [REPLAY_STATUS.DISALLOWED]);
    assert.deepStrictEqual(r.results, []);
  });

  test('[R22] at most 50 commands run; the rest collapse into one truncated status', () => {
    for (const n of [49, 50, 51]) {
      const criteria = Array.from({ length: n }, (_, i) => `  - \`grep -c x f${i}\` [HEAD=1 EXPECT>=2]`).join('\n');
      const { run, calls } = recordingRunner(() => exited(0, '1'));
      const r = replayBaselineCriteria(makePlan({ criteria }), { run, now: () => 0, headSha: null });
      assert.strictEqual(calls.length, Math.min(n, 50), String(n));
      assert.strictEqual(r.results.length, Math.min(n, 50));
      assert.deepStrictEqual(codes(r), n > 50 ? [REPLAY_STATUS.TRUNCATED] : [], String(n));
    }
  });

  test('[R23] the total budget bounds every timeout and stops the run when spent', () => {
    const clock = fixedClock();
    const criteria = Array.from({ length: 4 }, (_, i) => `  - \`grep -c x f${i}\` [HEAD=1 EXPECT>=2]`).join('\n');
    const { run, calls } = recordingRunner(() => { clock.advance(25000); return exited(0, '1'); });
    const r = replayBaselineCriteria(makePlan({ criteria }), { run, now: clock.now, headSha: null });
    assert.deepStrictEqual(calls.map((c) => c.timeoutMs), [10000, 10000, 10000]);
    assert.strictEqual(r.results.length, 3);
    assert.deepStrictEqual(codes(r), [REPLAY_STATUS.BUDGET_EXHAUSTED]);

    const tight = fixedClock();
    const two = Array.from({ length: 2 }, (_, i) => `  - \`grep -c x f${i}\` [HEAD=1 EXPECT>=2]`).join('\n');
    const rec = recordingRunner(() => { tight.advance(55000); return exited(0, '1'); });
    replayBaselineCriteria(makePlan({ criteria: two }), { run: rec.run, now: tight.now, headSha: null });
    assert.deepStrictEqual(rec.calls.map((c) => c.timeoutMs), [10000, 5000]);
  });

  test('[R32] a pinned sha that differs from the current HEAD marks rev drift', () => {
    const run = () => exited(0, '1');
    const line = critLine('grep -c x f', '[HEAD=1 EXPECT>=2 @abc1234]');
    assert.strictEqual(replayBaselineCriteria(line, { run, now: () => 0, headSha: 'abc1234ffff' }).results[0].rev_drift, false);
    assert.strictEqual(replayBaselineCriteria(line, { run, now: () => 0, headSha: 'def5678ffff' }).results[0].rev_drift, true);
    assert.strictEqual(replayBaselineCriteria(line, { run, now: () => 0, headSha: null }).results[0].rev_drift, false);
    const unpinned = critLine('grep -c x f', '[HEAD=1 EXPECT>=2]');
    assert.strictEqual(replayBaselineCriteria(unpinned, { run, now: () => 0, headSha: 'def5678' }).results[0].rev_drift, false);
  });

  test('[R33] a runner that throws is a cannot_run status, not a crash', () => {
    const r = replayBaselineCriteria(critLine('grep -c x f', '[HEAD=1 EXPECT>=2]'), { run: () => { throw new Error('boom'); }, now: () => 0, headSha: null });
    assert.deepStrictEqual(codes(r), [REPLAY_STATUS.CANNOT_RUN]);
  });

  test('[R34] an internal failure is one replay_error status', () => {
    const r = replayBaselineCriteria(critLine('grep -c x f', '[HEAD=1 EXPECT>=2]'), {
      run: () => exited(0, '1'),
      now: () => 0,
      headSha: null,
      scan: () => { throw new Error('scan exploded'); },
    });
    assert.deepStrictEqual(codes(r), [REPLAY_STATUS.REPLAY_ERROR]);
    assert.deepStrictEqual(r.results, []);
  });

  test('[R35] a GUARD notation is replayed like any other', () => {
    const { run, calls } = recordingRunner(() => exited(0, '4'));
    const r = replayBaselineCriteria(critLine('grep -c x f', '[HEAD=4 EXPECT>=4 GUARD MUTATION: removing a row drops it]'), { run, now: () => 0, headSha: null });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(r.results[0].outcome, 'match');
  });

  test('[R37] CRLF plans give clean argv and the right line', () => {
    const lf = critLine('grep -c x f', '[HEAD=1 EXPECT>=2]');
    const crlf = makePlan({ criteria: '  - `grep -c x f` -ge 1 [HEAD=1 EXPECT>=2]', eol: '\r\n' });
    const a = recordingRunner();
    const b = recordingRunner();
    const ra = replayBaselineCriteria(lf, { run: a.run, now: () => 0, headSha: null });
    const rb = replayBaselineCriteria(crlf, { run: b.run, now: () => 0, headSha: null });
    assert.deepStrictEqual(b.calls.map((c) => c.argv), a.calls.map((c) => c.argv));
    assert.strictEqual(rb.results[0].line, ra.results[0].line);
    const auto = makePlan({ automated: 'grep -c x f # [HEAD=1 EXPECT>=2]', eol: '\r\n' });
    const c = recordingRunner();
    replayBaselineCriteria(auto, { run: c.run, now: () => 0, headSha: null });
    assert.deepStrictEqual(c.calls.map((x) => x.argv), [['grep', '-c', 'x', 'f']]);
  });

  test('[R38] notations outside a criteria zone or malformed are not replayed', () => {
    const outside = PLAN_HEAD.concat(['`grep -c x f` [HEAD=1 EXPECT>=2]', '']).join('\n');
    const { run, calls } = recordingRunner();
    replayBaselineCriteria(outside, { run, now: () => 0, headSha: null });
    replayBaselineCriteria(critLine('grep -c x f', '[HEAD=1 EXPECT=2]'), { run, now: () => 0, headSha: null });
    assert.strictEqual(calls.length, 0);
  });

  test('[R39] results never carry raw stdout or stderr', () => {
    const r = replayBaselineCriteria(critLine('grep x f', '[HEAD=absent EXPECT==present]'), { run: () => ({ outcome: 'exited', exitCode: 0, stdout: 'SECRET_TOKEN=abc', stderr: 'x' }), now: () => 0, headSha: null });
    assert.deepStrictEqual(Object.keys(r.results[0]).sort(), ['argv', 'line', 'observed', 'outcome', 'recorded', 'rev_drift', 'text']);
    assert.strictEqual(JSON.stringify(r).indexOf('SECRET_TOKEN'), -1);
  });

  test('[R49] the scan exposes one parsed notation per judged notation', () => {
    const content = makePlan({ criteria: '  - `grep -c a f` [HEAD=1 EXPECT>=2]\n  - `grep -c b f` [HEAD=1 EXPECT=2]\n  - [HEAD=0 EXPECT>=1]' });
    const scan = baseline.scanBaselineNotation(content);
    assert.strictEqual(scan.notationCount, 3);
    assert.deepStrictEqual(scan.notations.map((n) => n.line), [15, 17]);
    assert.ok(scan.notations.every((n) => n.notation && typeof n.index === 'number'));
  });
});

describe('#4310 execArgvQuarantined seam', () => {
  test('[R45] a .cmd that Windows would mediate through cmd.exe is refused, never spawned', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4310-'));
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, 'grep.cmd'), '@echo pwned\r\n');
    const r = projection.execArgvQuarantined('grep', ['-c', 'x', 'f'], {
      cwd: dir,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 1024,
      platform: 'win32',
      env: { PATH: dir, Path: dir, PATHEXT: '.cmd' }, // same case as the file: the bench FS is case-sensitive
    });
    assert.strictEqual(r.outcome, 'refused');
    assert.strictEqual(r.exitCode, null);
  });

  test('[R54] an unresolved bare name on Windows is not_found, never searched in the cwd (F3)', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4310-'));
    t.after(() => cleanup(dir));
    const r = projection.execArgvQuarantined('grep', ['-c', 'x', 'f'], {
      cwd: dir,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 1024,
      platform: 'win32',
      env: { PATH: dir, Path: dir, PATHEXT: '.EXE' },
    });
    assert.strictEqual(r.outcome, 'not_found');
    assert.strictEqual(r.exitCode, null);
  });

  test('[R57] a relative or empty PATH entry never resolves into the cwd (POSIX)', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4310-'));
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, 'grep'), '#!/bin/sh\ntouch PLANTED\n', { mode: 0o755 });
    const r = projection.execArgvQuarantined('grep', ['-c', 'x', 'f'], {
      cwd: dir,
      env: { PATH: '.' + ':' + '' + ':' + 'bin' },
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 1024,
      platform: 'linux',
    });
    assert.strictEqual(r.outcome, 'not_found');
    assert.strictEqual(fs.existsSync(path.join(dir, 'PLANTED')), false);
  });

  test('[R58] a relative PATH entry never resolves into the cwd (win32)', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4310-'));
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, 'grep.exe'), 'MZ');
    const r = projection.execArgvQuarantined('grep', ['-c', 'x', 'f'], {
      cwd: dir,
      env: { PATH: '.;bin', Path: '.;bin', PATHEXT: '.EXE' },
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 1024,
      platform: 'win32',
    });
    assert.strictEqual(r.outcome, 'not_found');
  });

  test('[R59] a relative program containing a separator is not_found', () => {
    const r = projection.execArgvQuarantined('./grep', [], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 });
    assert.strictEqual(r.outcome, 'not_found');
  });

  test('[R46] exited, not_found, timed_out and overflow are distinct outcomes', () => {
    const ok = projection.execArgvQuarantined(process.execPath, ['-e', 'process.stdout.write("7");process.exit(1)'], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 });
    assert.strictEqual(ok.outcome, 'exited');
    assert.strictEqual(ok.exitCode, 1);
    assert.strictEqual(ok.stdout, '7');
    const missing = projection.execArgvQuarantined('gsd-no-such-binary-4310', [], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 });
    assert.strictEqual(missing.outcome, 'not_found');
    const slow = projection.execArgvQuarantined(process.execPath, ['-e', `setTimeout(() => {}, ${PROBE_TIMEOUT_MS * 4})`], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 });
    assert.strictEqual(slow.outcome, 'timed_out');
    const big = projection.execArgvQuarantined(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 });
    assert.strictEqual(big.outcome, 'overflow');
  });
});

describe('#4310 e2e: verify plan-structure --replay', () => {
  const PLAN = '.planning/phases/01-test/01-01-PLAN.md';
  let tmpDir;
  let commitCount;

  beforeEach(() => {
    tmpDir = createTempGitProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
    const r = runGit(['rev-list', '--count', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    assert.strictEqual(r.outcome, OUTCOME.EXITED);
    commitCount = Number(r.stdout.trim());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function run(content, args) {
    fs.writeFileSync(path.join(tmpDir, PLAN), content);
    const result = runGsdTools(['verify', 'plan-structure'].concat(args || [PLAN]), tmpDir);
    return { result, out: JSON.parse(result.output) };
  }

  test('[R1] without --replay the payload has no replay key', () => {
    const { result, out } = run(critLine('git rev-list --count HEAD', `[HEAD=${commitCount} EXPECT>=${commitCount + 1}]`));
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual('replay' in out, false);
  });

  test('[R40] a recorded baseline that matches HEAD replays as a match', () => {
    const { result, out } = run(critLine('git rev-list --count HEAD', `[HEAD=${commitCount} EXPECT>=${commitCount + 1}]`), [PLAN, '--replay']);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(out.valid, true);
    assert.strictEqual(out.replay.results.length, 1);
    assert.strictEqual(out.replay.results[0].outcome, 'match');
    assert.strictEqual(out.replay.mismatch_count, 0);
    assert.strictEqual(typeof out.replay.head_sha, 'string');
    assert.strictEqual(out.replay.head_sha.length, 40);
  });

  test('[R41] a recorded baseline the command contradicts is a warning, never a failure', () => {
    const wrong = commitCount + 4;
    const { result, out } = run(critLine('git rev-list --count HEAD', `[HEAD=${wrong} EXPECT>=${wrong + 1}]`), [PLAN, '--replay']);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(out.valid, true);
    assert.strictEqual(out.replay.mismatch_count, 1);
    assert.deepStrictEqual(out.replay.results[0].observed, { kind: 'integer', value: commitCount });
    assert.ok(out.warnings.length >= 1);
  });

  test('[R42] --replay may come before the file', () => {
    const { result, out } = run(critLine('git rev-parse --is-inside-work-tree', '[HEAD=present EXPECT==absent]'), ['--replay', PLAN]);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(out.replay.results[0].outcome, 'match');
  });

  test('[R43] B1 still decides validity; replay rides alongside', () => {
    const { result, out } = run(critLine('git rev-list --count HEAD', `[HEAD=${commitCount} EXPECT>=${commitCount}]`), [PLAN, '--replay']);
    assert.strictEqual(result.exitCode, 1);
    assert.deepStrictEqual(out.baseline_findings.map((f) => f.rule), ['B1']);
    assert.strictEqual(out.replay.results[0].outcome, 'match');
  });

  test('[R44] a hostile command is disallowed and has no effect', () => {
    const { result, out } = run(critLine('git grep x; touch PWNED', '[HEAD=1 EXPECT>=2]'), [PLAN, '--replay']);
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(out.replay.statuses.map((s) => s.code), ['disallowed']);
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'PWNED')), false);
  });

  test('[R56] an operand symlinked outside the project is disallowed (F4)', (t) => {
    try {
      fs.symlinkSync(os.tmpdir(), path.join(tmpDir, 'out'));
    } catch {
      t.skip('symlinks unavailable');
      return;
    }
    const { result, out } = run(critLine('git grep -c x -- out', '[HEAD=1 EXPECT>=2]'), [PLAN, '--replay']);
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(out.replay.statuses.map((s) => s.code), ['disallowed']);
  });
});
