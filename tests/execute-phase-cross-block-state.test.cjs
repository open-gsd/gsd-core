/**
 * #4915: execute-phase workflow steps are dispatched as separate fenced `bash`
 * blocks, and shell state does not survive from one block to the next. Two
 * values relied on it and were silently lost:
 *
 *   - REGRESSION_FILES was never assigned anywhere, so the pytest arm of the
 *     regression gate expanded it empty and ran the FULL suite while reporting a
 *     scoped run.
 *   - WAVE_FAILURE_COUNT was incremented in two blocks that each started from
 *     unset, so it could never reach 2 and the step 5.8 "Fix now" escalation
 *     could not fire.
 *
 * Both now travel through handoff files. The snippets are fenced by
 * `# gsd-handoff:begin NAME` / `# gsd-handoff:end NAME` markers in the workflow
 * text; these tests lift them out of the real files and run each occurrence in
 * its OWN `bash` process, which is the dispatch model the bug lives in.
 */
'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runHook, assertSeamExit } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const { cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const WORKFLOWS = path.join(__dirname, '..', 'gsd-core', 'workflows');
const FILES = {
  executePhase: path.join(WORKFLOWS, 'execute-phase.md'),
  postMerge: path.join(WORKFLOWS, 'execute-phase', 'steps', 'post-merge-gate.md'),
  regression: path.join(WORKFLOWS, 'execute-phase', 'steps', 'regression-gate.md'),
  regressionRun: path.join(WORKFLOWS, 'execute-phase', 'steps', 'regression-gate-run.md'),
};

/** Every `# gsd-handoff:begin NAME` ... `# gsd-handoff:end NAME` snippet in a file, in order. */
function snippets(file, name) {
  const out = [];
  let current = null;
  for (const line of splitLines(fs.readFileSync(file, 'utf8'))) {
    const trimmed = line.trim();
    if (trimmed === `# gsd-handoff:begin ${name}`) current = [];
    else if (trimmed === `# gsd-handoff:end ${name}`) { out.push(current.join('\n')); current = null; }
    else if (current) current.push(trimmed === '' ? '' : line.replace(/^ {1,3}(?=\S)/, ''));
  }
  assert.equal(current, null, `unterminated gsd-handoff snippet ${name} in ${file}`);
  return out;
}

function one(file, name) {
  const found = snippets(file, name);
  assert.equal(found.length, 1, `expected exactly one ${name} snippet in ${path.basename(file)}, found ${found.length}`);
  return found[0];
}

let repo;
before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4915-'));
  gitOrThrow(['init', '-q'], { cwd: repo, timeoutMs: PROBE_TIMEOUT_MS });
});
after(() => cleanup(repo));

/** Run a script in a fresh bash process: no variable survives into the next call. */
function runBlock(script) {
  const res = runHook('-c', [script], { interpreter: 'bash', cwd: repo, timeoutMs: PROBE_TIMEOUT_MS });
  assertSeamExit(assert, res, 0, `block failed:\n${script}`);
  return res.stdout;
}

describe('#4915: WAVE_FAILURE_COUNT accumulates across separately dispatched blocks', () => {
  const reset = () => runBlock(one(FILES.executePhase, 'wave-failure-reset'));
  const read = () => runBlock(`${one(FILES.executePhase, 'wave-failure-read')}`).trim();

  test('the build gate and the test gate each record a failure; step 5.8 reads 2, not 1', () => {
    reset();
    const records = snippets(FILES.postMerge, 'wave-failure-record');
    assert.equal(records.length, 2, 'the build gate and the test gate each record');
    for (const record of records) runBlock(record); // two independent shells
    assert.equal(read(), 'WAVE_FAILURE_COUNT=2');
  });

  test('the count keeps accumulating across waves, so the > 1 escalation can fire', () => {
    reset();
    const [record] = snippets(FILES.postMerge, 'wave-failure-record');
    runBlock(record);
    assert.equal(read(), 'WAVE_FAILURE_COUNT=1');
    runBlock(record);
    assert.equal(read(), 'WAVE_FAILURE_COUNT=2');
  });

  test('a fresh run starts from zero, and a read before any failure is 0', () => {
    const [record] = snippets(FILES.postMerge, 'wave-failure-record');
    runBlock(record);
    reset();
    assert.equal(read(), 'WAVE_FAILURE_COUNT=0');
  });

  test('no block increments a bare shell variable any more', () => {
    for (const file of [FILES.postMerge, FILES.executePhase]) {
      assert.doesNotMatch(
        fs.readFileSync(file, 'utf8'),
        /WAVE_FAILURE_COUNT=\$\(\(\s*WAVE_FAILURE_COUNT\s*\+\s*1\s*\)\)/,
        `${path.basename(file)} still increments a variable that cannot survive the next block`,
      );
    }
  });
});

describe('#4915: the regression gate runs the scoped file list, not the full suite', () => {
  const reset = () => runBlock(one(FILES.regression, 'regression-files-reset'));
  const write = (paths) => runBlock(
    one(FILES.regression, 'regression-files-write')
      .replace(/(<<'GSD_REGRESSION_FILES'\n)[\s\S]*?(\nGSD_REGRESSION_FILES)/, `$1${paths.join('\n')}$2`)
      .replace("<<'GSD_REGRESSION_FILES'\n\nGSD_REGRESSION_FILES", "<<'GSD_REGRESSION_FILES'\nGSD_REGRESSION_FILES"),
  );
  /** The consuming block's own snippets, in a new shell, ending in the command the pytest arm builds. */
  const command = () => runBlock([
    one(FILES.regressionRun, 'regression-files-read'),
    one(FILES.regressionRun, 'regression-pytest-arm'),
    'printf "%s" "$REG_TEST_CMD"',
  ].join('\n')).split('\n').pop().trimEnd();

  test('the pytest command names the collected files', () => {
    reset();
    write(['tests/test_a.py', 'tests/test_b.py']);
    assert.equal(command(), 'python -m pytest -q --tb=short -- tests/test_a.py tests/test_b.py');
  });

  test('a path with a space survives as one argument', () => {
    reset();
    write(['tests/my test.py']);
    assert.match(command(), /-- tests\/my\\ test\.py$/);
  });

  test('no collected files means the scoped run is skipped, never widened to the full suite', () => {
    reset();
    write([]);
    assert.equal(command(), 'true');
  });

  test('a list left by an earlier run is cleared by the producing step', () => {
    write(['tests/old.py']);
    reset();
    assert.equal(command(), 'true');
  });

  test('REGRESSION_FILES is no longer assumed to be in scope from the prior step', () => {
    assert.doesNotMatch(fs.readFileSync(FILES.regressionRun, 'utf8'), /Expects `REGRESSION_FILES` \(from the prior step\) in scope/);
    assert.doesNotMatch(fs.readFileSync(FILES.regression, 'utf8'), /into `REGRESSION_FILES`\./);
  });
});
