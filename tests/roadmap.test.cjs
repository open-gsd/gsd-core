// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests - Roadmap
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('roadmap get-phase command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts phase section from ROADMAP.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phases

### Phase 1: Foundation
**Goal:** Set up project infrastructure
**Plans:** 2 plans

Some description here.

### Phase 2: API
**Goal:** Build REST API
**Plans:** 3 plans
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.strictEqual(output.phase_number, '1', 'phase number correct');
    assert.strictEqual(output.phase_name, 'Foundation', 'phase name extracted');
    assert.strictEqual(output.goal, 'Set up project infrastructure', 'goal extracted');
  });

  test('returns not found for missing phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Set up project
`
    );

    const result = runGsdTools('roadmap get-phase 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'phase should not be found');
  });

  test('handles decimal phase numbers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 2: Main
**Goal:** Main work

### Phase 2.1: Hotfix
**Goal:** Emergency fix
`
    );

    const result = runGsdTools('roadmap get-phase 2.1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'decimal phase should be found');
    assert.strictEqual(output.phase_name, 'Hotfix', 'phase name correct');
    assert.strictEqual(output.goal, 'Emergency fix', 'goal extracted');
  });

  test('extracts full section content', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Setup
**Goal:** Initialize everything

This phase covers:
- Database setup
- Auth configuration
- CI/CD pipeline

### Phase 2: Build
**Goal:** Build features
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.section.includes('Database setup'), 'section includes description');
    assert.ok(output.section.includes('CI/CD pipeline'), 'section includes all bullets');
    assert.ok(!output.section.includes('Phase 2'), 'section does not include next phase');
  });

  test('handles missing ROADMAP.md gracefully', () => {
    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'should return not found');
    assert.strictEqual(output.error, 'ROADMAP.md not found', 'should explain why');
  });

  test('accepts ## phase headers (two hashes)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phase 1: Foundation
**Goal:** Set up project infrastructure
**Plans:** 2 plans

## Phase 2: API
**Goal:** Build REST API
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase with ## header should be found');
    assert.strictEqual(output.phase_name, 'Foundation', 'phase name extracted');
    assert.strictEqual(output.goal, 'Set up project infrastructure', 'goal extracted');
  });

  test('extracts goal when colon is outside bold (**Goal**: format)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.24

### Phase 5: Skill Scaffolding
**Goal**: The autonomous skill files exist following project conventions
**Plans:** 2 plans

### Phase 6: Smart Discuss
**Goal**: Grey area resolution works with proposals
`
    );

    const result = runGsdTools('roadmap get-phase 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.strictEqual(output.goal, 'The autonomous skill files exist following project conventions', 'goal extracted with colon outside bold');
  });

  test('extracts goal for both colon-inside and colon-outside bold formats', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Alpha
**Goal:** Colon inside bold format

### Phase 2: Beta
**Goal**: Colon outside bold format
`
    );

    const result1 = runGsdTools('roadmap get-phase 1', tmpDir);
    const output1 = JSON.parse(result1.output);
    assert.strictEqual(output1.goal, 'Colon inside bold format', 'colon-inside-bold goal extracted');

    const result2 = runGsdTools('roadmap get-phase 2', tmpDir);
    const output2 = JSON.parse(result2.output);
    assert.strictEqual(output2.goal, 'Colon outside bold format', 'colon-outside-bold goal extracted');
  });

  test('detects malformed ROADMAP with summary list but no detail sections', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phases

- [ ] **Phase 1: Foundation** - Set up project
- [ ] **Phase 2: API** - Build REST API
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'phase should not be found');
    assert.strictEqual(output.error, 'malformed_roadmap', 'should identify malformed roadmap');
    assert.ok(output.message.includes('missing'), 'should explain the issue');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase next-decimal command
// ─────────────────────────────────────────────────────────────────────────────


describe('roadmap analyze command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing ROADMAP.md returns error', () => {
    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'ROADMAP.md not found');
  });

  test('parses phases with goals and disk status', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Set up infrastructure

### Phase 2: Authentication
**Goal:** Add user auth

### Phase 3: Features
**Goal:** Build core features
`
    );

    // Create phase dirs with varying completion
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const p2 = path.join(tmpDir, '.planning', 'phases', '02-authentication');
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p2, '02-01-PLAN.md'), '# Plan');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 3, 'should find 3 phases');
    assert.strictEqual(output.phases[0].disk_status, 'complete', 'phase 1 complete');
    assert.strictEqual(output.phases[1].disk_status, 'planned', 'phase 2 planned');
    assert.strictEqual(output.phases[2].disk_status, 'no_directory', 'phase 3 no directory');
    assert.strictEqual(output.completed_phases, 1, '1 phase complete');
    assert.strictEqual(output.total_plans, 2, '2 total plans');
    assert.strictEqual(output.total_summaries, 1, '1 total summary');
    assert.strictEqual(output.progress_percent, 50, '50% complete');
    assert.strictEqual(output.current_phase, '2', 'current phase is 2');
  });

  test('extracts goals and dependencies', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Setup
**Goal:** Initialize project
**Depends on:** Nothing

### Phase 2: Build
**Goal:** Build features
**Depends on:** Phase 1
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].goal, 'Initialize project');
    assert.strictEqual(output.phases[0].depends_on, 'Nothing');
    assert.strictEqual(output.phases[1].goal, 'Build features');
    assert.strictEqual(output.phases[1].depends_on, 'Phase 1');
  });

  test('extracts goals and depends_on with colon outside bold (**Goal**: format)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.24

### Phase 5: Skill Scaffolding
**Goal**: The autonomous skill files exist following project conventions
**Depends on**: Phase 4 (v1.23 complete)

### Phase 6: Smart Discuss
**Goal**: Grey area resolution works with proposals
**Depends on**: Phase 5
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].goal, 'The autonomous skill files exist following project conventions', 'goal extracted with colon outside bold');
    assert.strictEqual(output.phases[0].depends_on, 'Phase 4 (v1.23 complete)', 'depends_on extracted with colon outside bold');
    assert.strictEqual(output.phases[1].goal, 'Grey area resolution works with proposals', 'second phase goal extracted');
    assert.strictEqual(output.phases[1].depends_on, 'Phase 5', 'second phase depends_on extracted');
  });

  test('handles mixed colon-inside and colon-outside bold formats in analyze', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Alpha
**Goal:** Colon inside bold
**Depends on:** Nothing

### Phase 2: Beta
**Goal**: Colon outside bold
**Depends on**: Phase 1
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].goal, 'Colon inside bold', 'colon-inside goal works');
    assert.strictEqual(output.phases[0].depends_on, 'Nothing', 'colon-inside depends_on works');
    assert.strictEqual(output.phases[1].goal, 'Colon outside bold', 'colon-outside goal works');
    assert.strictEqual(output.phases[1].depends_on, 'Phase 1', 'colon-outside depends_on works');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze disk status variants
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze disk status variants', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns researched status for phase dir with only RESEARCH.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Exploration
**Goal:** Research the domain
`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-exploration');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-RESEARCH.md'), '# Research notes');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].disk_status, 'researched', 'disk_status should be researched');
    assert.strictEqual(output.phases[0].has_research, true, 'has_research should be true');
  });

  test('returns discussed status for phase dir with only CONTEXT.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Discussion
**Goal:** Gather context
`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-discussion');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-CONTEXT.md'), '# Context notes');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].disk_status, 'discussed', 'disk_status should be discussed');
    assert.strictEqual(output.phases[0].has_context, true, 'has_context should be true');
  });

  test('returns empty status for phase dir with no recognized files', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Empty
**Goal:** Nothing yet
`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-empty');
    fs.mkdirSync(p1, { recursive: true });

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].disk_status, 'empty', 'disk_status should be empty');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze milestone extraction
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze milestone extraction', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts milestone headings and version numbers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## v1.0 Test Infrastructure

### Phase 1: Foundation
**Goal:** Set up base

## v1.1 Coverage Hardening

### Phase 2: Coverage
**Goal:** Add coverage
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.milestones), 'milestones should be an array');
    assert.strictEqual(output.milestones.length, 2, 'should find 2 milestones');
    assert.strictEqual(output.milestones[0].version, 'v1.0', 'first milestone version');
    assert.ok(output.milestones[0].heading.includes('v1.0'), 'first milestone heading contains v1.0');
    assert.strictEqual(output.milestones[1].version, 'v1.1', 'second milestone version');
    assert.ok(output.milestones[1].heading.includes('v1.1'), 'second milestone heading contains v1.1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze missing phase details
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze missing phase details', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('detects checklist-only phases missing detail sections', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Foundation** - Set up project
- [ ] **Phase 2: API** - Build REST API

### Phase 2: API
**Goal:** Build REST API
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.missing_phase_details), 'missing_phase_details should be an array');
    assert.ok(output.missing_phase_details.includes('1'), 'phase 1 should be in missing details');
    assert.ok(!output.missing_phase_details.includes('2'), 'phase 2 should not be in missing details');
  });

  test('returns null when all checklist phases have detail sections', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Foundation** - Set up project
- [ ] **Phase 2: API** - Build REST API

### Phase 1: Foundation
**Goal:** Set up project

### Phase 2: API
**Goal:** Build REST API
`
    );

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.missing_phase_details, null, 'missing_phase_details should be null');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap get-phase success criteria
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap get-phase success criteria', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts success_criteria array from phase section', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
**Success Criteria** (what must be TRUE):
  1. First criterion
  2. Second criterion
  3. Third criterion

### Phase 2: Other
**Goal:** Other goal
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.ok(Array.isArray(output.success_criteria), 'success_criteria should be an array');
    assert.strictEqual(output.success_criteria.length, 3, 'should have 3 criteria');
    assert.ok(output.success_criteria[0].includes('First criterion'), 'first criterion matches');
    assert.ok(output.success_criteria[1].includes('Second criterion'), 'second criterion matches');
    assert.ok(output.success_criteria[2].includes('Third criterion'), 'third criterion matches');
  });

  test('returns empty array when no success criteria present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Simple
**Goal:** No criteria here
`
    );

    const result = runGsdTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.ok(Array.isArray(output.success_criteria), 'success_criteria should be an array');
    assert.strictEqual(output.success_criteria.length, 0, 'should have empty criteria');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap update-plan-progress command
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap update-plan-progress command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing phase number returns error', () => {
    const result = runGsdTools('roadmap update-plan-progress', tmpDir);
    assert.strictEqual(result.success, false, 'should fail without phase number');
    assert.ok(result.error.includes('phase number required'), 'error should mention phase number required');
  });

  test('nonexistent phase returns error', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
`
    );

    const result = runGsdTools('roadmap update-plan-progress 99', tmpDir);
    assert.strictEqual(result.success, false, 'should fail for nonexistent phase');
    assert.ok(result.error.includes('not found'), 'error should mention not found');
  });

  test('no plans found returns updated false', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
`
    );

    // Create phase dir with only a context file (no plans)
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-CONTEXT.md'), '# Context');

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'should not update');
    assert.ok(output.reason.includes('No plans'), 'reason should mention no plans');
    assert.strictEqual(output.plan_count, 0, 'plan_count should be 0');
  });

  test('updates progress for partial completion', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
**Plans:** TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Test | v1.0 | 0/2 | Planned | - |
`
    );

    // Create phase dir with 2 plans, 1 summary
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-02-PLAN.md'), '# Plan 2');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'should update');
    assert.strictEqual(output.plan_count, 2, 'plan_count should be 2');
    assert.strictEqual(output.summary_count, 1, 'summary_count should be 1');
    assert.strictEqual(output.status, 'In Progress', 'status should be In Progress');
    assert.strictEqual(output.complete, false, 'should not be complete');

    // Verify file was actually modified
    const roadmapContent = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmapContent.includes('1/2'), 'roadmap should contain updated plan count');
  });

  test('counts plans and summaries from plans/ subdirectory layout (#3053)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Test
**Goal:** Test goal
`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test', 'plans');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, 'PLAN-01.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, 'PLAN-02.md'), '# Plan 2');
    fs.writeFileSync(path.join(p1, 'SUMMARY-01.md'), '# Summary 1');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].plan_count, 2);
    assert.strictEqual(output.phases[0].summary_count, 1);
    assert.strictEqual(output.phases[0].disk_status, 'partial');
  });

  test('updates progress and checks checkbox on completion', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Test** - description

### Phase 1: Test
**Goal:** Test goal
**Plans:** TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Test | v1.0 | 0/1 | Planned | - |
`
    );

    // Create phase dir with 1 plan, 1 summary (complete)
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true, 'should update');
    assert.strictEqual(output.complete, true, 'should be complete');
    assert.strictEqual(output.status, 'Complete', 'status should be Complete');

    // Verify file was actually modified
    const roadmapContent = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmapContent.includes('[x]'), 'checkbox should be checked');
    assert.ok(roadmapContent.includes('completed'), 'should contain completion date text');
    assert.ok(roadmapContent.includes('1/1'), 'roadmap should contain updated plan count');
  });

  test('updates unpadded ROADMAP phase entries when called with padded phase argument', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 3: Build** - description

### Phase 3: Build
**Goal:** Test goal
**Plans:** 0 plans
- [ ] 03-01-PLAN.md

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 3. Build | 0/1 | Planned |  |
`
    );

    const p3 = path.join(tmpDir, '.planning', 'phases', '03-build');
    fs.mkdirSync(p3, { recursive: true });
    fs.writeFileSync(path.join(p3, '03-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p3, '03-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmapContent = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.match(roadmapContent, /- \[x\] \*\*Phase 3: Build\*\* - description \(completed \d{4}-\d{2}-\d{2}\)/);
    assert.ok(roadmapContent.includes('**Plans:** 1/1 plans complete'), 'phase detail plan count should be updated');
    assert.match(roadmapContent, /\| 3\. Build \| 1\/1 \| Complete\s+\| \d{4}-\d{2}-\d{2} \|/);
    assert.ok(roadmapContent.includes('- [x] 03-01-PLAN.md'), 'completed plan checkbox should still be marked');
  });

  test('missing ROADMAP.md returns updated false', () => {
    // Create phase dir with plans and summaries but NO ROADMAP.md
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, false, 'should not update');
    assert.ok(output.reason.includes('ROADMAP.md not found'), 'reason should mention missing ROADMAP.md');
  });

  test('marks completed plan checkboxes', () => {
    const roadmapContent = `# Roadmap

- [ ] Phase 50: Build
  - [ ] 50-01-PLAN.md
  - [ ] 50-02-PLAN.md

### Phase 50: Build
**Goal:** Build stuff
**Plans:** 2 plans

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 50. Build | 0/2 | Planned |  |
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapContent);

    const p50 = path.join(tmpDir, '.planning', 'phases', '50-build');
    fs.mkdirSync(p50, { recursive: true });
    fs.writeFileSync(path.join(p50, '50-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(p50, '50-02-PLAN.md'), '# Plan 2');
    // Only plan 1 has a summary (completed)
    fs.writeFileSync(path.join(p50, '50-01-SUMMARY.md'), '# Summary 1');

    const result = runGsdTools('roadmap update-plan-progress 50', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('[x] 50-01-PLAN.md') || roadmap.includes('[x] 50-01'),
      'completed plan checkbox should be marked');
    assert.ok(roadmap.includes('[ ] 50-02-PLAN.md') || roadmap.includes('[ ] 50-02'),
      'incomplete plan checkbox should remain unchecked');
  });

  test('preserves Milestone column in 5-column progress table', () => {
    const roadmapContent = `# Roadmap

### Phase 50: Build
**Goal:** Build stuff
**Plans:** 1 plans

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 50. Build | v2.0 | 0/1 | Planned |  |
`;
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapContent);

    const p50 = path.join(tmpDir, '.planning', 'phases', '50-build');
    fs.mkdirSync(p50, { recursive: true });
    fs.writeFileSync(path.join(p50, '50-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p50, '50-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('roadmap update-plan-progress 50', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const rowMatch = roadmap.match(/^\|[^\n]*50\. Build[^\n]*$/m);
    assert.ok(rowMatch, 'table row should exist');
    const cells = rowMatch[0].split('|').slice(1, -1).map(c => c.trim());
    assert.strictEqual(cells.length, 5, 'should have 5 columns');
    assert.strictEqual(cells[1], 'v2.0', 'Milestone column should be preserved');
    assert.ok(cells[3].includes('Complete'), 'Status column should show Complete');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase add command
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// regressions: insert missing plan rows (#1163)
// ─────────────────────────────────────────────────────────────────────────────

// Phase numbers are zero-padded by normalizePhaseName so the .planning/phases/
// directory must use the padded form (e.g. "05-test-phase" for phase 5).
const PHASE_NUM_1163 = '5';       // what we pass on the command line
const PHASE_DIR_SLUG_1163 = '05'; // what ends up on disk after normalization

/**
 * ROADMAP.md with a phase-5 detail section that uses bold **Plans:** and has
 * NO per-plan checkbox rows yet.
 */
function buildRoadmapBoldPlans(phaseNum = PHASE_NUM_1163, planCount = '0/3 plans executed') {
  return [
    '# ROADMAP',
    '',
    '## Milestone v1.0',
    '',
    '| Phase | Plans | Status | Completed |',
    '| --- | --- | --- | --- |',
    `| Phase ${phaseNum}: test phase | 0/3 | Planned      |   |`,
    '',
    `### Phase ${phaseNum}: test phase`,
    '',
    'Goal: build something',
    '',
    `**Plans:** ${planCount}`,
    '',
    '(No individual plan rows yet — template freshly generated)',
    '',
  ].join('\n');
}

/**
 * ROADMAP.md using the CANONICAL template shape:
 *   **Plans**: N plans       ← bold summary metadata line
 *   (blank line)
 *   Plans:                   ← checklist header
 *   - [ ] NN-XX-PLAN.md      ← per-plan checkboxes
 *
 * The template (gsd-core/templates/roadmap.md) always uses this two-line form.
 * `**Plans**:` has the colon OUTSIDE the bold markers.
 */
function buildRoadmapCanonicalTemplate(phaseNum = PHASE_NUM_1163, existingRows = []) {
  const rowLines = existingRows.length > 0
    ? ['Plans:', ...existingRows.map(r => `- [ ] ${r}`), '']
    : ['Plans:', ''];
  return [
    '# ROADMAP',
    '',
    '## Milestone v1.0',
    '',
    '| Phase | Plans | Status | Completed |',
    '| --- | --- | --- | --- |',
    `| Phase ${phaseNum}: test phase | 0/3 | Planned      |   |`,
    '',
    `### Phase ${phaseNum}: test phase`,
    '',
    '**Goal**: build something',
    `**Plans**: 0/3 plans`,
    '',
    ...rowLines,
  ].join('\n');
}

/**
 * ROADMAP.md with a duplicate phase heading in an archived <details> section
 * plus the same phase as the ACTIVE milestone section.
 */
function buildRoadmapWithArchivedDuplicate(phaseNum = PHASE_NUM_1163) {
  return [
    '# ROADMAP',
    '',
    '<details>',
    '<summary>v0.9 — shipped</summary>',
    '',
    `### Phase ${phaseNum}: test phase`,
    '',
    '**Plans**: 2/2 plans complete',
    '',
    'Plans:',
    `- [x] ${phaseNum}-01-PLAN.md`,
    `- [x] ${phaseNum}-02-PLAN.md`,
    '',
    '</details>',
    '',
    '## Milestone v1.0',
    '',
    `### Phase ${phaseNum}: test phase`,
    '',
    '**Plans**: 0/3 plans',
    '',
    'Plans:',
    '',
  ].join('\n');
}

/**
 * ROADMAP.md with a phase-5 detail section that uses plain `Plans:` (not bold)
 * and NO per-plan checkbox rows yet.
 */
function buildRoadmapPlainPlans(phaseNum = PHASE_NUM_1163) {
  return [
    '# ROADMAP',
    '',
    '## Milestone v1.0',
    '',
    '| Phase | Plans | Status | Completed |',
    '| --- | --- | --- | --- |',
    `| Phase ${phaseNum}: test phase | 0/3 | Planned      |   |`,
    '',
    `### Phase ${phaseNum}: test phase`,
    '',
    'Goal: build something',
    '',
    `Plans: 0/3 plans executed`,
    '',
    '(No individual plan rows yet)',
    '',
  ].join('\n');
}

/**
 * Create plan files for a given phase in the .planning/phases tree.
 * Uses the normalized (zero-padded) directory name so findPhaseInternal can
 * locate the phase.  Returns the phase directory path.
 */
function createPhaseWithPlans(tmpDir, phaseNum, planNames) {
  // normalizePhaseName('5') → '05', so use zero-padded slug on disk
  const paddedNum = String(phaseNum).padStart(2, '0');
  const phaseDir = path.join(tmpDir, '.planning', 'phases', `${paddedNum}-test-phase`);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const name of planNames) {
    fs.writeFileSync(path.join(phaseDir, name), `# ${name}\n`);
  }
  return phaseDir;
}

describe('regressions: insert missing plan rows (#1163)', () => {
  let tmpDir;
  let roadmapPath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1163-');
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Bold **Plans:** — insert missing rows ────────────────────────────────

  test('inserts plan checkbox rows under bold **Plans:** when none exist', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapBoldPlans('5'));
    createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
      '5-03-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true');

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(written.includes('- [ ] 5-01-PLAN.md'), '5-01-PLAN.md row not inserted');
    assert.ok(written.includes('- [ ] 5-02-PLAN.md'), '5-02-PLAN.md row not inserted');
    assert.ok(written.includes('- [ ] 5-03-PLAN.md'), '5-03-PLAN.md row not inserted');
  });

  // ── Plain Plans: — insert missing rows ──────────────────────────────────

  test('inserts plan checkbox rows under plain Plans: when none exist', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapPlainPlans('5'));
    createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true');

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(written.includes('- [ ] 5-01-PLAN.md'), '5-01-PLAN.md row not inserted (plain Plans:)');
    assert.ok(written.includes('- [ ] 5-02-PLAN.md'), '5-02-PLAN.md row not inserted (plain Plans:)');
  });

  // ── Plan count update with plain Plans: ─────────────────────────────────

  test('plan count is updated when section uses plain Plans: (not bold)', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapPlainPlans('5'));
    // createPhaseWithPlans returns the padded dir path (05-test-phase)
    const phaseDir = createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
    ]);
    // Create a summary for plan 1 so it's not 0/2
    fs.writeFileSync(path.join(phaseDir, '5-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    // Plan count should reflect 1 completed out of 2
    assert.ok(
      written.match(/Plans:\s*1\/2 plans executed/),
      'Plain Plans: count not updated. ROADMAP.md:\n' + written,
    );
  });

  // ── Bold **Plans:** count update ─────────────────────────────────────────

  test('plan count is updated when section uses bold **Plans:**', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapBoldPlans('5', '0/3 plans executed'));
    const phaseDir = createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
      '5-03-PLAN.md',
    ]);
    // Complete 1 plan
    fs.writeFileSync(path.join(phaseDir, '5-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(
      written.includes('**Plans:** 1/3 plans executed'),
      '**Plans:** count not updated. ROADMAP.md:\n' + written,
    );
  });

  // ── Existing rows are checked off, not duplicated ───────────────────────

  test('existing plan rows are marked complete, not duplicated when SUMMARY exists', () => {
    const roadmapWithRows = [
      '# ROADMAP',
      '',
      '## Milestone v1.0',
      '',
      '### Phase 5: test phase',
      '',
      '**Plans:** 0/2 plans executed',
      '',
      '- [ ] 5-01-PLAN.md',
      '- [ ] 5-02-PLAN.md',
      '',
    ].join('\n');
    fs.writeFileSync(roadmapPath, roadmapWithRows);

    const phaseDir = createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
    ]);
    fs.writeFileSync(path.join(phaseDir, '5-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');

    // 5-01 should be checked, 5-02 should remain unchecked
    assert.ok(written.includes('- [x] 5-01-PLAN.md'), '5-01-PLAN.md not marked complete');
    assert.ok(written.includes('- [ ] 5-02-PLAN.md'), '5-02-PLAN.md incorrectly marked complete');

    // Only two rows — no duplicates
    const matches = (written.match(/- \[.\] 5-\d+-PLAN\.md/g) || []);
    assert.equal(matches.length, 2, `Expected 2 checkbox rows, got ${matches.length}:\n${written}`);
  });

  // ── Inserted rows are sorted ─────────────────────────────────────────────

  test('inserted plan rows are sorted in ascending order', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapBoldPlans('5'));
    createPhaseWithPlans(tmpDir, '5', [
      '5-03-PLAN.md',
      '5-01-PLAN.md',
      '5-02-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    const rowPositions = [
      written.indexOf('5-01-PLAN.md'),
      written.indexOf('5-02-PLAN.md'),
      written.indexOf('5-03-PLAN.md'),
    ];
    assert.ok(
      rowPositions[0] < rowPositions[1] && rowPositions[1] < rowPositions[2],
      'Inserted plan rows are not in ascending order. ROADMAP.md:\n' + written,
    );
  });

  // ── No plans found — command returns updated:false without inserting ─────

  test('returns updated:false gracefully when phase has no plan files', () => {
    fs.writeFileSync(roadmapPath, buildRoadmapBoldPlans('5'));
    // Create phase dir (padded slug) but no plan files
    const phaseDir = path.join(tmpDir, '.planning', 'phases', `${PHASE_DIR_SLUG_1163}-test-phase`);
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, false, 'Expected updated:false when no plans exist');
  });

  // ── Adversarial: CRLF in ROADMAP.md ──────────────────────────────────────

  test('CRLF line endings in ROADMAP.md are handled without corruption', () => {
    const content = buildRoadmapBoldPlans('5').replace(/\n/g, '\r\n');
    fs.writeFileSync(roadmapPath, content);
    createPhaseWithPlans(tmpDir, '5', ['5-01-PLAN.md', '5-02-PLAN.md']);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'CRLF ROADMAP not handled');
  });
});

describe('regressions: insert missing plan rows (#1163) — adversarial: partial gaps, canonical template, scoped insertion', () => {
  let tmpDir;
  let roadmapPath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1163-adv-');
    roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Finding 1: partial-row gaps ──────────────────────────────────────────

  test('(Finding 1) inserts missing rows when SOME plan rows already exist', () => {
    // Phase has 5-01, 5-02, 5-03 on disk.
    // ROADMAP already has a row for 5-01 only.
    // Expected: 5-02 and 5-03 rows are inserted; 5-01 is NOT duplicated.
    const roadmapContent = [
      '# ROADMAP',
      '',
      '## Milestone v1.0',
      '',
      `### Phase 5: test phase`,
      '',
      '**Plans:** 0/3 plans executed',
      '',
      'Plans:',
      '- [ ] 5-01-PLAN.md',
      '',
    ].join('\n');
    fs.writeFileSync(roadmapPath, roadmapContent);

    createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
      '5-03-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');

    // All three plans must have rows
    assert.ok(written.includes('5-01-PLAN.md'), '5-01-PLAN.md row missing');
    assert.ok(written.includes('5-02-PLAN.md'), '5-02-PLAN.md row was not inserted for partial gap');
    assert.ok(written.includes('5-03-PLAN.md'), '5-03-PLAN.md row was not inserted for partial gap');

    // No duplicates: exactly one checkbox row per plan
    const rows01 = (written.match(/- \[.\] 5-01-PLAN\.md/g) || []);
    const rows02 = (written.match(/- \[.\] 5-02-PLAN\.md/g) || []);
    const rows03 = (written.match(/- \[.\] 5-03-PLAN\.md/g) || []);
    assert.equal(rows01.length, 1, `5-01-PLAN.md duplicated (${rows01.length} times)`);
    assert.equal(rows02.length, 1, `5-02-PLAN.md duplicated (${rows02.length} times)`);
    assert.equal(rows03.length, 1, `5-03-PLAN.md duplicated (${rows03.length} times)`);
  });

  test('(Finding 1) running twice (idempotent) does not duplicate partially-inserted rows', () => {
    const roadmapContent = [
      '# ROADMAP',
      '',
      '## Milestone v1.0',
      '',
      `### Phase 5: test phase`,
      '',
      '**Plans:** 0/2 plans executed',
      '',
      'Plans:',
      '- [ ] 5-01-PLAN.md',
      '',
    ].join('\n');
    fs.writeFileSync(roadmapPath, roadmapContent);
    createPhaseWithPlans(tmpDir, '5', ['5-01-PLAN.md', '5-02-PLAN.md']);

    // Run once to insert 5-02
    runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    // Run again — should be a no-op
    runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    const rows01 = (written.match(/- \[.\] 5-01-PLAN\.md/g) || []);
    const rows02 = (written.match(/- \[.\] 5-02-PLAN\.md/g) || []);
    assert.equal(rows01.length, 1, `5-01-PLAN.md duplicated after two runs (${rows01.length} times)`);
    assert.equal(rows02.length, 1, `5-02-PLAN.md duplicated after two runs (${rows02.length} times)`);
  });

  // ── Finding 2: canonical template shape ─────────────────────────────────
  // The canonical template (gsd-core/templates/roadmap.md) uses:
  //   **Plans**: N plans     ← summary line (bold word, outer colon)
  //   (blank line)
  //   Plans:                 ← checklist header
  //   - [ ] NN-XX rows
  //
  // NOTE: `**Plans**:` differs from `**Plans:**` (colon placement):
  //   **Plans**:  → bold "Plans" + outer colon (CANONICAL)
  //   **Plans:**  → bold "Plans:" (previously assumed form)
  // Rows must be inserted under the `Plans:` checklist header, not after the
  // `**Plans**:` summary line.

  test('(Finding 2) canonical template: inserts rows under Plans: checklist header, not after **Plans**: summary', () => {
    // Canonical form: **Plans**: summary + blank + Plans: checklist header + no rows yet
    fs.writeFileSync(roadmapPath, buildRoadmapCanonicalTemplate('5', []));
    createPhaseWithPlans(tmpDir, '5', ['5-01-PLAN.md', '5-02-PLAN.md']);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(written.includes('- [ ] 5-01-PLAN.md'), '5-01-PLAN.md not inserted under Plans:');
    assert.ok(written.includes('- [ ] 5-02-PLAN.md'), '5-02-PLAN.md not inserted under Plans:');

    // Rows must appear AFTER the `Plans:` line, not between `**Plans**:` and `Plans:`
    const plansHeaderIdx = written.indexOf('\nPlans:\n');
    const boldPlansIdx = written.indexOf('**Plans**:');
    const row01Idx = written.indexOf('- [ ] 5-01-PLAN.md');
    assert.ok(boldPlansIdx !== -1, '**Plans**: summary line is missing from output');
    assert.ok(plansHeaderIdx !== -1, 'Plans: checklist header is missing from output');
    assert.ok(row01Idx > plansHeaderIdx, 'row 5-01 appears before Plans: checklist header');
  });

  test('(Finding 2) canonical template: plan count updated on **Plans**: summary line', () => {
    // **Plans**: uses bold word + outer colon — the count update regex must handle it
    fs.writeFileSync(roadmapPath, buildRoadmapCanonicalTemplate('5', []));
    const phaseDir = createPhaseWithPlans(tmpDir, '5', ['5-01-PLAN.md', '5-02-PLAN.md']);
    fs.writeFileSync(path.join(phaseDir, '5-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    // The **Plans**: summary line should be updated to reflect 1/2
    assert.ok(
      written.match(/\*\*Plans\*\*:\s*1\/2 plans executed/),
      '**Plans**: count not updated for canonical template shape.\nROADMAP.md:\n' + written,
    );
  });

  // ── Finding 3: insertion scoped to active milestone ──────────────────────

  test('(Finding 3) rows are inserted only in the active milestone, not in archived <details>', () => {
    // ROADMAP has duplicate phase heading: one inside <details> (archived) and
    // one in the active section.  Rows must land ONLY in the active section.
    fs.writeFileSync(roadmapPath, buildRoadmapWithArchivedDuplicate('5'));
    createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
      '5-03-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');

    // The archived section already has rows for 5-01 and 5-02 only (checked off).
    // The active section should get 5-03 row (and ideally 5-01/5-02 too if they
    // were missing from the active section — the active section's Plans: was empty).
    // Key assertion: no NEW rows were inserted into the archived <details> block.

    const detailsStart = written.indexOf('<details>');
    const detailsEnd = written.indexOf('</details>');
    const archivedSection = written.slice(detailsStart, detailsEnd + '</details>'.length);

    // The archived section should still have exactly 2 rows (5-01 and 5-02)
    const archivedRows = (archivedSection.match(/- \[.\] 5-\d+-PLAN\.md/g) || []);
    assert.equal(archivedRows.length, 2, `Archived section row count changed — rows were inserted into archived section:\n${archivedSection}`);

    // The active milestone section (after </details>) should have the new rows
    const activeSection = written.slice(detailsEnd + '</details>'.length);
    assert.ok(activeSection.includes('5-03-PLAN.md'), '5-03 row not inserted in active milestone section');
  });

  // ── Finding 1 (code-review round 2): detection scoped to active region ───
  // When an archived <details> block contains checkbox rows for the SAME plan
  // files as the current phase, the missingPlans filter must detect those plans
  // as MISSING from the ACTIVE section and insert them there — not skip them
  // because they appear anywhere in the full file content.

  test('(Finding 1 code-review) inserts ALL missing rows in active section even when archived section has same plans', () => {
    // Archived section has 5-01 and 5-02 (checked off for v0.9).
    // Active section has NO checkbox rows yet (empty Plans: block).
    // Phase 5 on disk has 5-01, 5-02, 5-03.
    // Expected: active section gets rows for ALL THREE plans (5-01, 5-02, 5-03).
    // Bug (pre-fix): detection runs against full content → 5-01 and 5-02 found in
    // archived block → missingPlans = [5-03 only] → only 5-03 inserted.
    fs.writeFileSync(roadmapPath, buildRoadmapWithArchivedDuplicate('5'));
    createPhaseWithPlans(tmpDir, '5', [
      '5-01-PLAN.md',
      '5-02-PLAN.md',
      '5-03-PLAN.md',
    ]);

    const result = runGsdTools(['roadmap', 'update-plan-progress', '5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(roadmapPath, 'utf-8');
    const detailsEnd = written.indexOf('</details>');
    const activeSection = written.slice(detailsEnd + '</details>'.length);

    // All three plans must be present in the active section
    assert.ok(activeSection.includes('5-01-PLAN.md'), '5-01-PLAN.md not inserted in active section (detection not scoped to active region)');
    assert.ok(activeSection.includes('5-02-PLAN.md'), '5-02-PLAN.md not inserted in active section (detection not scoped to active region)');
    assert.ok(activeSection.includes('5-03-PLAN.md'), '5-03-PLAN.md not inserted in active section');

    // Archived section must remain untouched (still exactly 2 rows)
    const archivedSection = written.slice(written.indexOf('<details>'), detailsEnd + '</details>'.length);
    const archivedRows = (archivedSection.match(/- \[.\] 5-\d+-PLAN\.md/g) || []);
    assert.equal(archivedRows.length, 2, `Archived section row count changed:\n${archivedSection}`);
  });
});
