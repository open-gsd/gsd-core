'use strict';

/**
 * #4780 — `quick-batch parse-args --stdin`: the typed task text reaches the
 * parser on standard input through a QUOTED heredoc, so quotes, `$(...)`,
 * backticks and newlines in it can never break out of a shell position.
 *
 * Unit cases drive the router through its injected stdin seam. The breakout
 * cases run the REAL `gsd-tools` CLI under bash, using the exact bash fence
 * from commands/gsd/quick-batch.md, with hostile text and canary files.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { routeQuickBatchCommand } = require('../gsd-core/bin/lib/quick-batch-command-router.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { cleanup } = require('./helpers.cjs');

const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const COMMAND_MD = path.join(__dirname, '..', 'commands', 'gsd', 'quick-batch.md');

function route(args, readStdin) {
  const calls = [];
  const errors = [];
  routeQuickBatchCommand({
    args: ['quick-batch', 'parse-args', ...args],
    cwd: '/tmp/proj',
    raw: true,
    error: (msg) => errors.push(msg),
    _quickBatch: {},
    _quickBatchDispatch: {
      parseQuickBatchArgs: (rawArgs) => {
        calls.push(rawArgs);
        return { ok: true, value: {} };
      },
    },
    _readStdin: readStdin,
  });
  return { calls, errors };
}

describe('parse-args --stdin: router behavior (injected stdin)', () => {
  test('splits the whole stdin text into tokens itself', () => {
    const { calls } = route(['--stdin'], () => '--jobs 4 --validate\n');
    assert.deepEqual(calls[0], ['--jobs', '4', '--validate']);
  });

  test('empty stdin yields an empty token array', () => {
    assert.deepEqual(route(['--stdin'], () => '').calls[0], []);
  });

  test('whitespace-only stdin yields an empty token array', () => {
    assert.deepEqual(route(['--stdin'], () => ' \n\t \n').calls[0], []);
  });

  test('hostile characters are passed through as literal tokens', () => {
    const hostile = '--jobs 2 "; rm -rf x; " $(id) `id` *.txt\n--validate';
    const { calls } = route(['--stdin'], () => hostile);
    assert.deepEqual(calls[0], ['--jobs', '2', '";', 'rm', '-rf', 'x;', '"', '$(id)', '`id`', '*.txt', '--validate']);
  });

  test('a stdin read failure is reported as a usage error, not thrown', () => {
    const { calls, errors } = route(['--stdin'], () => {
      throw new Error('EAGAIN: resource temporarily unavailable');
    });
    assert.equal(calls.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /could not read standard input/);
  });

  test('--stdin wins over --text when both are present', () => {
    const { calls } = route(['--stdin', '--text', 'ignored'], () => '--validate');
    assert.deepEqual(calls[0], ['--validate']);
  });

  test('the legacy --text form still works', () => {
    assert.deepEqual(route(['--text', '--jobs 4'], undefined).calls[0], ['--jobs', '4']);
  });
});

function extractTemplateFence() {
  const text = fs.readFileSync(COMMAND_MD, 'utf8');
  const start = text.indexOf('```bash\nQUICK_BATCH_PARSE_FILE');
  assert.ok(start !== -1, 'quick-batch.md must carry the parse-args bash fence');
  const bodyStart = text.indexOf('\n', start) + 1;
  const end = text.indexOf('\n```', bodyStart);
  return text.slice(bodyStart, end);
}

function runTemplateWithText(typedText, workDir) {
  const fence = extractTemplateFence();
  const placeholder = /^<the exact contents of the `<arguments>` block, verbatim>$/m;
  assert.ok(placeholder.test(fence), 'the fence must carry the verbatim-paste placeholder line');
  const filled = fence.replace(placeholder, () => typedText);
  const script = [
    `gsd_run() { "${process.execPath}" "${TOOLS}" "$@"; }`,
    `cd "${workDir}"`,
    filled,
    'printf "RC=%s\\n%s\\n" "$QUICK_BATCH_PARSE_RC" "$QUICK_BATCH_PARSE"',
    '',
  ].join('\n');
  const scriptPath = path.join(workDir, 'run.sh');
  fs.writeFileSync(scriptPath, script);
  return runHook(scriptPath, [], { interpreter: 'bash', cwd: workDir, timeoutMs: PROBE_TIMEOUT_MS });
}

describe('quick-batch template: hostile typed text cannot break out of the shell', () => {
  const skip = process.platform === 'win32' ? 'bash heredoc semantics are exercised on POSIX lanes' : false;

  function withWorkDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-stdin-'));
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    try {
      fn(dir);
    } finally {
      cleanup(dir);
    }
  }

  test('quotes, $(...), backticks and newlines run nothing and reach the parser intact', { skip }, () => {
    withWorkDir((dir) => {
      const c1 = path.join(dir, 'CANARY_QUOTE');
      const c2 = path.join(dir, 'CANARY_SUBST');
      const c3 = path.join(dir, 'CANARY_TICK');
      const c4 = path.join(dir, 'CANARY_NEWLINE');
      const hostile = [
        `--jobs 2 "; touch ${c1}; echo "`,
        `$(touch ${c2}) \`touch ${c3}\` '`,
        `"`,
        `touch ${c4}`,
        `--validate`,
      ].join('\n');
      const r = runTemplateWithText(hostile, dir);
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, 0, r.stderr);
      for (const canary of [c1, c2, c3, c4]) {
        assert.equal(fs.existsSync(canary), false, `${path.basename(canary)} exists: the text escaped into the shell`);
      }
      assert.match(r.stdout, /^RC=0$/m);
      assert.match(r.stdout, /"jobs": 2/);
      assert.match(r.stdout, /"validate": true/);
    });
  });

  test('a single unbalanced quote does not break parsing (bash 3.2 and zsh-safe shape)', { skip }, () => {
    withWorkDir((dir) => {
      const r = runTemplateWithText(`--jobs 3 "unbalanced\n--validate`, dir);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /^RC=0$/m);
      assert.match(r.stdout, /"jobs": 3/);
    });
  });

  test('empty text parses as no flags', { skip }, () => {
    withWorkDir((dir) => {
      const r = runTemplateWithText('', dir);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /^RC=0$/m);
      assert.match(r.stdout, /"jobs": "auto"/);
    });
  });

  test('control: the pre-fix shape (text spliced into --text "...") DOES execute injected commands', { skip }, () => {
    withWorkDir((dir) => {
      const canary = path.join(dir, 'CANARY_OLD_SHAPE');
      const scriptPath = path.join(dir, 'old.sh');
      const hostile = `$(touch ${canary})`;
      fs.writeFileSync(
        scriptPath,
        `cd "${dir}"\n"${process.execPath}" "${TOOLS}" quick-batch parse-args --raw --text "${hostile}" >/dev/null 2>&1\n`,
      );
      const r = runHook(scriptPath, [], { interpreter: 'bash', cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(fs.existsSync(canary), true, 'the control must demonstrate the breakout it guards against');
    });
  });
});
