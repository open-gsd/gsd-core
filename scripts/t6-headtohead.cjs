#!/usr/bin/env node
/**
 * ADR-1372 T6 head-to-head harness.
 *
 * Verifies that the seam-migrated state.cts produces BYTE-IDENTICAL STATE.md output
 * compared to origin/next for every cmdState* write operation across a matrix of
 * representative inputs.
 *
 * Usage:  node scripts/t6-headtohead.cjs
 *
 * Exit 0 = 0 diffs (PASS).  Exit 1 = any diff detected (FAIL).
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const LIB_DIR = path.join(ROOT, 'gsd-core', 'bin', 'lib');
const SRC_STATE = path.join(ROOT, 'src', 'state.cts');
const BUILT_STATE_CJS = path.join(LIB_DIR, 'state.cjs');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Standard inline-format STATE.md with all canonical sections. */
const STATE_INLINE = `---
gsd_state_version: '1.0'
milestone: v1.0
milestone_name: TestMilestone
status: executing
last_updated: '2026-01-01T00:00:00.000Z'
last_activity: '2026-01-01'
progress:
  total_phases: 3
  completed_phases: 0
  total_plans: 9
  completed_plans: 3
  percent: 33
---

# Project State

**Current focus:** Phase 1

## Current Position

Phase: 1 (Setup)
Plan: 2 of 3
Status: Executing Phase 1
Last Activity: 2026-01-01
Last activity: 2026-01-01

## Decisions Made

- [Phase 1]: Use Node.js for tooling

### Blockers

None yet.

## Accumulated Context

### Roadmap Evolution

None yet.

## Session

**Last session:** 2026-01-01T00:00:00.000Z
**Stopped at:** None
**Resume file:** None
`;

/** STATE.md with trailing blank lines in sections (tests untrimmed span). */
const STATE_TRAILING_BLANKS = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

## Current Position

Phase: 1

Status: Executing Phase 1
Last Activity: 2026-01-01


## Decisions Made

- [Phase 1]: First decision


### Blockers

- Bug in auth service

### Recently Completed

- Phase 1 Plan 1

`;

/** CRLF STATE.md */
const STATE_CRLF = `---\r\ngsd_state_version: '1.0'\r\nstatus: executing\r\n---\r\n\r\n# Project State\r\n\r\n## Current Position\r\n\r\nStatus: Executing Phase 2\r\nLast Activity: 2026-01-01\r\n\r\n### Blockers\r\n\r\nNone.\r\n\r\n## Accumulated Context\r\n\r\n### Roadmap Evolution\r\n\r\n- Phase 1 added: Initial migration\r\n`;

/** STATE.md missing frontmatter (bare body). */
const STATE_NO_FRONTMATTER = `# Project State

**Current focus:** Phase 2

## Current Position

Phase: 2
Plan: 1 of 4
Status: Executing Phase 2
Last Activity: 2026-01-01

## Decisions Made

- [Phase 1]: Chose PostgreSQL

### Blockers

None.

## Accumulated Context

### Roadmap Evolution

None yet.
`;

/** STATE.md with nested Accumulated Context + Roadmap Evolution. */
const STATE_NESTED_ACC = `---
gsd_state_version: '1.0'
status: executing
---

# Project State

## Current Position

Phase: 3
Status: Executing Phase 3

## Decisions Made

- [Phase 1]: Use TypeScript
- [Phase 2]: Use Jest

### Blockers

None.

## Accumulated Context

Some context text here.

### Roadmap Evolution

- Phase 1 added: Initial planning
- Phase 2 changed: Scope updated

### Session Notes

Some notes.

## Session

**Last session:** 2026-01-01T00:00:00.000Z
**Stopped at:** None
**Resume file:** None
`;

/** STATE.md with no Current Position section (tests absent-section handling). */
const STATE_NO_CURRENT_POS = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

## Decisions Made

- [Phase 1]: First decision

### Blockers

None.
`;

/** STATE.md post-milestone-close with progress counters. */
const STATE_POST_MILESTONE = `---
gsd_state_version: '1.0'
milestone: v2.0
milestone_name: NextMilestone
status: planning
progress:
  total_phases: 4
  completed_phases: 4
  total_plans: 12
  completed_plans: 12
  percent: 100
---

# Project State

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-01-15 — Milestone v2.0 started

## Accumulated Context

### Roadmap Evolution

- Phase 1 complete after Phase 1: Migration done
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't6-hth-'));
  const planDir = path.join(d, '.planning');
  fs.mkdirSync(planDir, { recursive: true });
  return { d, planDir };
}

function writeState(planDir, content) {
  fs.writeFileSync(path.join(planDir, 'STATE.md'), content, 'utf-8');
}

function readState(planDir) {
  try {
    return fs.readFileSync(path.join(planDir, 'STATE.md'), 'utf-8');
  } catch {
    return null;
  }
}

function runOp(tmpDir, args) {
  const argv = Array.isArray(args) ? args : args.split(/\s+/);
  try {
    execFileSync(process.execPath, [GSD_TOOLS, ...argv], {
      cwd: tmpDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GSD_SESSION_KEY: '',
        CODEX_THREAD_ID: '',
        CLAUDE_SESSION_ID: '',
      },
      timeout: 30000,
    });
  } catch {
    // Ignore exit codes — we only care about the resulting STATE.md
  }
}

function buildOriginNext() {
  // Save HEAD state.cts
  const headSrc = fs.readFileSync(SRC_STATE, 'utf-8');
  // Save HEAD built state.cjs
  const headCjs = fs.readFileSync(BUILT_STATE_CJS, 'utf-8');

  try {
    // Checkout origin/next state.cts
    const co = spawnSync('git', ['show', `origin/next:src/state.cts`], {
      cwd: ROOT, encoding: 'utf-8', timeout: 10000,
    });
    if (co.status !== 0) throw new Error('git show failed: ' + co.stderr);
    fs.writeFileSync(SRC_STATE, co.stdout, 'utf-8');

    // Build the origin/next state.cjs
    const build = spawnSync(process.execPath, [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p', path.join(ROOT, 'tsconfig.build.json'),
    ], { cwd: ROOT, encoding: 'utf-8', timeout: 60000 });
    if (build.status !== 0) throw new Error('tsc failed: ' + build.stderr);

    // Save the built origin/next state.cjs
    const originCjs = fs.readFileSync(BUILT_STATE_CJS, 'utf-8');
    return { originCjs, restore: () => {
      fs.writeFileSync(SRC_STATE, headSrc, 'utf-8');
      fs.writeFileSync(BUILT_STATE_CJS, headCjs, 'utf-8');
    }};
  } catch (e) {
    // Restore HEAD on error
    fs.writeFileSync(SRC_STATE, headSrc, 'utf-8');
    fs.writeFileSync(BUILT_STATE_CJS, headCjs, 'utf-8');
    throw e;
  }
}

// ─── Operations to test ───────────────────────────────────────────────────────

const TODAY = '2026-06-17';

const OPERATIONS = [
  // record-session: no-op case (no session fields in body → recorded:false)
  {
    label: 'record-session (no-op/recorded:false)',
    fixture: STATE_NO_FRONTMATTER,
    op: ['state-record-session'],
    noopGuard: true,
  },
  // record-session: with --stopped-at
  {
    label: 'record-session --stopped-at',
    fixture: STATE_INLINE,
    op: ['state-record-session', '--stopped-at', '14.3'],
  },
  // record-session: with --resume-file
  {
    label: 'record-session --resume-file',
    fixture: STATE_INLINE,
    op: ['state-record-session', '--resume-file', 'plan-3.md'],
  },
  // add-decision
  {
    label: 'add-decision (section present)',
    fixture: STATE_INLINE,
    op: ['state-add-decision', '--phase', '2', '--summary', 'Use Docker for builds'],
  },
  {
    label: 'add-decision (section absent → DWIM)',
    fixture: STATE_NO_CURRENT_POS,
    op: ['state-add-decision', '--phase', '1', '--summary', 'Use Node.js'],
  },
  {
    label: 'add-decision (trailing blanks fixture)',
    fixture: STATE_TRAILING_BLANKS,
    op: ['state-add-decision', '--phase', '3', '--summary', 'Add monitoring'],
  },
  // add-blocker
  {
    label: 'add-blocker (section present)',
    fixture: STATE_INLINE,
    op: ['state-add-blocker', '--text', 'Flaky CI on Windows'],
  },
  {
    label: 'add-blocker (section absent → DWIM)',
    fixture: STATE_NO_FRONTMATTER,
    op: ['state-add-blocker', '--text', 'Build pipeline broken'],
  },
  {
    label: 'add-blocker (CRLF)',
    fixture: STATE_CRLF,
    op: ['state-add-blocker', '--text', 'NFS mount issue'],
  },
  // resolve-blocker
  {
    label: 'resolve-blocker',
    fixture: STATE_TRAILING_BLANKS,
    op: ['state-resolve-blocker', 'Bug in auth service'],
  },
  // add-roadmap-evolution
  {
    label: 'add-roadmap-evolution (subSection present)',
    fixture: STATE_NESTED_ACC,
    op: ['state-add-roadmap-evolution', '--phase', '4', '--action', 'added', '--note', 'New API endpoint'],
  },
  {
    label: 'add-roadmap-evolution (subSection absent)',
    fixture: STATE_INLINE,
    op: ['state-add-roadmap-evolution', '--phase', '3', '--action', 'changed', '--note', 'Scope updated significantly'],
  },
  {
    label: 'add-roadmap-evolution (accSection absent → DWIM)',
    fixture: STATE_NO_CURRENT_POS,
    op: ['state-add-roadmap-evolution', '--phase', '1', '--action', 'added', '--note', 'Initial setup'],
  },
  {
    label: 'add-roadmap-evolution (CRLF)',
    fixture: STATE_CRLF,
    op: ['state-add-roadmap-evolution', '--phase', '2', '--action', 'changed', '--note', 'CRLF test case'],
  },
  {
    label: 'add-roadmap-evolution (post-milestone)',
    fixture: STATE_POST_MILESTONE,
    op: ['state-add-roadmap-evolution', '--phase', '2', '--action', 'added', '--note', 'New phase inserted'],
  },
  // update-position fields (via begin-phase which uses positionPattern)
  {
    label: 'begin-phase (inline format)',
    fixture: STATE_INLINE,
    op: ['state-begin-phase', '--phase', '2', '--phase-name', 'Build', '--plan-count', '4'],
  },
  {
    label: 'begin-phase (no-frontmatter)',
    fixture: STATE_NO_FRONTMATTER,
    op: ['state-begin-phase', '--phase', '3', '--plan-count', '2'],
  },
  {
    label: 'begin-phase (no current position)',
    fixture: STATE_NO_CURRENT_POS,
    op: ['state-begin-phase', '--phase', '1', '--phase-name', 'Setup', '--plan-count', '3'],
  },
  // complete-phase
  {
    label: 'complete-phase (inline)',
    fixture: STATE_INLINE,
    op: ['state-complete-phase'],
  },
  {
    label: 'complete-phase (trailing blanks)',
    fixture: STATE_TRAILING_BLANKS,
    op: ['state-complete-phase'],
  },
  {
    label: 'complete-phase (CRLF)',
    fixture: STATE_CRLF,
    op: ['state-complete-phase', '--phase', '2'],
  },
  // milestone-switch
  {
    label: 'milestone-switch (position present)',
    fixture: STATE_INLINE,
    op: ['state-milestone-switch', '--milestone', 'v2.0', '--name', 'NextMilestone'],
  },
  {
    label: 'milestone-switch (no position)',
    fixture: STATE_NO_CURRENT_POS,
    op: ['state-milestone-switch', '--milestone', 'v3.0'],
  },
  // record-metric (complex metricsPattern — NOT migrated, must still be identical)
  {
    label: 'record-metric (section present)',
    fixture: STATE_INLINE + `\n## Performance Metrics\n\n| Phase | Plan | Duration | Notes |\n|-------|------|----------|-------|\n| Phase 1 P1 | 5m | - tasks | - files |\n`,
    op: ['state-record-metric', '--phase', '1', '--plan', '2', '--duration', '8m'],
  },
  {
    label: 'record-metric (section absent → DWIM)',
    fixture: STATE_NO_FRONTMATTER,
    op: ['state-record-metric', '--phase', '2', '--plan', '1', '--duration', '12m'],
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('ADR-1372 T6 head-to-head harness');
console.log('─'.repeat(60));

let totalDiffs = 0;
let noopGuardOk = false;
let totalOps = 0;

// Phase 1: collect HEAD results
console.log('\n[1/3] Running operations with HEAD build ...');
const headResults = new Map();
for (const op of OPERATIONS) {
  const { d, planDir } = makeTmpDir();
  writeState(planDir, op.fixture);
  runOp(d, op.op);
  const after = readState(planDir);
  headResults.set(op.label, { before: op.fixture, after });

  if (op.noopGuard) {
    const unchanged = after === op.fixture;
    noopGuardOk = unchanged;
    console.log(`  [noop-guard] ${op.label}: ${unchanged ? 'OK (no write)' : 'FAIL (file was written)'}`);
  }

  // Cleanup
  fs.rmSync(d, { recursive: true, force: true });
}

// Phase 2: build origin/next, collect results
console.log('\n[2/3] Building origin/next state.cjs ...');
let restore;
let originResults;
try {
  const { originCjs, restore: r } = buildOriginNext();
  restore = r;

  // Write origin/next state.cjs temporarily
  fs.writeFileSync(BUILT_STATE_CJS, originCjs, 'utf-8');

  console.log('      Running operations with origin/next build ...');
  originResults = new Map();
  for (const op of OPERATIONS) {
    const { d, planDir } = makeTmpDir();
    writeState(planDir, op.fixture);
    runOp(d, op.op);
    const after = readState(planDir);
    originResults.set(op.label, after);
    fs.rmSync(d, { recursive: true, force: true });
  }
} finally {
  // Always restore HEAD
  if (restore) restore();
  console.log('      HEAD build restored.');
}

// Phase 3: diff
console.log('\n[3/3] Comparing outputs ...\n');
for (const op of OPERATIONS) {
  totalOps++;
  const head = headResults.get(op.label)?.after;
  const origin = originResults.get(op.label);

  if (head === origin) {
    console.log(`  ✔  ${op.label}`);
  } else {
    totalDiffs++;
    console.log(`  ✘  ${op.label} — DIFF DETECTED`);
    if (head === null) {
      console.log('     HEAD: STATE.md missing');
    } else if (origin === null) {
      console.log('     origin/next: STATE.md missing');
    } else {
      // Print first differing line
      const headLines = head.split('\n');
      const originLines = origin.split('\n');
      const maxLen = Math.max(headLines.length, originLines.length);
      for (let i = 0; i < maxLen; i++) {
        if (headLines[i] !== originLines[i]) {
          console.log(`     First diff at line ${i + 1}:`);
          console.log(`       HEAD  : ${JSON.stringify(headLines[i] ?? '<missing>')}`);
          console.log(`       origin: ${JSON.stringify(originLines[i] ?? '<missing>')}`);
          break;
        }
      }
    }
  }
}

console.log('\n' + '─'.repeat(60));
console.log(`Ops tested:   ${totalOps}`);
console.log(`Diffs found:  ${totalDiffs}`);
console.log(`No-op guard:  ${noopGuardOk ? 'PASS (file unchanged on recorded:false)' : 'FAIL'}`);
console.log('─'.repeat(60));

if (totalDiffs > 0 || !noopGuardOk) {
  console.log('\nRESULT: FAIL\n');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS — 0 diffs, no-op guard preserved\n');
  process.exit(0);
}
