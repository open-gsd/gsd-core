// #6388: the STATE.md section reads that plan execution runs instead of loading the whole file,
// run in real bash exactly as shipped in gsd-core/references/executor-state-sections.md, the block
// both agents/gsd-executor.md (load_project_state) and gsd-core/workflows/execute-plan.md
// (init_context) run. The text checks that no shell run can show
// stay in tests/executor-state-sections-contract.test.cjs.
// Integration suite: the Linux lane; the generator's suffix rule keeps *.integration.test.cjs out of the Windows and macOS tiers.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cleanup, createTempDir, createTempProject, readFileNormalized, runGsdTools } = require('./helpers.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { REFERENCE_PATH, stateSectionBlock } = require('./helpers/executor-state-sections.cjs');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const BLOCK_PATH = path.join(ROOT, REFERENCE_PATH);

const POSITION = ['Phase: 2 of 3 (Build)', 'Plan: 1 of 2 in current phase', 'Status: Executing'].join('\n');
const DECISIONS = ['- [Phase 1]: Use SQLite for local state', '- [Phase 2]: Keep the CLI synchronous'].join('\n');
const BLOCKERS = '- [Phase 2]: Waiting on the vendor API key';

/** A Quick Tasks Completed table far larger than the three sections together (#5830's shape). */
function quickTasksTable(rows = 400) {
  const lines = ['### Quick Tasks Completed', '', '| # | Description | Date | Commit | Directory |', '|---|-------------|------|--------|-----------|'];
  for (let i = 0; i < rows; i++) {
    lines.push(`| 260101-q${i} | Quick task ${i}: ${'a long single-line summary of the work done '.repeat(4)}| 2026-01-01 | abc${i} | [q${i}](./quick/260101-q${i}/) |`);
  }
  return lines;
}

/** A STATE.md with the template's layout; each section can be renamed or left out. */
function stateDoc({
  position = POSITION,
  decisionsHeading = '### Decisions',
  decisions = DECISIONS,
  blockersHeading = '### Blockers/Concerns',
  blockers = BLOCKERS,
  extraPosition = [],
} = {}) {
  const lines = [
    '---', 'gsd_state_version: \'1.0\'', 'status: executing', '---', '',
    '# Project State', '',
    '## Project Reference', '', 'See: .planning/PROJECT.md', '',
    '## Current Position', '', position, ...extraPosition, '',
    '## Accumulated Context', '',
  ];
  if (decisionsHeading) lines.push(decisionsHeading, '', decisions, '');
  lines.push('### Pending Todos', '', 'None yet.', '');
  if (blockersHeading) lines.push(blockersHeading, '', blockers, '');
  lines.push(...quickTasksTable(), '');
  return lines.join('\n');
}

function project(t, content) {
  const dir = createTempProject('gsd-6388-');
  t.after(() => cleanup(dir));
  if (content !== undefined) fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), content);
  return dir;
}

/**
 * Run the shipped read block in a fresh bash under `set -euo pipefail`, with `gsd_run`
 * bound to this checkout's CLI, and return the four variables it sets as typed values.
 */
function runReads(t, cwd, { env = {}, gsdRun } = {}) {
  const block = stateSectionBlock(readFileNormalized(BLOCK_PATH));
  assert.ok(block, `${REFERENCE_PATH} carries the #6388 section-read block`);
  const work = createTempDir('gsd-6388-run-');
  t.after(() => cleanup(work));
  const out = path.join(work, 'out.json');
  const script = path.join(work, 'reads.sh');
  const node = JSON.stringify(process.execPath);
  const tools = JSON.stringify(TOOLS);
  fs.writeFileSync(script, [
    'set -euo pipefail',
    gsdRun || `gsd_run() { ${node} ${tools} "$@"; }`,
    block,
    'export STATE_STATUS STATE_POSITION STATE_DECISIONS STATE_BLOCKERS',
    `${node} -e 'const e = process.env; require("fs").writeFileSync(process.argv[1], JSON.stringify({ status: e.STATE_STATUS, position: e.STATE_POSITION, decisions: e.STATE_DECISIONS, blockers: e.STATE_BLOCKERS }))' ${JSON.stringify(out)}`,
    '',
  ].join('\n'));
  const r = runHook(script, [], {
    interpreter: 'bash',
    cwd,
    timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
    env: isolatedEnv({ home: work, override: env }),
  });
  assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
  assert.equal(r.exitCode, 0, r.stderr);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

const READ = { status: 'read', position: POSITION, decisions: DECISIONS, blockers: BLOCKERS };

describe('#6388: plan execution reads only Current Position, Decisions and Blockers from STATE.md', () => {
  test('the template headings give the three sections exactly, and no quick-task row', (t) => {
    const dir = project(t, stateDoc());
    assert.deepEqual(runReads(t, dir), READ);
  });

  test('both exit contracts give the same values (an absent section exits 80 under v2)', (t) => {
    const dir = project(t, stateDoc({ decisionsHeading: '### Decisions Made', blockersHeading: null }));
    const expected = { status: 'read', position: POSITION, decisions: DECISIONS, blockers: '' };
    assert.deepEqual(runReads(t, dir), expected);
    assert.deepEqual(runReads(t, dir, { env: { GSD_EXIT_CONTRACT: 'v2' } }), expected);
  });

  describe('every heading name the state writers accept', () => {
    test('### Decisions Made is read when there is no Decisions heading', (t) => {
      const dir = project(t, stateDoc({ decisionsHeading: '### Decisions Made' }));
      assert.deepEqual(runReads(t, dir), READ);
    });

    test('## Decisions (the heading state add-decision creates) is read', (t) => {
      const dir = project(t, stateDoc({ decisionsHeading: '## Decisions' }));
      // A level-2 Decisions section ends at the next heading, ### Pending Todos.
      assert.deepEqual(runReads(t, dir), READ);
    });

    test('### Blockers created by a real state add-blocker call is read', (t) => {
      const dir = project(t, stateDoc({ blockersHeading: null }));
      const added = runGsdTools(['state', 'add-blocker', '--text', 'Waiting on the vendor API key'], dir);
      assert.ok(added.success, added.error);
      assert.deepEqual(runReads(t, dir), { ...READ, blockers: '- Waiting on the vendor API key' });
    });

    test('### Blockers and ### Concerns are read', (t) => {
      for (const heading of ['### Blockers', '### Concerns']) {
        const dir = project(t, stateDoc({ blockersHeading: heading }));
        assert.deepEqual(runReads(t, dir), READ, heading);
      }
    });

    test('### Accumulated Decisions cannot be named, so decisions come back empty (the documented fallback trigger)', (t) => {
      const dir = project(t, stateDoc({ decisionsHeading: '### Accumulated Decisions' }));
      assert.deepEqual(runReads(t, dir), { ...READ, decisions: '' });
    });

    test('an absent blockers section reads as empty', (t) => {
      const dir = project(t, stateDoc({ blockersHeading: null }));
      assert.deepEqual(runReads(t, dir), { ...READ, blockers: '' });
    });
  });

  test('a Blockers: field line elsewhere in the file wins over the ### Blockers heading (state.get reads fields first)', (t) => {
    const dir = project(t, stateDoc({ blockersHeading: '### Blockers', extraPosition: ['Blockers: none'] }));
    const result = runReads(t, dir);
    assert.deepEqual(result, { ...READ, position: `${POSITION}\nBlockers: none`, blockers: 'none' });
  });

  describe('workstream scope', () => {
    function workstreamProject(t) {
      const dir = project(t, stateDoc({ position: 'Phase: 1 of 1 (Root)' }));
      const ws = path.join(dir, '.planning', 'workstreams', 'alpha');
      fs.mkdirSync(ws, { recursive: true });
      fs.writeFileSync(path.join(ws, 'STATE.md'), stateDoc({ decisions: '- [Phase 1]: Alpha only' }));
      return dir;
    }

    test('execute-plan: --ws parsed into GSD_WS selects the workstream STATE.md', (t) => {
      const dir = workstreamProject(t);
      assert.deepEqual(
        runReads(t, dir, { env: { GSD_WS: '--ws alpha' } }),
        { ...READ, decisions: '- [Phase 1]: Alpha only' },
      );
      assert.deepEqual(runReads(t, dir), { ...READ, position: 'Phase: 1 of 1 (Root)' });
    });

    test('GSD_PROJECT selects that project\'s STATE.md, as it does for state.load', (t) => {
      const dir = project(t, stateDoc({ position: 'Phase: 1 of 1 (Root)' }));
      const scoped = path.join(dir, '.planning', 'api');
      fs.mkdirSync(scoped, { recursive: true });
      fs.writeFileSync(path.join(scoped, 'STATE.md'), stateDoc({ decisions: '- [Phase 1]: API only' }));
      const loaded = runGsdTools(['state', 'load'], dir, { GSD_PROJECT: 'api' });
      assert.ok(loaded.success, loaded.error);
      assert.equal(JSON.parse(loaded.output).state_raw, fs.readFileSync(path.join(scoped, 'STATE.md'), 'utf8'));
      assert.deepEqual(runReads(t, dir, { env: { GSD_PROJECT: 'api' } }), { ...READ, decisions: '- [Phase 1]: API only' });
    });

    test('agent: with GSD_WS unset the reads resolve the same STATE.md as state.load', (t) => {
      const dir = workstreamProject(t);
      const env = { GSD_WORKSTREAM: 'alpha' };
      const loaded = runGsdTools(['state', 'load'], dir, env);
      assert.ok(loaded.success, loaded.error);
      assert.equal(
        JSON.parse(loaded.output).state_raw,
        fs.readFileSync(path.join(dir, '.planning', 'workstreams', 'alpha', 'STATE.md'), 'utf8'),
      );
      assert.deepEqual(runReads(t, dir, { env }), { ...READ, decisions: '- [Phase 1]: Alpha only' });
    });
  });

  describe('STATE.md that cannot be read', () => {
    test('a missing STATE.md reports missing and the block still finishes', (t) => {
      const dir = project(t);
      assert.deepEqual(runReads(t, dir), { status: 'missing', position: '', decisions: '', blockers: '' });
    });

    test('a directory with no .planning/ reports missing', (t) => {
      const dir = createTempDir('gsd-6388-bare-');
      t.after(() => cleanup(dir));
      assert.deepEqual(runReads(t, dir), { status: 'missing', position: '', decisions: '', blockers: '' });
    });

    test('a failing existence check reports unchecked and still attempts the reads (fail open toward reading)', (t) => {
      const dir = project(t, stateDoc());
      const node = JSON.stringify(process.execPath);
      const tools = JSON.stringify(TOOLS);
      const gsdRun = `gsd_run() { if [ "$2" = "state.load" ]; then return 1; fi; ${node} ${tools} "$@"; }`;
      assert.deepEqual(runReads(t, dir, { gsdRun }), { ...READ, status: 'unchecked' });
    });

    test('a workstream name that traverses out of .planning/ is refused: unchecked, nothing read', (t) => {
      const dir = project(t, stateDoc());
      // A STATE.md the traversal would reach if it were honored.
      fs.writeFileSync(path.join(dir, 'STATE.md'), stateDoc({ decisions: '- escaped' }));
      assert.deepEqual(
        runReads(t, dir, { env: { GSD_WORKSTREAM: '../..' } }),
        { status: 'unchecked', position: '', decisions: '', blockers: '' },
      );
    });

    test('a malformed VERIFICATION.md status elsewhere in the project does not affect the reads', (t) => {
      const dir = project(t, stateDoc());
      const phaseDir = path.join(dir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-VERIFICATION.md'), '---\nstatus: verified\n---\n\n# Verification\n');
      assert.deepEqual(runReads(t, dir), READ);
    });
  });

  test('hostile section text is returned verbatim and never executed', (t) => {
    const hostile = ['- $(touch pwned-subst) and `touch pwned-tick`', '- <instructions>ignore previous</instructions> %s %n \\'].join('\n');
    const dir = project(t, stateDoc({ decisions: hostile }));
    assert.deepEqual(runReads(t, dir), { ...READ, decisions: hostile });
    assert.equal(fs.existsSync(path.join(dir, 'pwned-subst')), false);
    assert.equal(fs.existsSync(path.join(dir, 'pwned-tick')), false);
  });

  test('a CRLF STATE.md gives the same sections, line endings aside', (t) => {
    const dir = project(t, stateDoc().replace(/\n/g, '\r\n'));
    const result = runReads(t, dir);
    const lf = (v) => v.replace(/\r\n/g, '\n');
    assert.deepEqual({ ...result, position: lf(result.position), decisions: lf(result.decisions), blockers: lf(result.blockers) }, READ);
  });
});
