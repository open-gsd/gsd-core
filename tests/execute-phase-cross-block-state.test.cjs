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
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

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

// #6258: the begin-phase block is its own shell, so it must assign every value it passes.
describe('#6258: the STATE.md phase-start block assigns the phase number, name and plan count', () => {
  const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

  function beginPhaseFence() {
    const lines = splitLines(fs.readFileSync(FILES.executePhase, 'utf8'));
    const hit = scanFencedBlocks(lines).find((b) => b.closeLineIdx !== -1
      && lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n').includes('state.begin-phase'));
    assert.ok(hit, 'the begin-phase block must still call state.begin-phase in a fence');
    return lines.slice(hit.openLineIdx + 1, hit.closeLineIdx).join('\n').replaceAll('{phase_number}', '01');
  }

  // `gsd_run` answers the lookups from env by their --pick field and logs every call; `set -u` makes an unassigned variable an error.
  function runBegin({ name = 'Foundation Setup', nameRc = 0, count = '2', slug = 'foundation-setup', ws = '' }) {
    const log = path.join(repo, 'begin-phase-calls.log');
    cleanup(log);
    const script = [
      'set -u',
      'gsd_run() { printf "%s\\n" "$*" >> "$CALL_LOG"; case "$2:$*" in',
      '  roadmap.get-phase:*"--pick phase_name") printf %s "$NAME_OUT"; return "$NAME_RC";;',
      '  find-phase:*"--pick plan_count") printf %s "$COUNT_OUT";;',
      '  find-phase:*"--pick phase_name") printf %s "$SLUG_OUT";;',
      'esac; }',
      beginPhaseFence(),
    ].join('\n');
    const env = { ...process.env, NAME_OUT: name, NAME_RC: String(nameRc), COUNT_OUT: count, SLUG_OUT: slug, CALL_LOG: log };
    if (ws) env.GSD_WS = ws; else delete env.GSD_WS;
    const res = runHook('-c', [script], { interpreter: 'bash', cwd: repo, env, timeoutMs: PROBE_TIMEOUT_MS });
    const calls = fs.existsSync(log) ? splitLines(fs.readFileSync(log, 'utf8')).filter(Boolean) : [];
    return { res, calls, begun: calls.filter((c) => c.includes('state.begin-phase')) };
  }

  test('a found phase passes its number, curated name and numeric plan count to state.begin-phase', () => {
    const { res, calls, begun } = runBegin({});
    assertSeamExit(assert, res, 0, 'the block must run to completion');
    assert.equal(begun.length, 1);
    assert.match(begun[0], /--phase 01 --name Foundation Setup --plans 2$/);
    assert.match(calls[0], /roadmap\.get-phase .* --pick phase_name$/, 'the name is read from the ROADMAP display name');
    assert.match(calls[1], /find-phase .* --pick plan_count$/, 'the count is the phase plan_count');
  });

  test('the plan count is checked at limit-1, limit and limit+1', () => {
    assert.equal(runBegin({ count: '-1' }).begun.length, 0, 'limit-1 stops');
    assert.match(runBegin({ count: '0' }).begun[0], /--plans 0$/, 'limit passes');
    assert.match(runBegin({ count: '1' }).begun[0], /--plans 1$/, 'limit+1 passes');
  });

  for (const [label, count] of [['an empty', ''], ['a non-numeric', 'null'], ['a decimal', '1.5']]) {
    test(`${label} plan count stops the block before state.begin-phase`, () => {
      const { res, begun } = runBegin({ count });
      assert.notEqual(res.exitCode, 0);
      assert.match(res.stderr, /phase 01 not found/);
      assert.equal(begun.length, 0);
    });
  }

  test('a phase the ROADMAP does not name falls back to its directory name, never an empty name', () => {
    const { res, begun } = runBegin({ name: '', nameRc: 1 });
    assertSeamExit(assert, res, 0, 'an absent ROADMAP name must not stop the phase starting');
    assert.match(begun[0], /--name foundation-setup --plans 2$/);
  });

  test('a workstream scope reaches every lookup and the write', () => {
    const { res, calls } = runBegin({ ws: '--ws alpha' });
    assertSeamExit(assert, res, 0, 'the block must run to completion');
    assert.equal(calls.length, 3);
    for (const c of calls) assert.ok(c.includes('--ws=alpha'), `missing --ws=alpha in: ${c}`);
  });

  // The acceptance criterion: run the REAL commands against a fixture project and read STATE.md back.
  function realBegin({ roadmap }) {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6258-'));
    try {
      gitOrThrow(['init', '-q'], { cwd: proj, timeoutMs: PROBE_TIMEOUT_MS });
      const phaseDir = path.join(proj, '.planning', 'phases', '01-foundation-setup');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(proj, '.planning', 'ROADMAP.md'), roadmap);
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(proj, '.planning', 'STATE.md'), [
        '---', "gsd_state_version: '1.0'", 'status: planning', '---', '', '# Project State', '',
        '## Current Position', '', 'Phase: 0 of 8 (Previous)', 'Plan: 1 of 1 in current phase', 'Status: Ready',
        'Last activity: 2026-08-09 — fixture', '', 'Progress: [░░░░░░░░░░] 0%', '',
      ].join('\n'));
      const env = { ...process.env, GSD_TOOLS };
      for (const k of ['GSD_WS', 'GSD_WORKSTREAM', 'GSD_PROJECT']) delete env[k];
      const script = `set -u\ngsd_run() { node "$GSD_TOOLS" "$@"; }\n${beginPhaseFence()}`;
      const res = runHook('-c', [script], { interpreter: 'bash', cwd: proj, env, timeoutMs: PROBE_TIMEOUT_MS });
      return { res, state: fs.readFileSync(path.join(proj, '.planning', 'STATE.md'), 'utf8') };
    } finally {
      cleanup(proj);
    }
  }

  test('[end to end] STATE.md records the active phase, its curated name and the plan count', () => {
    const { res, state } = realBegin({ roadmap: '# Roadmap\n\n### Phase 1: Foundation Setup\n- [ ] w\n' });
    assertSeamExit(assert, res, 0, 'the real commands must succeed');
    assert.match(state, /^Phase: 0?1 \(Foundation Setup\) — EXECUTING$/m);
    assert.match(state, /^Plan: 1 of 2$/m);
    assert.match(state, /^current_phase_name: Foundation Setup$/m);
    assert.match(state, /^ {2}total_plans: 2$/m);
  });

  test('[end to end] a phase the ROADMAP does not describe records its directory name, not the previous phase\'s', () => {
    const { res, state } = realBegin({ roadmap: '# Roadmap\n' });
    assertSeamExit(assert, res, 0, 'the real commands must succeed');
    assert.match(state, /^current_phase_name: foundation-setup$/m);
    assert.doesNotMatch(state, /Previous/);
  });
});
