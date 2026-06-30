'use strict';
// Regression test for issue #1761 — `state sync` silently writes wrong progress
// when ROADMAP lacks versioned milestone headings.
//
// ADR-1769 Phase 7 fix: when getMilestonePhaseFilter().missingExplicitVersion is
// true (the current milestone cannot be bounded to a versioned phase set), the
// sync transition leaves Progress untouched (percent=null) rather than silently
// computing/writing values off a fallback milestone.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function buildStateWithProgress({ percent = 50 } = {}) {
  const barWidth = 10;
  const filled = Math.round((percent / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: Test',
    'current_phase: "3"',
    'status: executing',
    'progress:',
    '  total_phases: 10',
    '  completed_phases: 5',
    `  percent: ${percent}`,
    '---',
    '',
    '# GSD State',
    '',
    '**Current Phase:** 3',
    '**Total Plans in Phase:** 4',
    '**Current Plan:** 2',
    '**Status:** Executing Phase 3',
    '**Last Activity:** 2026-06-20',
    `**Progress:** [${bar}] ${percent}%`,
    '',
  ].join('\n');
}

// ROADMAP with an UNVERSIONED milestone heading (no vX.Y) — the #1761 trigger.
function buildUnversionedRoadmap(numPhases) {
  const lines = ['# ROADMAP', '', '## Milestone 1: Test Milestone', ''];
  for (let i = 1; i <= numPhases; i++) {
    lines.push(`### Phase ${i}: phase-${i}`);
    lines.push('');
  }
  return lines.join('\n');
}

function readBodyProgress(statePath) {
  const m = fs.readFileSync(statePath, 'utf-8').match(/\*\*Progress:\*\*\s*(.*)/);
  return m ? m[1].trim() : null;
}

describe('#1761: state sync leaves Progress untouched when milestone is unbounded', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('sync does NOT rewrite the Progress bar when ROADMAP lacks a versioned milestone heading', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithProgress({ percent: 50 }));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), buildUnversionedRoadmap(10));

    // Seed disk: 2 of 10 phases fully summarized → if sync naively recomputes,
    // it would write ~20%, clobbering the curated 50% (#1761).
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (let i = 1; i <= 2; i++) {
      const dir = path.join(phasesDir, String(i).padStart(2, '0'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(dir, '01-SUMMARY.md'), '# Summary\n');
    }

    const before = readBodyProgress(statePath);
    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);
    const after = readBodyProgress(statePath);

    assert.strictEqual(after, before,
      `Progress must be left untouched when the milestone is unbounded; before=${JSON.stringify(before)} after=${JSON.stringify(after)} (#1761)`);
  });
});

// #1761 read-path: the ADR-1769 Phase 7 fix (#1794) closed the `state sync`
// WRITE path, but `state json` (the READ path) rebuilds progress via
// buildStateFrontmatter, whose roadmapPhaseCount loop counts phase headings
// across the WHOLE document when extractCurrentMilestone can't bound the
// asserted milestone. Result: state json reported a conflated total_phases
// (sum of sibling milestones) + a derived percent, contradicting the sync
// guard. This block mirrors the write-path guard on the read path.
describe('#1761 read-path: state json does not conflate progress when milestone is unbounded', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('state json omits percent and does NOT report the conflated whole-doc total_phases', () => {
    // Repro from the issue: STATE.md asserts milestone: v2.0; ROADMAP has two
    // UNVERSIONED sibling milestones (4 + 4 phases) — neither matches v2.0, so
    // the milestone is unbounded. One summarized phase dir on disk.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v2.0',
      'milestone_name: Second',
      'current_phase: "2"',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '**Current Phase:** 2',
      '**Status:** Executing Phase 2',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# ROADMAP',
      '## Milestone 1: First Milestone',
      '### Phase 1: a',
      '### Phase 2: b',
      '### Phase 3: c',
      '### Phase 4: d',
      '## Milestone 2: Second Milestone',
      '### Phase 5: e',
      '### Phase 6: f',
      '### Phase 7: g',
      '### Phase 8: h',
      '',
    ].join('\n'));
    // One summarized phase dir on disk.
    const dir01 = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(dir01, { recursive: true });
    fs.writeFileSync(path.join(dir01, '01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(dir01, '01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state json --raw', tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const out = JSON.parse(result.output);

    // BEFORE the fix this printed progress.total_phases: 8 (4+4 sibling
    // milestones) and percent: 13 — exactly the conflated read-path the sync
    // guard was added to prevent.
    assert.ok(
      out.progress === undefined || out.progress.percent === undefined,
      `state json must omit percent when the milestone is unbounded; got progress=${JSON.stringify(out.progress)}`,
    );
    assert.ok(
      !(out.progress && out.progress.total_phases === 8),
      `state json must NOT report the conflated whole-doc total_phases (8 = 4+4 sibling milestones); got total_phases=${out.progress && out.progress.total_phases}`,
    );
  });

  test('state json still reports percent + total_phases when the milestone IS bounded (versioned ROADMAP)', () => {
    // Control: a versioned ROADMAP heading matching the asserted milestone
    // keeps the read path unchanged — the guard only fires when unbounded.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: First',
      'current_phase: "1"',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '**Current Phase:** 1',
      '**Status:** Executing Phase 1',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# ROADMAP',
      '## Milestone 1: First Milestone v1.0',
      '### Phase 1: a',
      '### Phase 2: b',
      '',
    ].join('\n'));
    const dir01 = path.join(tmpDir, '.planning', 'phases', '01');
    fs.mkdirSync(dir01, { recursive: true });
    fs.writeFileSync(path.join(dir01, '01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(dir01, '01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools('state json --raw', tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(
      out.progress && typeof out.progress.percent === 'number',
      `state json must report a numeric percent when the milestone is bounded; got progress=${JSON.stringify(out.progress)}`,
    );
    assert.strictEqual(
      out.progress.total_phases,
      2,
      'bounded read path must report the versioned milestone phase count (2)',
    );
  });
});
