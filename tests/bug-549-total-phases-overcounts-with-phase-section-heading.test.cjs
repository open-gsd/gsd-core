'use strict';

/**
 * Regression test for bug #549:
 * STATE.md progress.total_phases is over-counted by 1 when the ROADMAP contains
 * a non-phase section heading that happens to match the broader pattern used by
 * getMilestonePhaseFilter (e.g. `## Phase Overview:`, `## Phase Details:`).
 *
 * Root cause:
 *   buildStateFrontmatter sources total_phases from getMilestonePhaseFilter.phaseCount,
 *   which uses the looser regex `#{2,4}\s*Phase\s+([\w][\w.-]*)\s*:` to build its
 *   milestonePhaseNums set.  That pattern matches section headings like
 *   `## Phase Overview:` and `## Phase Details:`, adding non-numeric tokens
 *   ("Overview", "Details") to the set and inflating phaseCount by 1 per heading.
 *
 *   roadmap.analyze uses the stricter pattern
 *   `#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)` which requires a
 *   leading digit, so it only counts real phase headings.
 *
 *   Fix: buildStateFrontmatter (and cmdStateSync) must source total_phases from
 *   the same digit-anchored phase-heading parser as roadmap.analyze — single
 *   source of truth.
 *
 * Scenario under test:
 *   ROADMAP with 6 integer phases (01-06) + 1 inserted decimal phase (05.1) = 7
 *   phases, plus a `## Phase Overview:` section header.
 *
 *   BEFORE fix: state json / state sync report total_phases: 8 (7 + 1 spurious
 *               "Overview" token from the getMilestonePhaseFilter pattern).
 *   AFTER fix:  state json / state sync report total_phases: 7, matching
 *               roadmap.analyze.phase_count.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ROADMAP: 6 integer phases + 1 inserted decimal + `## Phase Overview:` section header.
// The section header must include a trailing `:` so it matches the getMilestonePhaseFilter
// broader pattern (the bug trigger).
const ROADMAP = `## Milestone v1.0: Test Milestone

## Phase Overview:

High-level narrative about the phases.

### Phase 01: Alpha
**Goal:** alpha

### Phase 02: Beta
**Goal:** beta

### Phase 03: Gamma
**Goal:** gamma

### Phase 04: Delta
**Goal:** delta

### Phase 05: Epsilon
**Goal:** epsilon

### Phase 05.1: Inserted Hotfix (INSERTED)
**Goal:** inserted hotfix

### Phase 06: Zeta
**Goal:** zeta
`;

describe('bug #549 — total_phases over-counted by non-phase section headings', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('bug-549-');
    const planning = path.join(tmpDir, '.planning');

    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP, 'utf-8');
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'milestone_name: Test Milestone',
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        '## Configuration',
        'Current Phase: 1',
        'Status: Executing Phase 1',
        'Last Activity: 2026-01-01',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    // Create 7 phase dirs (6 integer + 1 decimal).
    const phaseDirs = [
      '01-alpha',
      '02-beta',
      '03-gamma',
      '04-delta',
      '05-epsilon',
      '05.1-inserted-hotfix',
      '06-zeta',
    ];
    for (const d of phaseDirs) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state json total_phases matches roadmap.analyze phase_count (7, not 8)', () => {
    // Authoritative count from roadmap.analyze — uses the digit-anchored pattern.
    const analyzeResult = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(analyzeResult.success, `roadmap analyze failed: ${analyzeResult.error}`);
    const analyzed = JSON.parse(analyzeResult.output);

    assert.equal(
      analyzed.phase_count,
      7,
      `roadmap.analyze should count 7 phases (01-06 + 05.1), got ${analyzed.phase_count}`,
    );

    // State frontmatter must equal the authoritative count.
    const stateResult = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(stateResult.success, `state json failed: ${stateResult.error}`);
    const state = JSON.parse(stateResult.output);

    assert.ok(state.progress, 'state json must return a progress block');
    assert.equal(
      state.progress.total_phases,
      7,
      `progress.total_phases must be 7 (not 8) — ## Phase Overview: section must not be counted as a phase. Got ${state.progress.total_phases}`,
    );
    assert.equal(
      state.progress.total_phases,
      analyzed.phase_count,
      `progress.total_phases (${state.progress.total_phases}) must equal roadmap.analyze.phase_count (${analyzed.phase_count})`,
    );
  });

  test('state sync total_phases matches roadmap.analyze phase_count', () => {
    // Add a Progress field to the body so cmdStateSync has something to update.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const before = fs.readFileSync(statePath, 'utf-8');
    fs.writeFileSync(statePath, before.replace('Last Activity: 2026-01-01', 'Last Activity: 2026-01-01\nProgress: [░░░░░░░░░░] 0%'), 'utf-8');

    const syncResult = runGsdTools(['state', 'sync'], tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    // Read frontmatter via state json (authoritative JSON path).
    const stateResult = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(stateResult.success, `state json after sync failed: ${stateResult.error}`);
    const state = JSON.parse(stateResult.output);

    assert.ok(state.progress, 'state json must return a progress block after sync');
    assert.equal(
      state.progress.total_phases,
      7,
      `state sync must write total_phases: 7, not 8. ## Phase Overview: must not inflate the count. Got ${state.progress.total_phases}`,
    );
  });

  test('integer-only project without decimal phase also counts correctly', () => {
    // Regression guard: the fix must not break projects with no decimal phases.
    const tmpDir2 = createTempProject('bug-549-integer-');
    try {
      const planning2 = path.join(tmpDir2, '.planning');

      // ROADMAP: 4 integer phases only + non-phase section heading.
      fs.writeFileSync(
        path.join(planning2, 'ROADMAP.md'),
        [
          '## Milestone v1.0: Simple',
          '',
          '## Phase Overview:',
          '',
          '### Phase 01: One',
          '**Goal:** one',
          '',
          '### Phase 02: Two',
          '**Goal:** two',
          '',
          '### Phase 03: Three',
          '**Goal:** three',
          '',
          '### Phase 04: Four',
          '**Goal:** four',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(planning2, 'STATE.md'),
        '---\ngsd_state_version: 1.0\nmilestone: v1.0\nstatus: executing\n---\n\n# State\n\nStatus: Executing Phase 1\nLast Activity: 2026-01-01\n',
        'utf-8',
      );
      fs.writeFileSync(path.join(planning2, 'config.json'), '{}', 'utf-8');

      for (const d of ['01-one', '02-two', '03-three', '04-four']) {
        const dir = path.join(planning2, '.planning', 'phases', d);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      }

      const analyzeResult = runGsdTools(['roadmap', 'analyze'], tmpDir2);
      assert.ok(analyzeResult.success, `roadmap analyze failed: ${analyzeResult.error}`);
      const analyzed = JSON.parse(analyzeResult.output);
      assert.equal(analyzed.phase_count, 4, `expected 4 phases, got ${analyzed.phase_count}`);

      const stateResult = runGsdTools(['state', 'json'], tmpDir2);
      assert.ok(stateResult.success, `state json failed: ${stateResult.error}`);
      const state = JSON.parse(stateResult.output);
      assert.ok(state.progress, 'state json must return a progress block');
      assert.equal(
        state.progress.total_phases,
        4,
        `integer-only project: total_phases must be 4, not 5. Got ${state.progress.total_phases}`,
      );
    } finally {
      cleanup(tmpDir2);
    }
  });
});
