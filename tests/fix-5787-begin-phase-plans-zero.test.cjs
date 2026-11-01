'use strict';

// #5787: `state begin-phase --plans 0` must record the plan total as 0, not as the
// unknown placeholder `?`. `intent.planCount || '?'` treated 0 as falsy.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');

const STATE_FIXTURE = [
  '# Project State',
  '',
  '## Current Position',
  '',
  'Phase: 3 (x) — PLANNED',
  'Plan: 0 of 0',
  'Status: Planned',
  '',
].join('\n');

function beginPhaseWithPlans(plansArgs) {
  const tmpDir = createTempProject('gsd-5787-');
  const statePath = path.join(tmpDir, '.planning', 'STATE.md');
  fs.writeFileSync(statePath, STATE_FIXTURE, 'utf-8');
  const result = runGsdTools(`state begin-phase --phase 3 --name x${plansArgs}`, tmpDir);
  const planField = stateExtractField(fs.readFileSync(statePath, 'utf-8'), 'Plan');
  return { result, planField, tmpDir };
}

describe('#5787 state begin-phase plan total', () => {
  test('--plans 0 records a plan total of 0, not the unknown placeholder', (t) => {
    const { result, planField, tmpDir } = beginPhaseWithPlans(' --plans 0');
    t.after(() => cleanup(tmpDir));
    assert.equal(result.success, true, `begin-phase should succeed: ${result.error}`);
    assert.equal(planField, '1 of 0');
  });

  test('--plans 4 records the given plan total (positive control)', (t) => {
    const { result, planField, tmpDir } = beginPhaseWithPlans(' --plans 4');
    t.after(() => cleanup(tmpDir));
    assert.equal(result.success, true, `begin-phase should succeed: ${result.error}`);
    assert.equal(planField, '1 of 4');
  });

  test('no --plans still records the unknown placeholder', (t) => {
    const { result, planField, tmpDir } = beginPhaseWithPlans('');
    t.after(() => cleanup(tmpDir));
    assert.equal(result.success, true, `begin-phase should succeed: ${result.error}`);
    assert.equal(planField, '1 of ?');
  });
});
