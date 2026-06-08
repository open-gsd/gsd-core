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
const fc = require('./helpers/fast-check-setup.cjs');
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

const ROADMAP_DETAILS_SUMMARY_WITH_FLAT_PHASE_DETAILS = `# Roadmap: mcp-server-health-connect

## Milestones

- [x] **v1.0 v1 Analytics** — Phases 1-7 shipped 2026-05-06.
- [ ] **v1.1 Samsung Health 0-to-1** — Phases 8-11 planned 2026-06-05.

<details>
<summary>v1.0 v1 Analytics (Phases 1-7) — SHIPPED 2026-05-06</summary>

- [x] **Phase 1: Storage Decision and Skeleton** — complete.
- [x] **Phase 2: Source Inspection and Canonical Schema** — complete.

</details>

<details open>
<summary>v1.1 Samsung Health 0-to-1 (Phases 8-11) — PLANNED</summary>

- [x] **Phase 8: Lakehouse Direction and Samsung Source Metadata**
- [ ] **Phase 9: Samsung Raw Import and Provenance**
- [ ] **Phase 10: Strava-Informed Metric Registry and High-Value Read Models**
- [ ] **Phase 11: Agent Data Access and End-to-End Validation**

</details>

## Phase Details

### Phase 8: Lakehouse Direction and Samsung Source Metadata
**Goal**: Reframe the project as a personal health lakehouse.
**Requirements**: SAMSUNG-01

### Phase 9: Samsung Raw Import and Provenance
**Goal**: Import Samsung Health archive contents into DuckDB cumulatively and idempotently while preserving source provenance and avoiding per-archive snapshots.
**Requirements**: SAMSUNG-02, SAMSUNG-03, SAMSUNG-04, SAMSUNG-05, LAKE-01, LAKE-02
**Success Criteria** (what must be TRUE):
  1. A Samsung Health archive import creates source-layer DuckDB tables.

### Phase 10: Strava-Informed Metric Registry and High-Value Read Models
**Goal**: Reuse proven DuckDB and metric-registry decisions.
**Requirements**: METRIC-01

### Phase 11: Agent Data Access and End-to-End Validation
**Goal**: Expose a small ordered-data surface over the local lakehouse.
**Requirements**: DATA-01

## Backlog

### Phase 999.1: Automatic strong correlation discovery (BACKLOG)
**Goal**: Future backlog item.
`;

const ROADMAP_DETAILS_SUMMARY_WITH_FENCED_PHASE_EXAMPLE = `# Roadmap: fenced example

<details open>
<summary>v1.1 Current (Phases 8-9) - PLANNED</summary>

- [ ] **Phase 9: Real Phase**

</details>

## Phase Details

\`\`\`markdown
### Phase 9: Fenced Example Phase
**Goal**: This example must not be treated as roadmap structure.
\`\`\`

### Phase 9: Real Phase
**Goal**: Use the real phase details outside the fenced block.
**Requirements**: REAL-01
`;

const STATE_V11 = `---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Samsung Health 0-to-1
status: planning
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 3
  completed_plans: 3
  percent: 25
---

# Project State

## Current Position

Phase: 09 - Samsung Raw Import and Provenance
Plan: Not started
Status: Ready for planning
`;

function buildPropertyRoadmap(activeNums, extraNums) {
  const activeChecklist = activeNums
    .map((num) => `- [ ] **Phase ${num}: Active ${num}**`)
    .join('\n');
  const activeDetails = activeNums
    .map((num) => `### Phase ${num}: Active ${num}\n**Goal**: Active ${num}.`)
    .join('\n\n');
  const extraDetails = extraNums
    .map((num) => `### Phase ${num}: Extra ${num}\n**Goal**: Extra ${num}.`)
    .join('\n\n');

  return `# Roadmap

<details open>
<summary>v1.1 Current</summary>

${activeChecklist}

</details>

## Phase Details

${activeDetails}

## Backlog

${extraDetails}
`;
}

function phaseHeadingNames(content) {
  return [...content.matchAll(/^#{2,4}\s*Phase\s+(\d+):\s*([^\n]+)/gmi)]
    .map((match) => `${match[1]}:${match[2].trim()}`);
}

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

  test('init plan-phase finds active details phases whose sections live in flat Phase Details', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY_WITH_FLAT_PHASE_DETAILS, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V11, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['init', 'plan-phase', '9'], tmpDir);
    assert.ok(result.success, `init plan-phase failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'Phase 9 must be found from flat Phase Details');
    assert.strictEqual(output.phase_number, '9');
    assert.strictEqual(output.phase_name, 'Samsung Raw Import and Provenance');
    assert.strictEqual(output.phase_req_ids, 'SAMSUNG-02, SAMSUNG-03, SAMSUNG-04, SAMSUNG-05, LAKE-01, LAKE-02');
  });

  test('init plan-phase ignores fenced phase-like headings when appending flat Phase Details', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY_WITH_FENCED_PHASE_EXAMPLE, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V11, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['init', 'plan-phase', '9'], tmpDir);
    assert.ok(result.success, `init plan-phase failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'Phase 9 must be found from the real heading');
    assert.strictEqual(output.phase_name, 'Real Phase');
    assert.strictEqual(output.phase_req_ids, 'REAL-01');
  });

  test('init plan-phase does not treat unreferenced backlog phases as active details phases', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY_WITH_FLAT_PHASE_DETAILS, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V11, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    const result = runGsdTools(['init', 'plan-phase', '999.1'], tmpDir);
    assert.ok(result.success, `init plan-phase failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false, 'Backlog phase 999.1 must not be active for v1.1');
  });

  test('property: appended flat detail phases are exactly active references and idempotent', () => {
    const core = require('../gsd-core/bin/lib/core.cjs');
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'STATE.md'), '---\nmilestone: v1.1\n---\n', 'utf-8');

    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 8 }),
        fc.uniqueArray(fc.integer({ min: 31, max: 60 }), { minLength: 1, maxLength: 8 }),
        (activeNums, extraNums) => {
          const roadmap = buildPropertyRoadmap(activeNums, extraNums);
          const scoped = core.extractCurrentMilestone(roadmap, tmpDir);
          const scopedAgain = core.extractCurrentMilestone(scoped, tmpDir);
          const headings = phaseHeadingNames(scoped);

          assert.deepStrictEqual(scopedAgain, scoped, 'phase detail appending must be idempotent');

          for (const num of activeNums) {
            assert.ok(
              headings.includes(`${num}:Active ${num}`),
              `active phase ${num} must be present in scoped milestone`,
            );
          }

          for (const num of extraNums) {
            assert.ok(
              !headings.includes(`${num}:Extra ${num}`),
              `extra phase ${num} must not be appended into scoped milestone`,
            );
          }
        },
      ),
    );
  });

  test('init progress scopes disk and roadmap phases to active details summary references', () => {
    const planning = path.join(tmpDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), ROADMAP_DETAILS_SUMMARY_WITH_FLAT_PHASE_DETAILS, 'utf-8');
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_V11, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');

    for (const dir of ['01-old', '02-old', '08-lakehouse-direction']) {
      const phaseDir = path.join(planning, 'phases', dir);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${dir.slice(0, 2)}-01-PLAN.md`), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(phaseDir, `${dir.slice(0, 2)}-01-SUMMARY.md`), '# Summary\n', 'utf-8');
    }

    const result = runGsdTools(['init', 'progress'], tmpDir);
    assert.ok(result.success, `init progress failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const phaseNums = (output.phases || []).map(p => String(p.number).replace(/^0+/, '') || '0');
    assert.deepStrictEqual(
      phaseNums,
      ['8', '9', '10', '11'],
      `active v1.1 scope must include only phases 8-11, got ${JSON.stringify(phaseNums)}`
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
