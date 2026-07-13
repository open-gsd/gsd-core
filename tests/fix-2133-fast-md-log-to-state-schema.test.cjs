/**
 * #2133 — fast.md log_to_state schema gate is unreachable.
 *
 * PR #85 added a column-count guard to fast.md's log_to_state step that used
 * `awk -F'|' '{print NF-1}'`. A markdown table header has both a leading and a
 * trailing pipe, so NF counts (real columns + 2) and NF-1 is always one too
 * high. The `-eq 5` test could therefore never hold for the 5-column header
 * quick.md writes, so /gsd-fast has never appended a Quick Task row since #85.
 *
 * This test does what the removed prose-regex test (bug-3805-*) did not: it
 * EXTRACTS the actual bash block deployed in fast.md and EXECUTES it against
 * real STATE.md fixtures, asserting on the filesystem result (row appended,
 * cell count aligned with header). It fails on the NF-1 bug and passes once
 * the count uses NF-2 and both 5/6-column schemas are accepted.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempProject, cleanup } = require('./helpers.cjs');

const FAST_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'fast.md');

const HEADER_5COL = '| # | Description | Date | Commit | Directory |';
const SEP_5COL = '|---|-------------|------|--------|-----------|';
const HEADER_6COL = '| # | Description | Date | Commit | Status | Directory |';
const SEP_6COL = '|---|-------------|------|--------|--------|-----------|';

/**
 * Extract the ```bash block embedded in fast.md's <step name="log_to_state">.
 * This is the exact program the workflow runs — executing it is a behavioral
 * test of the deployed product, not a source-grep over its prose.
 */
function extractLogToStateBash() {
  const content = fs.readFileSync(FAST_MD, 'utf8');
  const stepTag = '<step name="log_to_state">';
  const stepStart = content.indexOf(stepTag);
  assert.notEqual(stepStart, -1, 'fast.md must contain a log_to_state step');
  const stepEnd = content.indexOf('</step>', stepStart);
  assert.notEqual(stepEnd, -1, 'log_to_state step must close');
  const step = content.slice(stepStart, stepEnd);
  const fenceStart = step.indexOf('```bash');
  assert.notEqual(fenceStart, -1, 'log_to_state step must contain a bash block');
  const codeStart = step.indexOf('\n', fenceStart) + 1;
  const fenceEnd = step.indexOf('\n```', codeStart);
  assert.notEqual(fenceEnd, -1, 'log_to_state bash block must close');
  return step.slice(codeStart, fenceEnd);
}

function makeStateMd(headerLine, separatorLine, existingRows) {
  return [
    '# Project State',
    '',
    '### Blockers/Concerns',
    '',
    'None.',
    '',
    '### Quick Tasks Completed',
    '',
    headerLine,
    separatorLine,
    ...existingRows,
    '',
  ].join('\n');
}

/** Count `|` chars on a line — the invariant cell-count signal. */
function pipeCount(line) {
  return (line.match(/\|/g) || []).length;
}

/** Data rows = lines starting with `|` that are not the separator or header. */
function dataRows(content) {
  return content.split(/\r?\n/).filter((l) => {
    if (!l.startsWith('|')) return false;
    if (/^[|][-: |]*[|]$/.test(l)) return false; // separator
    if (/Description/.test(l)) return false; // header
    return true;
  });
}

describe('#2133 fast.md log_to_state schema gate', () => {
  const bashBlock = extractLogToStateBash();
  const TASK_DESC = 'sample inline fix';

  /**
   * Run the extracted log_to_state bash against a temp project's STATE.md and
   * return the post-run file content + captured stdout.
   */
  function runAgainst(headerLine, separatorLine, existingRows) {
    const tmpDir = createTempProject('fix-2133-');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, makeStateMd(headerLine, separatorLine, existingRows));
    // Cleanup is bound by each caller via t.after(tmpDir).
    const stdout = execFileSync('bash', ['-c', bashBlock], {
      cwd: tmpDir,
      env: { ...process.env, TASK: TASK_DESC },
      encoding: 'utf8',
    });
    const after = fs.readFileSync(statePath, 'utf8');
    return { tmpDir, stdout, after };
  }

  test('appends a 5-cell row to the 5-column (non-validate) schema (#27 stays fixed)', (t) => {
    const before = makeStateMd(HEADER_5COL, SEP_5COL, ['| 1 | earlier task | 2026-07-01 | deadbee | — |']);
    const { tmpDir, after } = runAgainst(HEADER_5COL, SEP_5COL, ['| 1 | earlier task | 2026-07-01 | deadbee | — |']);
    t.after(() => cleanup(tmpDir));

    const rowsBefore = dataRows(before).length;
    const rowsAfter = dataRows(after).length;
    assert.equal(rowsAfter - rowsBefore, 1, 'exactly one row must be appended');

    const appended = dataRows(after).slice(-1)[0];
    assert.equal(pipeCount(appended), pipeCount(HEADER_5COL),
      'appended row pipe-count must match the 5-column header (no malformed row)');
    assert.ok(appended.includes(TASK_DESC), 'appended row must carry the task description');
  });

  test('appends a 6-cell row to the 6-column (validate, with Status) schema', (t) => {
    const before = makeStateMd(HEADER_6COL, SEP_6COL, []);
    const { tmpDir, after } = runAgainst(HEADER_6COL, SEP_6COL, []);
    t.after(() => cleanup(tmpDir));

    const rowsBefore = dataRows(before).length;
    const rowsAfter = dataRows(after).length;
    assert.equal(rowsAfter - rowsBefore, 1, 'exactly one row must be appended to the 6-column table');

    const appended = dataRows(after).slice(-1)[0];
    assert.equal(pipeCount(appended), pipeCount(HEADER_6COL),
      'appended row pipe-count must match the 6-column header (cell count aligned with header)');
    assert.ok(appended.includes(TASK_DESC), 'appended row must carry the task description');
  });

  test('column count awk uses NF-2 (real columns — the off-by-one root cause)', () => {
    // The deployed bash must compute the real column count. A 5-column header
    // split on '|' yields NF=7; the correct real-column formula is NF-2=5.
    // (NF-1 was the off-by-one bug: it returned 6, making `-eq 5` unsatisfiable.)
    // Match the executable COL_COUNT assignment specifically — the explanatory
    // comment may still reference "NF-1" to document the history.
    assert.match(
      bashBlock,
      /COL_COUNT=\$\(.+awk -F'\|' '\{print NF-2\}'\)/,
      'COL_COUNT must be derived via awk NF-2 (NF-1 was the off-by-one bug)'
    );
  });

  test('unrecognized schema still skips with a warning (safety guard intact)', (t) => {
    // A 3-column table quick.md never writes must NOT receive a row.
    const weirdHeader = '| Alpha | Beta | Gamma |';
    const weirdSep = '|-------|------|-------|';
    const before = makeStateMd(weirdHeader, weirdSep, []);
    const { tmpDir, stdout, after } = runAgainst(weirdHeader, weirdSep, []);
    t.after(() => cleanup(tmpDir));

    assert.equal(dataRows(after).length, dataRows(before).length,
      'no row may be appended for an unrecognized schema');
    assert.ok(/unrecognized schema/i.test(stdout),
      'the unrecognized-schema warning must be emitted');
  });

  test('no Quick Tasks table → silent no-op', (t) => {
    const tmpDir = createTempProject('fix-2133-noop-');
    t.after(() => cleanup(tmpDir));
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const before = '# Project State\n\n### Blockers/Concerns\n\nNone.\n';
    fs.writeFileSync(statePath, before);
    const stdout = execFileSync('bash', ['-c', bashBlock], {
      cwd: tmpDir,
      env: { ...process.env, TASK: TASK_DESC },
      encoding: 'utf8',
    });
    const after = fs.readFileSync(statePath, 'utf8');
    assert.equal(after, before, 'STATE.md must be untouched when no Quick Tasks table exists');
    assert.equal(stdout, '', 'no output when there is no table to update');
  });
});
