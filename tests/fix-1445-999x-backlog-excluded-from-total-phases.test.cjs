'use strict';
/**
 * Regression test for bug #1445:
 * 999.x backlog phases must not be counted toward total_phases.
 *
 * Root cause:
 *   deriveProgressFromRoadmap (phase-lifecycle.cts) counted ALL data rows
 *   matching /^\|\s*\d+/ in the progress table, including 999.x backlog rows.
 *   Similarly, state.cts's roadmapPhaseCount loop (via extractCurrentMilestone)
 *   counted 999.x phase headings because it only checked /\d/.test(m[1]).
 *
 * Fix:
 *   Both sites now test /^999(?:\.|$)/.test(token) and skip matching rows.
 *   Mirrors the existing init.cts /^999(?:\.|$)/ filter.
 *
 * Scenarios:
 *   A. deriveProgressFromRoadmap with a progress table containing a 999.x row.
 *   B. state json total_phases via extractCurrentMilestone / roadmapPhaseCount.
 *
 * Follow-up #1580: the same `^999` (and Phase 0) sentinel exclusion was missing
 * in two more code paths — `milestone complete`'s unstarted-phase guard
 * (src/milestone.cts) and `roadmap analyze`'s next_phase routing + phase_count
 * (src/roadmap.cts). Scenarios C and D below cover those.
 *
 *   C. milestone complete is NOT blocked by a Phase 999 backlog heading.
 *   D. roadmap analyze never routes next_phase to 999 / never counts it.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { deriveProgressFromRoadmap } = require('../gsd-core/bin/lib/phase-lifecycle.cjs');

// ─── Scenario A: deriveProgressFromRoadmap unit test ────────────────────────

describe('bug #1445 — deriveProgressFromRoadmap excludes 999.x rows', () => {
  test('3 real phases + 1 999.x backlog row → total_phases: 3, not 4', () => {
    const roadmap = [
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
      '| 2. Beta | 1/2 | In Progress | |',
      '| 3. Gamma | 0/1 | Planned | |',
      '| 999.1 Backlog: Future Idea | 0/0 | Backlog | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(
      result.totalPhases,
      3,
      `total_phases must be 3 (not 4) — 999.1 backlog row must be excluded. Got ${result.totalPhases}`,
    );
    assert.equal(
      result.completedPhases,
      1,
      `completed_phases must be 1. Got ${result.completedPhases}`,
    );
  });

  test('999 exact (no dot) row is also excluded', () => {
    const roadmap = [
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 1/1 | Complete | ✅ |',
      '| 2. Beta | 1/1 | Complete | ✅ |',
      '| 999 Backlog | 0/0 | Backlog | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(
      result.totalPhases,
      2,
      `total_phases must be 2 (not 3) — 999 row must be excluded. Got ${result.totalPhases}`,
    );
    assert.equal(
      result.completedPhases,
      2,
      `completed_phases must be 2. Got ${result.completedPhases}`,
    );
  });

  test('all-backlog table yields null total_phases (no real phases)', () => {
    const roadmap = [
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 999.1 Future A | 0/0 | Backlog | |',
      '| 999.2 Future B | 0/0 | Backlog | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(
      result.totalPhases,
      null,
      `total_phases must be null when the only rows are 999.x backlog. Got ${result.totalPhases}`,
    );
  });
});

// ─── Scenario B: state json total_phases via roadmapPhaseCount ───────────────

describe('bug #1445 — state json excludes 999.x phase headings from total_phases', () => {
  let tmpDir;

  const ROADMAP = [
    '## Milestone v1.0: Test Milestone',
    '',
    '### Phase 01: Alpha',
    '**Goal:** first',
    '',
    '### Phase 02: Beta',
    '**Goal:** second',
    '',
    '### Phase 03: Gamma',
    '**Goal:** third',
    '',
    '### Phase 999.1: Backlog Item A',
    '**Goal:** future idea, not counted',
    '',
    '### Phase 999.2: Backlog Item B',
    '**Goal:** another future idea',
  ].join('\n');

  beforeEach(() => {
    tmpDir = createTempProject('bug-1445-');
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP, 'utf-8');
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'status: executing',
        '---',
        '',
        '# GSD State',
        '',
        '## Configuration',
        'Current Phase: 1',
        'Status: Executing Phase 1',
        'Last Activity: 2026-01-01',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    for (const d of ['01-alpha', '02-beta', '03-gamma']) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
    }
    // 999.x dirs should exist on disk but must not inflate total_phases
    for (const d of ['999.1-backlog-a', '999.2-backlog-b']) {
      fs.mkdirSync(path.join(planning, 'phases', d), { recursive: true });
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state json total_phases is 3, not 5 (999.x dirs and headings excluded)', () => {
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const state = JSON.parse(result.output);
    assert.ok(state.progress, 'state json must return a progress block');
    assert.equal(
      state.progress.total_phases,
      3,
      `total_phases must be 3 (not 5). 999.x backlog phases must be excluded. Got ${state.progress.total_phases}`,
    );
  });
});

// ─── Scenario C: milestone complete not blocked by a 999 backlog heading ─────

describe('fix #1580 — milestone complete ignores the 999 backlog sentinel', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('fix-1580-mc-');
    const planning = path.join(tmpDir, '.planning');
    // One real, on-disk phase + a directory-less Phase 999 backlog heading.
    fs.writeFileSync(
      path.join(planning, 'ROADMAP.md'),
      [
        '# Roadmap v1.0',
        '## v1.0 Milestone',
        '## Phases',
        '- [x] **Phase 1: Foundation**',
        '## Phase Details',
        '### Phase 1: Foundation',
        '**Goal:** build it',
        '### Phase 999: Backlog / Someday',
        '**Goal:** deferred, never executed',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      `---\nmilestone: v1.0\n---\n# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
      'utf-8',
    );
    const dir = path.join(planning, 'phases', '01-foundation');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('completes WITHOUT --force despite a Phase 999 backlog heading', () => {
    const result = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'Regression'],
      tmpDir,
    );
    assert.ok(
      result.success,
      `milestone complete must not be blocked by the 999 sentinel; got error: ${result.error}`,
    );
    assert.ok(
      !/Cannot mark milestone complete/.test(result.error || ''),
      `the unstarted-phase guard must not fire on Phase 999. Got: ${result.error}`,
    );
  });
});

// ─── Scenario D: roadmap analyze never routes/ counts the 999 sentinel ────────

describe('fix #1580 — roadmap analyze excludes the 999 backlog sentinel', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('fix-1580-ra-');
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(
      path.join(planning, 'ROADMAP.md'),
      [
        '# Roadmap v1.0',
        '## v1.0 Milestone',
        '## Phases',
        '- [x] **Phase 1: Foundation**',
        '## Phase Details',
        '### Phase 1: Foundation',
        '**Goal:** build it',
        '### Phase 999: Backlog / Someday',
        '**Goal:** deferred, never executed',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      `---\nmilestone: v1.0\n---\n# State\n`,
      'utf-8',
    );
    const dir = path.join(planning, 'phases', '01-foundation');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('next_phase is never 999 and phase_count excludes the sentinel', () => {
    const result = runGsdTools(['roadmap', 'analyze', '--raw'], tmpDir);
    assert.ok(result.success, `roadmap analyze failed: ${result.error}`);
    const analysis = JSON.parse(result.output);
    assert.notEqual(
      String(analysis.next_phase),
      '999',
      `next_phase must never route to the 999 backlog sentinel. Got ${analysis.next_phase}`,
    );
    assert.equal(
      analysis.phase_count,
      1,
      `phase_count must exclude the 999 sentinel (expected 1). Got ${analysis.phase_count}`,
    );
    assert.ok(
      !(analysis.phases || []).some(p => String(p.number) === '999'),
      'the phases array must not include the 999 backlog sentinel',
    );
  });
});
