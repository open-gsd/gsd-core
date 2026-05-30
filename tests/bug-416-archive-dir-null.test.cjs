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

const { runGsdTools } = require('./helpers.cjs');

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

  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

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

  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

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

  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

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
