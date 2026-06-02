'use strict';

/**
 * Regression tests for issue #26 (open-gsd/gsd-core).
 * Three generator-pattern drift items: W005 phaseDirNameRe,
 * W006-archived regex constants (PHASE_TOKEN_FROM_DIR_RE, MILESTONE_ARCHIVE_DIR_RE),
 * I001 canonicalPlanStem.
 *
 * After the generator migration, all three helpers are sourced from
 * validate.cjs. If they diverge from validate.ts, these
 * tests go RED.
 *
 * References:
 *   - Issue #26 (open-gsd/gsd-core) — three drift items + reproducer
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - PR #154 (issue #4) — generator pattern precedent
 *   - PR #156 (issue #6) — validate.ts generator scaffolding (#26 extends this)
 *   - Original PR #3479 — first validate.ts false-positive fix (never reached CJS)
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { runGsdTools, cleanup } = require('./helpers.cjs');

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

function writeStateMd(planningDir, phase) {
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

// ── Drift Item W005: phaseDirNameRe ──────────────────────────────────────────
//
// Issue #26 reproducer (verbatim):
//   mkdir -p .planning/phases/999.1-foo
//   echo "# Roadmap" > .planning/ROADMAP.md
//   node .claude/get-shit-done/bin/gsd-tools.cjs validate health
//   # Bug: emits W005 about 999.1-foo not following NN-name format
//
// verify.cjs must consume phaseDirNameRe from validate.cjs so
// the regex /^\d{2,}(?:\.\d+)*-[\w-]+$/ is the single source of truth.

describe('Drift item W005 — phaseDirNameRe: 999.X-name dirs must not trigger W005', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-26-d1-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir, '999.1');
    writeConfigJson(planningDir);

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      '# Roadmap\n\n- [x] **Phase 999.1:** Long Phase\n\n### Phase 999.1: Long Phase\n',
    );

    // Exact reproducer from issue #26
    fs.mkdirSync(path.join(phasesDir, '999.1-foo'), { recursive: true });
  });

  after(() => { cleanup(tmpDir); });

  test('no W005 for 999.1-foo (multi-digit sub-phase prefix)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w005 = (data.warnings ?? []).filter((w) => w.code === 'W005');
    assert.strictEqual(w005.length, 0,
      `Expected zero W005 for 999.1-foo, got: ${JSON.stringify(w005)}`);
  });

  test('phaseDirNameRe is exported from validate.cjs', () => {
    const gen = require('../get-shit-done/bin/lib/validate.cjs');
    assert.ok(gen.phaseDirNameRe instanceof RegExp,
      'validate.cjs must export phaseDirNameRe as a RegExp');
    const re = gen.phaseDirNameRe;
    assert.ok(re.test('01-setup'), 'should accept 01-setup');
    assert.ok(re.test('999-longphase'), 'should accept 999-longphase (3-digit prefix)');
    assert.ok(re.test('999.1-foo'), 'should accept 999.1-foo (sub-phase)');
    assert.ok(!re.test('1-shortname'), 'should reject single-digit prefix');
  });
});

// ── Drift Item W006-archived: PHASE_TOKEN_FROM_DIR_RE / MILESTONE_ARCHIVE_DIR_RE ─
//
// forEachArchivedPhaseToken() in verify.cjs uses two inline regex constants.
// After migration both are sourced from validate.cjs:
//   PHASE_TOKEN_FROM_DIR_RE  — extracts token from dir name like "64-auth-service"
//   MILESTONE_ARCHIVE_DIR_RE — matches archive dirs like "v1.0-phases"
//
// Test: phase 64 was archived to milestones/v1.0-phases/64-auth-service/.
// Without correct archive detection, W006 fires for "Phase 64 in ROADMAP.md
// but no directory on disk".

describe('Drift item W006-archived — MILESTONE_ARCHIVE_DIR_RE and PHASE_TOKEN_FROM_DIR_RE', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-26-d2-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir, '65');
    writeConfigJson(planningDir);

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 65:** Current Work',
        '',
        '### Phase 65: Current Work',
        '',
        '<details>',
        '<summary>Milestone v1.0 — Shipped</summary>',
        '',
        '### Phase 64: Auth Service',
        '',
        '</details>',
        '',
      ].join('\n'),
    );

    // Active phasesDir: only phase 65
    fs.mkdirSync(path.join(phasesDir, '65-current-work'), { recursive: true });

    // Archive: milestones/v1.0-phases/64-auth-service
    // MILESTONE_ARCHIVE_DIR_RE must match "v1.0-phases"
    // PHASE_TOKEN_FROM_DIR_RE must extract "64" from "64-auth-service"
    fs.mkdirSync(
      path.join(planningDir, 'milestones', 'v1.0-phases', '64-auth-service'),
      { recursive: true },
    );
  });

  after(() => { cleanup(tmpDir); });

  test('no W006 for Phase 64 archived under milestones/v1.0-phases/', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w006 = (data.warnings ?? []).filter(
      (w) => w.code === 'W006' && /Phase 64/i.test(w.message),
    );
    assert.strictEqual(w006.length, 0,
      `Expected no W006 for archived Phase 64, got: ${JSON.stringify(w006)}`);
  });

  test('MILESTONE_ARCHIVE_DIR_RE is exported and matches vN.N-phases dirs', () => {
    const gen = require('../get-shit-done/bin/lib/validate.cjs');
    assert.ok(gen.MILESTONE_ARCHIVE_DIR_RE instanceof RegExp,
      'validate.cjs must export MILESTONE_ARCHIVE_DIR_RE');
    const re = gen.MILESTONE_ARCHIVE_DIR_RE;
    assert.ok(re.test('v1.0-phases'), 'should match v1.0-phases');
    assert.ok(re.test('v1.10-phases'), 'should match v1.10-phases');
    assert.ok(!re.test('phases'), 'should NOT match plain phases');
    assert.ok(!re.test('1.0-phases'), 'should NOT match missing v prefix');
  });

  test('PHASE_TOKEN_FROM_DIR_RE is exported and extracts phase tokens correctly', () => {
    const gen = require('../get-shit-done/bin/lib/validate.cjs');
    assert.ok(gen.PHASE_TOKEN_FROM_DIR_RE instanceof RegExp,
      'validate.cjs must export PHASE_TOKEN_FROM_DIR_RE');
    const re = gen.PHASE_TOKEN_FROM_DIR_RE;
    assert.strictEqual(re.exec('64-auth-service')?.[1], '64');
    assert.strictEqual(re.exec('03B-feature')?.[1], '03B');
    assert.strictEqual(re.exec('999.1-foo')?.[1], '999.1');
    assert.strictEqual(re.exec('CK-64-auth')?.[1], '64');
  });
});

// ── Drift Item I001: canonicalPlanStem ────────────────────────────────────────
//
// validate.ts Check 7: canonicalPlanStem('68-01-scaffolding') → '68-01'
// verify.cjs had an inline copy. After migration, canonicalPlanStem is
// sourced from validate.cjs.
//
// Test: "68-01-scaffolding-PLAN.md" + "68-01-SUMMARY.md" → no I001
// Both stems canonicalize to "68-01" → match found → I001 suppressed.

describe('Drift item I001 — canonicalPlanStem: long PLAN stem matches short SUMMARY stem', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-26-d3-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir, '68');
    writeConfigJson(planningDir);

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      '# Roadmap\n\n- [x] **Phase 68:** Scaffolding\n\n### Phase 68: Scaffolding\n',
    );

    const phaseDir = path.join(phasesDir, '68-scaffolding');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Long-stem PLAN + short-stem SUMMARY → must match via canonicalPlanStem
    fs.writeFileSync(path.join(phaseDir, '68-01-scaffolding-PLAN.md'), '---\nwave: 1\n---\n# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '68-01-SUMMARY.md'), '# Summary\n');
  });

  after(() => { cleanup(tmpDir); });

  test('no I001 when 68-01-scaffolding-PLAN.md matches 68-01-SUMMARY.md via canonicalPlanStem', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const i001 = (data.info ?? []).filter((i) => i.code === 'I001');
    assert.strictEqual(i001.length, 0,
      `Expected zero I001, got: ${JSON.stringify(i001)}`);
  });

  test('canonicalPlanStem is exported from validate.cjs', () => {
    const gen = require('../get-shit-done/bin/lib/validate.cjs');
    assert.strictEqual(typeof gen.canonicalPlanStem, 'function',
      'validate.cjs must export canonicalPlanStem as a function');
    assert.strictEqual(gen.canonicalPlanStem('68-01-scaffolding'), '68-01');
    assert.strictEqual(gen.canonicalPlanStem('68-01'), '68-01');
    assert.strictEqual(gen.canonicalPlanStem('3A-01-feature'), '3A-01');
    assert.strictEqual(gen.canonicalPlanStem('no-match'), 'no-match');
  });
});
