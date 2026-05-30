/**
 * Bug #501: extractCurrentMilestone leaks prior-milestone phases when the
 * ROADMAP uses a flat shared "## Phase Details" section.
 *
 * extractCurrentMilestone returns `preamble + currentSection`, where the
 * preamble is everything before the first milestone heading (only <details>
 * blocks stripped). A flat "## Phase Details" section listing every phase
 * across all milestones therefore leaks its `### Phase N:` headings into the
 * active-milestone scope, so getMilestonePhaseFilter / buildStateFrontmatter
 * count the whole project instead of just the active milestone.
 *
 * Maintainer direction (triage of #501): fix in code AND make
 * `validate consistency` milestone-aware so it does not flag shipped phase
 * dirs as orphans once the scope is correctly narrowed.
 *
 * Layout under test (mirrors the real repro):
 *   # Roadmap
 *   ## Phase Details        <- flat, BEFORE the first milestone heading
 *   ### Phase 1..3          <- shipped phases
 *   ## ✅ v2.0              <- shipped milestone
 *   ## 🚧 v3.0 (active)
 *   ### Phase 4..5          <- active-milestone phases
 * STATE.md milestone: v3.0  →  state json must report total_phases: 2.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const ROADMAP = `# Roadmap

Project overview prose that legitimately lives before the milestones.

## Phase Details

### Phase 1: Shipped One
Did a thing.

### Phase 2: Shipped Two
Did another thing.

### Phase 3: Shipped Three
Did a third thing.

## ✅ v2.0: Foundation (shipped)

Summary of the shipped milestone.

## 🚧 v3.0: Active Milestone

### Phase 4: Active One
Doing a thing.

### Phase 5: Active Two
Doing another thing.
`;

const STATE = `---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Active Milestone
status: in_progress
progress:
  total_phases: 2
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Current Position

Phase: 4 (Active One)
`;

describe('flat "## Phase Details" milestone leak (#501)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
    // All five phase dirs exist on disk (the flat layout retains shipped dirs).
    const phaseDirs = ['01-shipped-one', '02-shipped-two', '03-shipped-three', '04-active-one', '05-active-two'];
    for (const d of phaseDirs) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-PLAN.md'), '# Plan\n', 'utf-8');
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state json counts only the active milestone phases, not the flat Phase Details list', () => {
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.equal(result.success, true, result.error || result.output);
    const state = JSON.parse(result.output);
    assert.equal(
      state.progress.total_phases,
      2,
      `active milestone v3.0 has 2 phases (4,5); flat Phase Details (1-3) must not leak. Got total_phases=${state.progress.total_phases}`
    );
  });

  test('validate consistency does not flag shipped phase dirs as not-in-ROADMAP', () => {
    // Once milestone scope is correctly narrowed (Test A), the shipped phase
    // dirs (1-3) are no longer in the SCOPED roadmap. They are, however, real
    // phases listed in the FULL roadmap, so they must NOT be reported as
    // "exists on disk but not in ROADMAP" orphans. (#501 — validate must be
    // milestone-aware.)
    const result = runGsdTools(['validate', 'consistency'], tmpDir);
    const payload = JSON.parse(result.output);
    const warnings = payload.warnings || [];
    const orphanWarnings = warnings.filter((w) => /exists on disk but not in ROADMAP/i.test(w));
    assert.deepEqual(
      orphanWarnings,
      [],
      `shipped phase dirs (1-3) are in the full ROADMAP and must not be flagged as orphans. Got: ${JSON.stringify(orphanWarnings)}`
    );
  });

  test('validate health (W007) does not flag shipped phase dirs as not-in-ROADMAP', () => {
    // cmdValidateHealth's Check 8 has the same coupling: its W007 membership
    // check compared active disk phases against the active-milestone scope.
    // Shipped phase dirs in the active phases/ dir must be checked against the
    // FULL roadmap so they are not false W007 orphans. (#501)
    const result = runGsdTools(['validate', 'health'], tmpDir);
    const payload = JSON.parse(result.output);
    const warnings = payload.warnings || [];
    const w007Orphans = warnings.filter(
      (w) => w.code === 'W007' && /exists on disk but not in ROADMAP/i.test(w.message)
    );
    assert.deepEqual(
      w007Orphans,
      [],
      `shipped phase dirs (1-3) must not produce W007. Got: ${JSON.stringify(w007Orphans.map((w) => w.message))}`
    );
  });
});
