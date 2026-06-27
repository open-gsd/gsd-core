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
