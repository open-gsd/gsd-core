'use strict';

// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Tests for ROADMAP wave dependency surfacing (#2447).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const PLAN_TEMPLATE = (wave, truths = []) => `---
phase: "1"
plan: "01-0${wave}"
type: standard
wave: ${wave}
depends_on: []
files_modified: []
autonomous: true
requirements: []
must_haves:
  truths:
${truths.map(t => `    - ${t}`).join('\n') || '    - (none)'}
  artifacts: []
  key_links: []
---

<objective>
Plan ${wave} objective
</objective>
`;

function makePlanProject(files = {}) {
  const dir = createTempProject();
  fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '');
  fs.mkdirSync(path.join(dir, '.planning', 'phases', '01-foundation'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

describe('roadmap annotate-dependencies', () => {
  let tmpDir;

  afterEach(() => cleanup(tmpDir));

  test('inserts wave headers for multi-wave plan set', () => {
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Set up DB
- [ ] 01-02-PLAN.md — Build API
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1, ['DB schema is correct']),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_TEMPLATE(2, ['API returns 200']),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, true);
    assert.strictEqual(out.waves, 2);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('**Wave 1**'), 'Wave 1 header present');
    assert.ok(roadmap.includes('**Wave 2**'), 'Wave 2 header present');
    assert.ok(roadmap.includes('blocked on Wave 1'), 'Wave 2 blocked-on note present');
  });

  test('does not insert wave headers for single-wave plan set', () => {
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Set up DB
- [ ] 01-02-PLAN.md — Build API
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1, ['DB schema is correct']),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_TEMPLATE(1, ['API returns 200']),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(!roadmap.includes('**Wave 1**'), 'no Wave header for single-wave set');
    assert.ok(!roadmap.includes('blocked on'), 'no blocked-on note for single wave');
  });

  test('surfaces cross-cutting constraints when truths appear in 2+ plans', () => {
    const sharedTruth = 'All endpoints require auth';
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Set up DB
- [ ] 01-02-PLAN.md — Build API
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1, [sharedTruth, 'DB schema is correct']),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_TEMPLATE(2, [sharedTruth, 'API returns 200']),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.cross_cutting_constraints, 1);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('Cross-cutting constraints:'), 'constraints subsection present');
    assert.ok(roadmap.includes(sharedTruth), 'shared truth listed');
  });

  test('does not surface constraints that appear in only one plan', () => {
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Set up DB
- [ ] 01-02-PLAN.md — Build API
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1, ['Only in plan 1']),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_TEMPLATE(2, ['Only in plan 2']),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.cross_cutting_constraints, 0);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(!roadmap.includes('Cross-cutting constraints:'), 'no constraints section when none are cross-cutting');
  });

  test('is idempotent — running twice does not double-insert wave headers', () => {
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Set up DB
- [ ] 01-02-PLAN.md — Build API
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1),
      '.planning/phases/01-foundation/01-02-PLAN.md': PLAN_TEMPLATE(2),
    });

    runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    const secondResult = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(secondResult.success);

    const out = JSON.parse(secondResult.output);
    assert.strictEqual(out.updated, false, 'second run should be no-op');

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const waveMatches = roadmap.match(/\*\*Wave \d+\*\*/g) || [];
    assert.strictEqual(waveMatches.length, 2, 'exactly 2 wave headers (not doubled)');
  });

  test('returns no-op when phase has no plans', () => {
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Set up project\n`,
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, false);
  });

  test('#2757: truths containing colons do not crash annotate-dependencies', () => {
    // Unquoted truths with colons (Rails idioms: db:seed, /foo/:id, Class::Method)
    // caused parseMustHavesBlock to return {} instead of a string, then t.trim() threw.
    const colonTruths = [
      'GET /foo/:id resolves to controller#show',
      'Class::Method is idempotent',
      '"Quoted truth with colon: inside"',
    ];
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Set up project\n**Plans:** 1 plan\n\nPlans:\n- [ ] 01-01-PLAN.md — Repro plan\n`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(1, colonTruths),
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command threw on colon-containing truths: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(typeof out.updated === 'boolean', 'should return a valid result object');
  });

  test('#314 map-lookup: found-path uses plan wave, miss-path defaults to wave 1', () => {
    // Behavior lock for the O(1) Map swap: asserts BOTH branches of the lookup.
    // - 01-01-PLAN.md is in planData (wave 2) → checklist line must land under Wave 2.
    // - 01-99-PLAN.md is NOT in planData → null-on-miss → defaults to wave 1.
    tmpDir = makePlanProject({
      '.planning/ROADMAP.md': `# Roadmap

### Phase 1: Foundation
**Goal:** Set up project
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md — Known plan
- [ ] 01-99-PLAN.md — Unknown plan (no PLAN.md)
`,
      '.planning/phases/01-foundation/01-01-PLAN.md': PLAN_TEMPLATE(2),
      // 01-99-PLAN.md intentionally absent — simulates a checklist entry with no backing plan file
    });

    const result = runGsdTools('roadmap annotate-dependencies 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');

    // Both waves must be present (wave 1 from the miss, wave 2 from the found entry)
    assert.ok(roadmap.includes('**Wave 1**'), 'Wave 1 header present (miss-path default)');
    assert.ok(roadmap.includes('**Wave 2**'), 'Wave 2 header present (found-path)');

    // Known plan (wave 2) must appear AFTER Wave 2 header
    const wave2Idx = roadmap.indexOf('**Wave 2**');
    const knownLineIdx = roadmap.indexOf('01-01-PLAN.md');
    assert.ok(knownLineIdx > wave2Idx, 'known plan line grouped under Wave 2');

    // Unknown plan (wave 1 default) must appear AFTER Wave 1 header and BEFORE Wave 2 header
    const wave1Idx = roadmap.indexOf('**Wave 1**');
    const unknownLineIdx = roadmap.indexOf('01-99-PLAN.md');
    assert.ok(unknownLineIdx > wave1Idx, 'unknown plan line grouped under Wave 1');
    assert.ok(unknownLineIdx < wave2Idx, 'unknown plan line appears before Wave 2 section');
  });

  test('plan-phase.md documents annotate-dependencies step', () => {
    const planPhase = fs.readFileSync(
      path.join(__dirname, '../gsd-core/workflows/plan-phase.md'), 'utf-8'
    );
    assert.ok(planPhase.includes('annotate-dependencies'), 'plan-phase.md references annotate-dependencies command');
    assert.ok(planPhase.includes('13d'), 'plan-phase.md has step 13d');
    assert.ok(planPhase.includes('Cross-cutting constraints'), 'plan-phase.md documents cross-cutting constraints');
  });
});
