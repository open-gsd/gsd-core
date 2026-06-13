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
//
// Adversarial findings (Codex review):
//   Finding 1 — partial-row gaps: if SOME plan files already have rows,
//     MISSING rows are never inserted (rowsAlreadyPresent short-circuit).
//   Finding 2 — canonical template shape: uses `**Plans**:` (bold word +
//     outer colon) + separate `Plans:` checklist header; insertion must land
//     under the `Plans:` checklist header, not after the `**Plans**:` summary.
//   Finding 3 — insertion scoped to active milestone: full-file replace can
//     insert rows into archived milestone sections with duplicate phase headings.

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
 * ROADMAP.md using the CANONICAL template shape:
 *   **Plans**: N plans       ← bold summary metadata line
 *   (blank line)
 *   Plans:                   ← checklist header
 *   - [ ] NN-XX-PLAN.md      ← per-plan checkboxes
 *
 * The template (gsd-core/templates/roadmap.md) always uses this two-line form.
 * `**Plans**:` has the colon OUTSIDE the bold markers.
 */
function buildRoadmapCanonicalTemplate(phaseNum = PHASE_NUM, existingRows = []) {
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
function buildRoadmapWithArchivedDuplicate(phaseNum = PHASE_NUM) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial findings from Codex review (added after #1163 initial fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #1163 adversarial: partial-row gaps, canonical template shape, scoped insertion', () => {
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
});
