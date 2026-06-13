'use strict';
// Regression tests for issue #1163 — roadmap update-plan-progress does not
// insert missing plan checklist rows.
//
// When a phase's ROADMAP section has no per-plan checkbox rows yet (a freshly
// generated template), `roadmap update-plan-progress <N>` must INSERT
// `- [ ] NN-XX-PLAN.md` entries under the phase's Plans: line (one per
// discovered plan file, sorted), rather than silently doing nothing.
//
// Also: the plan-count update was skipped when the section used plain
// `Plans:` instead of bold `**Plans:**`.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

// Phase numbers are zero-padded by normalizePhaseName so the .planning/phases/
// directory must use the padded form (e.g. "05-test-phase" for phase 5).
const PHASE_NUM = '5';       // what we pass on the command line
const PHASE_DIR_SLUG = '05'; // what ends up on disk after normalization

/**
 * ROADMAP.md with a phase-5 detail section that uses bold **Plans:** and has
 * NO per-plan checkbox rows yet.
 */
function buildRoadmapBoldPlans(phaseNum = PHASE_NUM, planCount = '0/3 plans executed') {
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
 * ROADMAP.md with a phase-5 detail section that uses plain `Plans:` (not bold)
 * and NO per-plan checkbox rows yet.
 */
function buildRoadmapPlainPlans(phaseNum = PHASE_NUM) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #1163: roadmap update-plan-progress inserts missing plan checklist rows', () => {
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
    const phaseDir = path.join(tmpDir, '.planning', 'phases', `${PHASE_DIR_SLUG}-test-phase`);
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
