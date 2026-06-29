'use strict';
// Regression test for issue #1695 — `state patch` of an unrelated field clobbers
// the curated `current_phase_name` frontmatter scalar.
//
// Root cause: readModifyWriteStateMd({resync:false}) still runs syncStateFrontmatter,
// which re-derives EVERY body-derived scalar from body prose. The #1264 restore
// covers `progress` only and #1230 covers `status`/`stopped_at`; `current_phase_name`
// was left exposed, and parseProsePhaseField's paren-over-dash preference made the
// re-derived value wrong (harvesting a parenthetical aside as the phase name).
//
// ADR-1769 Phase 6 fix: extend the #1230 delta heuristic to current_phase_name
// (gated by the field-classification table's preserve-always row). When the
// transform did NOT change the body Current Phase / Phase source line, the curated
// frontmatter value wins.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

function buildStateWithCuratedPhaseName({ phaseName = 'Native Global Hotkey', aside = 'next; Phase 15 landed, UAT deferred' } = {}) {
  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: Test',
    'current_phase: "16"',
    `current_phase_name: "${phaseName}"`,
    'status: executing',
    'progress:',
    '  total_phases: 20',
    '  completed_phases: 15',
    '  total_plans: 40',
    '  completed_plans: 30',
    '  percent: 75',
    '---',
    '',
    '# GSD State',
    '',
    '## Configuration',
    'Current Phase: 16',
    'Total Plans in Phase: 4',
    'Current Plan: 2',
    'Status: Executing Phase 16',
    'Last Activity: 2026-06-20',
    '',
    '## Current Position',
    '',
    `Phase: 16 — ${phaseName} (${aside})`,
    'Plan: 2 of 4',
    'Status: Executing Phase 16',
    'Last activity: 2026-06-20 — mid-flight',
    '',
  ].join('\n');
}

function readFm(statePath) {
  return extractFrontmatter(fs.readFileSync(statePath, 'utf-8'));
}

describe('#1695: state patch of an unrelated field preserves curated current_phase_name', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('patching Status does NOT clobber the curated current_phase_name', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithCuratedPhaseName());

    const result = runGsdTools(['query', 'state.patch', JSON.stringify({ Status: 'Paused for review' })], tmpDir);
    assert.ok(result.success, `state patch failed: ${result.error}`);

    const fm = readFm(statePath);
    assert.strictEqual(
      fm.current_phase_name,
      'Native Global Hotkey',
      `current_phase_name must be preserved on an unrelated patch; got ${JSON.stringify(fm.current_phase_name)} (the paren-over-dash re-derivation clobbered it — #1695)`,
    );
  });

  test('patching Current Plan does NOT clobber the curated current_phase_name', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithCuratedPhaseName());

    const result = runGsdTools(['query', 'state.patch', JSON.stringify({ 'Current Plan': '3' })], tmpDir);
    assert.ok(result.success, `state patch failed: ${result.error}`);

    const fm = readFm(statePath);
    assert.strictEqual(fm.current_phase_name, 'Native Global Hotkey');
  });

  test('explicitly patching the body Phase name-source line still advances (delta does not over-pin)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateWithCuratedPhaseName());

    // Patching the body 'Phase' field (the parseProsePhaseField source for
    // current_phase_name) changes the source line, so the #1230 delta must NOT
    // fire — syncStateFrontmatter re-derives current_phase_name from the new line.
    // (Acceptance criterion from #1743: the guard must not pin a scalar whose body
    // source genuinely changed.)
    const result = runGsdTools(['query', 'state.patch', JSON.stringify({ Phase: '17 — Brand New Phase Name' })], tmpDir);
    assert.ok(result.success, `state patch failed: ${result.error}`);

    const fm = readFm(statePath);
    // current_phase_name should be re-derived from the new body 'Phase' line
    // (not pinned to the old curated value).
    assert.notStrictEqual(fm.current_phase_name, 'Native Global Hotkey',
      `current_phase_name must advance when the body Phase source changed; got ${JSON.stringify(fm.current_phase_name)}`);
  });
});
