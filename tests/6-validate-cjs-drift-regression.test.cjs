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
