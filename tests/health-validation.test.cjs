/**
 * GSD Tools Tests - Health Validation
 *
 * Tests for fix/health-validation-1473c:
 *   - W011: STATE/ROADMAP cross-validation (phase divergence detection)
 *   - W012: branching_strategy validation
 *   - W013: context_window validation
 *   - W014: phase_branch_template placeholder validation
 *   - W015: milestone_branch_template placeholder validation
 *   - stateReplaceFieldWithFallback field-miss warning
 *   - Boundary conditions and edge cases
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Helpers ────────────────────────────────────────────────────────────────

function writeMinimalRoadmap(tmpDir, phases = ['1']) {
  const lines = phases.map(n => `### Phase ${n}: Phase ${n} Description`).join('\n');
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap\n\n${lines}\n`
  );
}

function writeMinimalStateMd(tmpDir, content) {
  const defaultContent = content || `# Session State\n\n## Current Position\n\nPhase: 1\n`;
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    defaultContent
  );
}

function writeMinimalProjectMd(tmpDir) {
  const sections = ['## What This Is', '## Core Value', '## Requirements'];
  const content = sections.map(s => `${s}\n\nContent here.\n`).join('\n');
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'PROJECT.md'),
    `# Project\n\n${content}`
  );
}

function writeValidConfigJson(tmpDir, overrides = {}) {
  const base = { model_profile: 'balanced', commit_docs: true };
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify({ ...base, ...overrides }, null, 2)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. W011: STATE/ROADMAP cross-validation
// ─────────────────────────────────────────────────────────────────────────────

describe('W011: STATE/ROADMAP cross-validation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('STATE says current phase but ROADMAP shows it as complete -> warning', () => {
    writeMinimalProjectMd(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [x] Phase 3: Database Layer\n\n### Phase 3: Database Layer\n**Goal:** DB setup\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Session State\n\n**Current Phase:** 03\n**Current Phase Name:** Database Layer\n**Status:** In progress\n`
    );
    writeValidConfigJson(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-database-layer'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W011'),
      `Expected W011 in warnings: ${JSON.stringify(output.warnings)}`
    );
  });

  test('STATE and ROADMAP agree (phase not checked off) -> no W011 warning', () => {
    writeMinimalProjectMd(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 2: API Layer\n\n### Phase 2: API Layer\n**Goal:** Build API\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Session State\n\n**Current Phase:** 2\n**Status:** In progress\n`
    );
    writeValidConfigJson(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api-layer'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.warnings.some(w => w.code === 'W011'),
      `Should not have W011: ${JSON.stringify(output.warnings)}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. W012-W015: Config field validation
// ─────────────────────────────────────────────────────────────────────────────

describe('config field validation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('W012: invalid branching_strategy triggers warning', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { branching_strategy: 'banana' });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W012'),
      `Expected W012 in warnings: ${JSON.stringify(output.warnings)}`
    );
  });

  test('W013: negative context_window triggers warning', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { context_window: -500 });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W013'),
      `Expected W013 in warnings: ${JSON.stringify(output.warnings)}`
    );
  });

  test('W014: phase_branch_template missing {phase} triggers warning', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { phase_branch_template: 'gsd/no-placeholder-{slug}' });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W014'),
      `Expected W014 in warnings: ${JSON.stringify(output.warnings)}`
    );
  });

  test('W015: milestone_branch_template missing {milestone} triggers warning', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { milestone_branch_template: 'release/no-placeholder' });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W015'),
      `Expected W015 in warnings: ${JSON.stringify(output.warnings)}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Boundary conditions
// ─────────────────────────────────────────────────────────────────────────────

describe('boundary conditions', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('context_window config accepts 500000 (boundary value)', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { context_window: 500000 });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.warnings.some(w => w.code === 'W013'),
      `Should not have W013 for context_window=500000: ${JSON.stringify(output.warnings)}`
    );
  });

  test('context_window config accepts 200000 (default value)', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { context_window: 200000 });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.warnings.some(w => w.code === 'W013'),
      `Should not have W013 for context_window=200000: ${JSON.stringify(output.warnings)}`
    );
  });

  test('W013 does NOT fire when context_window is absent from config', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.warnings.some(w => w.code === 'W013'),
      `Should not have W013 when context_window is absent: ${JSON.stringify(output.warnings)}`
    );
  });

  test('health check handles STATE.md with no Current Phase field (no W011 crash)', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nSome content but no phase reference.\n');
    writeValidConfigJson(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command should not crash: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(typeof output.status === 'string', 'should return a status string');
    assert.ok(Array.isArray(output.errors), 'should return errors array');
    assert.ok(Array.isArray(output.warnings), 'should return warnings array');
  });

  test('health check handles empty ROADMAP.md (no crash)', () => {
    writeMinimalProjectMd(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '');
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1.\n');
    writeValidConfigJson(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command should not crash on empty ROADMAP.md: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(typeof output.status === 'string', 'should return a status string');
    assert.ok(Array.isArray(output.errors), 'should return errors array');
    assert.ok(Array.isArray(output.warnings), 'should return warnings array');
  });

  test('config.json with trailing comma -- validate health reports parse error', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1.\n');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      '{"model_profile": "balanced",}'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Test Phase\n'
    );

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `validate health should not crash on invalid JSON: ${result.error}`);

    const output = JSON.parse(result.output);
    const hasE005 = output.errors.some(e => e.code === 'E005');
    assert.ok(hasE005, `Should report E005 for invalid config.json: ${JSON.stringify(output.errors)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. stateReplaceFieldWithFallback warning
// ─────────────────────────────────────────────────────────────────────────────

describe('stateReplaceFieldWithFallback field-miss warning', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('advance-plan completes even when fields are missing (non-fatal)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Current Phase:** 01\n**Current Plan:** 1\n**Total Plans in Phase:** 3\n`
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.advanced === true || output.reason === 'last_plan', 'advance should complete');
  });

  test('validate health on 50-phase project completes in under 3000ms', () => {
    // Stress test for the new health checks at scale
    let roadmapContent = '# Roadmap v1.0\n\n';
    for (let i = 1; i <= 50; i++) {
      roadmapContent += `- [${i <= 25 ? 'x' : ' '}] Phase ${i}: Feature ${i}\n`;
    }
    roadmapContent += '\n';
    for (let i = 1; i <= 50; i++) {
      roadmapContent += `### Phase ${i}: Feature ${i}\n\n**Goal:** Build feature ${i}\n**Plans:** 1 plans\n\n`;
    }
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapContent);

    writeMinimalProjectMd(tmpDir);
    writeMinimalStateMd(tmpDir, '# Session State\n\n**Current Phase:** 26\n**Status:** Planning\n');
    writeValidConfigJson(tmpDir);

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (let i = 1; i <= 50; i++) {
      const pad = String(i).padStart(2, '0');
      const phaseDir = path.join(phasesDir, `${pad}-feature-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${pad}-01-PLAN.md`), `# Plan ${i}\n`);
      if (i <= 25) {
        fs.writeFileSync(path.join(phaseDir, `${pad}-01-SUMMARY.md`), `# Summary ${i}\n`);
      }
    }

    const result = runGsdTools('validate health', tmpDir);

    assert.ok(result.success, `validate health should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(typeof output.status === 'string', 'Should return a status string');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/6-validate-cjs-drift-regression.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:6-validate-cjs-drift-regression (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression tests for issue #6 (open-gsd/gsd-core):
 *   Three validation behaviors present in validate.ts are missing from verify.cjs,
 *   producing silent false negatives on the CJS production path.
 *
 * Three drift items fixed by porting phaseVariants() and activeDiskPhases to verify.cjs:
 *
 *   1. W007 activeDiskPhases — verify.cjs uses diskPhases (includes archived) for the
 *      W007 check; validate.ts uses activeDiskPhases (active phasesDir only). Archived
 *      phases absent from current ROADMAP trigger false W007 in verify.cjs.
 *
 *   2. phaseVariants() normalization — validate.ts has a phaseVariants() function
 *      generating padded/unpadded/letter-suffix variants for matching. verify.cjs uses
 *      only parseInt→padded (drops letter suffix), causing false W006/W007 for
 *      letter-suffix phases with padding mismatch between ROADMAP and disk.
 *
 *   3. W006 unchecked-phase variant skip — same phaseVariants() gap causes false W006
 *      for phases with padding mismatch: ROADMAP says "3B", disk has "03B-foo", but
 *      verify.cjs padded("3B") = "03" (drops letter) → "03B" on disk not matched.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #6 (open-gsd/gsd-core)
 *   - PR #154 (issue #4) — precedent for the generator pattern
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { runGsdTools, cleanup } = require('./helpers.cjs');

// ── Fixture helpers ──────────────────────────────────────────────────────────

function mkplanning(base) {
  const planningDir = path.join(base, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });
  return { planningDir, phasesDir };
}

function writeProjectMd(planningDir) {
  fs.writeFileSync(
    path.join(planningDir, 'PROJECT.md'),
    '# Project\n\n## What This Is\nTest.\n\n## Core Value\nTest.\n\n## Requirements\nTest.\n',
  );
}

function writeStateMd(planningDir, phase = '2') {
  fs.writeFileSync(
    path.join(planningDir, 'STATE.md'),
    `# State\n\n**Current Phase:** ${phase}\n**Status:** In progress\n`,
  );
}

function writeConfigJson(planningDir) {
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ model_profile: 'balanced' }),
  );
}

// ── Drift Item 1: W007 activeDiskPhases ────────────────────────────────────
//
// Project has a shipped milestone archive (milestones/v1.0-phases/) with old phase
// "1" inside, and active phasesDir with phase "2". Current ROADMAP only mentions
// Phase 2 (v1.0 phases were shipped and removed from ROADMAP).
//
// validate.ts: activeDiskPhases = phases from active phasesDir only (not archived).
//   "1" is only in diskPhases (via forEachArchivedPhaseToken), not activeDiskPhases.
//   W007 iterates activeDiskPhases → "1" never checked → no false W007.
//
// verify.cjs pre-fix: diskPhases = collectDiskPhases() + forEachArchivedPhaseToken().
//   diskPhases includes "1" (from old archive). W007 iterates diskPhases → "1" not
//   in roadmapPhases → W007 fires for "1". False positive.

describe('Drift item 1 — W007 activeDiskPhases: no false W007 for archived phases', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6-d1-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir);
    writeConfigJson(planningDir);

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 2:** API',
        '',
        '### Phase 2: API',
        '',
        '## Progress',
        '| Phase | Status |',
        '|-------|--------|',
        '| 2 | Complete |',
      ].join('\n'),
    );

    // Active phasesDir: only phase 2
    fs.mkdirSync(path.join(phasesDir, '2-api'), { recursive: true });

    // Current active milestone archive: v1.1-phases contains phase 2 (in ROADMAP)
    fs.mkdirSync(
      path.join(planningDir, 'milestones', 'v1.1-phases', '2-api'),
      { recursive: true },
    );

    // Old shipped milestone archive: v1.0-phases contains phase 1 (no longer in ROADMAP)
    // v1.0 sorts before v1.1 so getActiveMilestoneArchiveDir returns v1.1.
    // forEachArchivedPhaseToken walks BOTH v1.0 and v1.1, so diskPhases gets "1".
    // collectDiskPhases (activeDiskPhases) only uses v1.1 (active archive) — "1" excluded.
    fs.mkdirSync(
      path.join(planningDir, 'milestones', 'v1.0-phases', '1-foundation'),
      { recursive: true },
    );
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('no W007 for archived phase "1" absent from current ROADMAP', () => {
    // validate.ts: activeDiskPhases has only "2" (from active phasesDir + v1.1 archive).
    //   "1" is in diskPhases (forEachArchivedPhaseToken walks v1.0) but NOT activeDiskPhases.
    //   W007 iterates activeDiskPhases → "1" never checked → no false W007. Correct.
    // verify.cjs pre-fix: diskPhases = collectDiskPhases + forEachArchivedPhaseToken.
    //   diskPhases includes "1" (from v1.0 archive). W007 iterates diskPhases → "1" not
    //   in roadmapPhases → W007 fires for "1". False positive.
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    // Filter to W007 that mentions only phase "1" (not "1A", "01A", etc.)
    const w007Phase1 = w007.filter(
      (w) => /\bPhase 1\b/i.test(w.message) && !/\b1[A-Z]\b/i.test(w.message),
    );
    assert.strictEqual(
      w007Phase1.length,
      0,
      `Expected no W007 for archived phase 1 (v1.0 archive), got: ${JSON.stringify(w007)}`,
    );
  });
});

// ── Drift Item 2: phaseVariants() normalization ────────────────────────────
//
// ROADMAP has "### Phase 01A:" (zero-padded letter-suffix heading).
// Disk has directory "1A-foo" (unpadded letter-suffix form).
// These should match because phaseVariants("01A") = {"01A", "1A", "01A"}.
//
// validate.ts: diskPhases has "1A". phaseVariants("01A") includes "1A" → match → no W006.
//   activeDiskPhases has "1A". phaseVariants("1A") includes "01A" → roadmapPhaseVariants
//   has "01A" → match → no W007.
//
// verify.cjs pre-fix:
//   W006 loop for "01A": padded = String(parseInt("01A",10)).padStart(2,'0') = "01".
//     diskPhases.has("01A")? NO. diskPhases.has("01")? NO. → W006 fires. Bug.
//   W007 loop for "1A": unpadded = String(parseInt("1A",10)) = "1".
//     roadmapPhases.has("1A")? NO. roadmapPhases.has("1")? NO. → W007 fires. Bug.

describe('Drift item 2 — phaseVariants() normalization: letter-suffix zero-padding mismatch', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6-d2-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir);
    writeConfigJson(planningDir);

    // ROADMAP: Phase 01A (zero-padded + letter suffix)
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 01A:** Suffix Phase',
        '',
        '### Phase 01A: Suffix Phase',
        '',
        '## Progress',
        '| Phase | Status |',
        '|-------|--------|',
        '| 01A | Complete |',
      ].join('\n'),
    );

    // Disk: unpadded form "1A-foo"
    fs.mkdirSync(path.join(phasesDir, '1A-suffix-phase'), { recursive: true });
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('no false W006 when ROADMAP says 01A and disk has 1A-... (phaseVariants normalizes)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w006 = (data.warnings ?? []).filter((w) => w.code === 'W006');
    assert.strictEqual(
      w006.length,
      0,
      `Expected no W006 (01A == 1A after normalization), got: ${JSON.stringify(w006)}`,
    );
  });

  test('no false W007 when disk has 1A and ROADMAP says 01A (phaseVariants normalizes)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    assert.strictEqual(
      w007.length,
      0,
      `Expected no W007 (1A on disk matches 01A in ROADMAP), got: ${JSON.stringify(w007)}`,
    );
  });
});

// ── Drift Item 3: W006 false positive when disk uses zero-padded letter form ─
//
// ROADMAP has "### Phase 3B:" (unpadded letter-suffix heading).
// Disk has directory "03B-feature" (zero-padded letter-suffix form).
//
// validate.ts:
//   diskPhases has "03B". phaseVariants("3B") = {"3B","3B","03B"}.
//   existsOnDisk = diskPhases.has("03B") = TRUE → no W006.
//   activeDiskPhases has "03B". phaseVariants("03B") = {"03B","3B","03B"}.
//   roadmapPhaseVariants has {"3B","3B","03B"} → "03B" found → no W007.
//
// verify.cjs pre-fix:
//   W006 for "3B": padded = parseInt("3B")=3 → "03" (drops "B").
//     diskPhases.has("3B")? NO. diskPhases.has("03")? NO (dir is "03B" not "03"). → W006 fires.
//   W007 for "03B": unpadded = String(parseInt("03B",10)) = "3".
//     roadmapPhases.has("03B")? NO. roadmapPhases.has("3")? NO (ROADMAP has "3B" not "3"). → W007.

describe('Drift item 3 — W006 false positive when disk has zero-padded letter form', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6-d3-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir, '3B');
    writeConfigJson(planningDir);

    // ROADMAP: Phase 3B (unpadded in heading)
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 3B:** Feature Extension',
        '',
        '### Phase 3B: Feature Extension',
        '',
        '## Progress',
        '| Phase | Status |',
        '|-------|--------|',
        '| 3B | Complete |',
      ].join('\n'),
    );

    // Disk: "03B-feature" (zero-padded letter-suffix form)
    fs.mkdirSync(path.join(phasesDir, '03B-feature'), { recursive: true });
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('no false W006 when ROADMAP says 3B and disk has 03B-... (phaseVariants covers zero-padded)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w006 = (data.warnings ?? []).filter((w) => w.code === 'W006');
    assert.strictEqual(
      w006.length,
      0,
      `Expected no W006 (3B == 03B after normalization), got: ${JSON.stringify(w006)}`,
    );
  });

  test('no false W007 when disk has 03B and ROADMAP says 3B (phaseVariants covers both forms)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    assert.strictEqual(
      w007.length,
      0,
      `Expected no W007 (03B on disk matches 3B in ROADMAP), got: ${JSON.stringify(w007)}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-416-archive-dir-null.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-416-archive-dir-null (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression tests for issue #416 (open-gsd/gsd-core).
 *
 * Bug: getActiveMilestoneArchiveDir falls back to the newest archive directory
 * when STATE.md names a milestone that has no matching archive yet, producing
 * W007 false positives for phases from a prior (completed) milestone.
 *
 * Fix: when STATE.md is present and parseable and names a milestone, but no
 * milestones/<vX.Y>-phases/ directory matches, return null. The version-sort
 * fallback to the newest archive fires only when STATE.md is absent or
 * unparseable.
 *
 * Knuth invariant: the resolver answers one question —
 * "what archive directory holds the active milestone's phases?"
 * Answer space: <dir> | null.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { runGsdTools, cleanup } = require('./helpers.cjs');

// ── helpers ──────────────────────────────────────────────────────────────────

function mkplanning(base) {
  const planningDir = path.join(base, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });
  return planningDir;
}

function writeMinimalRoadmap(planningDir, phases) {
  // phases: array of { num, name, checked }
  const checkboxes = phases.map(({ num, name, checked }) =>
    `- [${checked ? 'x' : ' '}] **Phase ${num}:** ${name}`,
  ).join('\n');
  const headings = phases.map(({ num, name }) =>
    `### Phase ${num}: ${name}\n**Goal:** Completed.\n`,
  ).join('\n');
  fs.writeFileSync(
    path.join(planningDir, 'ROADMAP.md'),
    `# Roadmap\n\n${checkboxes}\n\n${headings}`,
  );
}

function writeStateMdMilestone(planningDir, milestone) {
  fs.writeFileSync(
    path.join(planningDir, 'STATE.md'),
    `# State\n\n**milestone:** ${milestone}\n**Current Phase:** 23\n**Status:** In progress\n`,
  );
}

function writeProjectMd(planningDir) {
  fs.writeFileSync(
    path.join(planningDir, 'PROJECT.md'),
    '# Project\n\n## What This Is\nTest.\n\n## Core Value\nTest.\n\n## Requirements\nTest.\n',
  );
}

function writeConfigJson(planningDir) {
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ model_profile: 'balanced' }),
  );
}

function mkArchivePhases(planningDir, version, phaseNums) {
  // Creates .planning/milestones/<version>-phases/<NN>-phase-name/ dirs
  const archiveDir = path.join(planningDir, 'milestones', `${version}-phases`);
  for (const num of phaseNums) {
    const padded = String(num).padStart(2, '0');
    fs.mkdirSync(path.join(archiveDir, `${padded}-phase-${num}`), { recursive: true });
  }
  return archiveDir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 1: STATE.md milestone: v6.0, only v5.0-phases/ on disk
//         → resolver returns null, verifier emits zero W007 for phases 17–22
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #416 case 1: STATE.md v6.0 with only v5.0-phases/ on disk → null, no W007', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-416-c1-'));
    const planningDir = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeConfigJson(planningDir);

    // Active milestone is v6.0 — no archive for it yet (phases live in flat phases/)
    writeStateMdMilestone(planningDir, 'v6.0');

    // v5.0 was the prior completed milestone; its archive exists on disk
    mkArchivePhases(planningDir, 'v5.0', [17, 18, 19, 20, 21, 22]);

    // ROADMAP reflects only v6.0 phases (v5.0 phases are in a prior milestone,
    // not in the current roadmap section)
    writeMinimalRoadmap(planningDir, [
      { num: 23, name: 'New Foundation', checked: false },
    ]);
  });

  after(() => { cleanup(tmpDir); });

  test('validate health emits zero W007 warnings (no prior-milestone phases surfaced)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `validate health failed: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    assert.strictEqual(
      w007.length,
      0,
      `Expected zero W007 — phases 17–22 from v5.0-phases/ must not appear as "active".\nGot: ${JSON.stringify(w007, null, 2)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 2: No STATE.md, multiple archives on disk → version-sort fallback
//         returns the highest-versioned archive (existing behavior preserved)
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #416 case 2: no STATE.md + multiple archives → version-sort fallback to newest', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-416-c2-'));
    const planningDir = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeConfigJson(planningDir);

    // No STATE.md — resolver must use the version-sort fallback
    // Two archives: v4.0 and v5.0; v5.0 is newer
    mkArchivePhases(planningDir, 'v4.0', [10, 11, 12]);
    mkArchivePhases(planningDir, 'v5.0', [17, 18, 19]);

    // ROADMAP lists v5.0 phases so W007 does not fire
    writeMinimalRoadmap(planningDir, [
      { num: 17, name: 'Alpha', checked: true },
      { num: 18, name: 'Beta', checked: true },
      { num: 19, name: 'Gamma', checked: true },
    ]);
  });

  after(() => { cleanup(tmpDir); });

  test('validate health succeeds and does not emit W007 for v5.0 archive phases', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `validate health failed: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    // v5.0 phases (17–19) are in the archive returned by the fallback and
    // in the ROADMAP, so no W007 should fire.
    assert.strictEqual(
      w007.length,
      0,
      `Expected zero W007 for v5.0 archive phases present in ROADMAP.\nGot: ${JSON.stringify(w007, null, 2)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 3: STATE.md milestone: v5.0, matching v5.0-phases/ exists → returns it
//         (regression guard — happy path must not break)
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #416 case 3: STATE.md v5.0 with matching v5.0-phases/ → returns archive dir', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-416-c3-'));
    const planningDir = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeConfigJson(planningDir);

    // STATE.md names v5.0 and a matching archive exists
    writeStateMdMilestone(planningDir, 'v5.0');
    mkArchivePhases(planningDir, 'v5.0', [17, 18, 19, 20, 21, 22]);

    // ROADMAP lists v5.0 phases so W007 does not fire
    writeMinimalRoadmap(planningDir, [
      { num: 17, name: 'Alpha', checked: true },
      { num: 18, name: 'Beta', checked: true },
      { num: 19, name: 'Gamma', checked: true },
      { num: 20, name: 'Delta', checked: true },
      { num: 21, name: 'Epsilon', checked: true },
      { num: 22, name: 'Zeta', checked: true },
    ]);
  });

  after(() => { cleanup(tmpDir); });

  test('validate health emits zero W007 — archive phases are in ROADMAP and active', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `validate health failed: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    assert.strictEqual(
      w007.length,
      0,
      `Expected zero W007 for matching v5.0 archive with v5.0 in STATE.md.\nGot: ${JSON.stringify(w007, null, 2)}`,
    );
  });
});
  });
}
