/**
 * Bug #557: Active milestone wrapped in <details open> with version only in
 * <summary> tag + 🔄 emoji causes extractCurrentMilestone() to fall through
 * to stripShippedMilestones(), erasing the active block and making
 * roadmap.analyze return phase_count: 0 — which then triggers a premature
 * milestone_complete STATE write.
 *
 * Root cause (two miss paths in extractCurrentMilestone, core.cjs):
 * 1. sectionPattern only matches ##/### headings; version in <summary> not found.
 * 2. activeMarkerPattern does not include 🔄; only 🚧 is recognised.
 * Both misses → stripShippedMilestones() deletes the active <details open> block.
 *
 * This test will FAIL before the fix (phase_count returns 0) and PASS after.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Fixtures ────────────────────────────────────────────────────────────────

// ROADMAP where the active milestone's version ("v1.3") appears ONLY inside
// a <summary> tag, and the in-progress marker is 🔄 (not 🚧).
// Shipped milestone v1.2 is correctly collapsed in a <details> block.
const ROADMAP_DETAILS_SUMMARY = `# Roadmap

<details>
<summary>✅ v1.2: Foundation (shipped)</summary>

### Phase 1: Bootstrap
**Goal:** Set up infrastructure

### Phase 2: Core API
**Goal:** Build REST API

</details>

<details open>
<summary>🔄 v1.3: Active Sprint</summary>

### Phase 3: Auth
**Goal:** Add authentication

### Phase 4: Dashboard
**Goal:** Build dashboard UI

</details>
`;

// STATE.md with milestone: v1.3 — version matches the <summary> tag above
const STATE_V13 = `---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Active Sprint
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

Phase: 3 (Auth)
`;

// Second variant: active milestone uses the 🔄 emoji in a heading (not just
// <summary>) to confirm the activeMarkerPattern gap is also covered.
const ROADMAP_ROTATE_HEADING = `# Roadmap

<details>
<summary>✅ v2.0: Shipped (shipped)</summary>

### Phase 1: Old Phase
**Goal:** Done

</details>

## 🔄 v2.1: Active Milestone

### Phase 2: New Feature
**Goal:** Build the new feature

### Phase 3: Integration
**Goal:** Wire it all together
`;

const STATE_V21 = `---
gsd_state_version: 1.0
milestone: v2.1
milestone_name: Active Milestone
status: in_progress
---

# Project State

## Current Position

Phase: 2 (New Feature)
`;

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('bug #557 — <details>/<summary> active milestone strip', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Core repro: version only in <summary> tag ─────────────────────────────

  test('roadmap.analyze returns correct phase_count when active milestone uses <summary> + 🔄', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V13, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(result.success, `roadmap.analyze failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.phase_count >= 2,
      `Expected phase_count >= 2 (phases 3 and 4 of v1.3); got phase_count=${output.phase_count}. ` +
      `Bug: extractCurrentMilestone() stripped the active <details open> block because ` +
      `the version "v1.3" only appears in a <summary> tag and the emoji is 🔄, not 🚧.`
    );
  });

  test('roadmap.analyze does NOT return phase_count: 0 when active milestone is in <details open>', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V13, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(result.success, `roadmap.analyze failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.notStrictEqual(
      output.phase_count,
      0,
      'phase_count must not be 0 — a zero count caused by stripping the active block ' +
      'is the direct trigger for the premature milestone_complete write.'
    );
  });

  test('roadmap get-phase returns found:true for phase in active <details open> block', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V13, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['roadmap', 'get-phase', '3'], tmpDir);
    assert.ok(result.success, `roadmap get-phase failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.found,
      true,
      `Phase 3 must be found in the active v1.3 milestone block. ` +
      `Bug: stripShippedMilestones() erased the <details open> block so the phase section was lost.`
    );
  });

  test('shipped phases in collapsed <details> are NOT visible to roadmap.analyze (strip preserved for non-active)', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V13, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(result.success, `roadmap.analyze failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const phaseNums = (output.phases || []).map(p => p.number);
    assert.ok(
      !phaseNums.includes('1') && !phaseNums.includes('2'),
      `Shipped phases 1 and 2 (from collapsed <details>) must not appear in the analyze output. ` +
      `Got phases: ${JSON.stringify(phaseNums)}`
    );
  });

  // ── 🔄 in heading (not <summary>) also recognised ────────────────────────

  test('extractCurrentMilestone recognises 🔄 in milestone heading as in-progress marker', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_ROTATE_HEADING, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V21, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(result.success, `roadmap.analyze failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.phase_count >= 2,
      `Expected phase_count >= 2 for v2.1 with 🔄 heading; got ${output.phase_count}. ` +
      `activeMarkerPattern must include 🔄, not just 🚧.`
    );
  });

  // ── Health check W021: milestone_complete vs unstarted phases ─────────────

  test('validate health emits W021 when STATE says milestone complete but ROADMAP has unstarted phases', () => {
    const planning = path.join(tmpDir, '.planning');
    // ROADMAP still has active phases in it
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY, 'utf-8');
    // STATE falsely says milestone complete
    fs.writeFileSync(path.join(planning, 'STATE.md'), `---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Active Sprint
status: v1.3 milestone complete
---

# Project State

## Current Position

Phase: Milestone v1.3 complete
`, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['validate', 'health'], tmpDir);
    assert.ok(result.success, `validate health failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const warnings = output.warnings || [];
    const w021 = warnings.find(w => w.code === 'W021');
    assert.ok(
      w021 !== undefined,
      `Expected W021 warning (milestone-status vs. roadmap-progress incoherence). ` +
      `Got warnings: ${JSON.stringify(warnings.map(w => w.code))}`
    );
  });
});
