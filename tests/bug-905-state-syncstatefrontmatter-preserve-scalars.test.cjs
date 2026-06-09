'use strict';
/**
 * Regression guard for bug #905.
 *
 * `syncStateFrontmatter` (src/state.cts) only preserved `status` from existing
 * frontmatter when the body-derived value was missing/unknown. The scalars
 * `current_phase`, `current_phase_name`, `current_plan`, and `progress` were
 * silently stripped whenever `buildStateFrontmatter` could not extract them from
 * the body text — e.g. when an agent removed the bold `**Current Phase:**`
 * annotations.
 *
 * Fix: mirror the `cmdStateJson` fallback pattern in `syncStateFrontmatter` so
 * that all four scalars survive a `writeStateMd` / `state sync` call when the
 * body no longer carries the annotation but the existing frontmatter does.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, createTempDir, cleanup, parseFrontmatter } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A STATE.md whose YAML frontmatter holds all four scalars but whose body
 * does NOT contain the bold `**Current Phase:**` / `**Current Plan:**`
 * annotations that `buildStateFrontmatter` uses to re-derive them.
 *
 * This is the exact scenario that triggered the bug: the body has already lost
 * the annotations (e.g. because a CLI tool or agent overwrote it), but the
 * frontmatter still holds the ground-truth values. A subsequent `state sync`
 * (or any `writeStateMd` call) must not strip them.
 */
function buildStateMdWithoutBodyAnnotations(opts) {
  const {
    currentPhase = 3,
    currentPhaseName = 'Implementation',
    currentPlan = 2,
    progressPercent = 42,
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    `current_phase: ${currentPhase}`,
    `current_phase_name: ${currentPhaseName}`,
    `current_plan: ${currentPlan}`,
    'status: executing',
    'progress:',
    `  total_phases: 5`,
    `  completed_phases: 2`,
    `  total_plans: 10`,
    `  completed_plans: 4`,
    `  percent: ${progressPercent}`,
    '---',
    '',
    '# GSD State',
    '',
    '## Configuration',
    // Intentionally omitting "Current Phase:", "Current Phase Name:",
    // "Current Plan:" body annotations to reproduce the bug scenario.
    'Status: Executing',
    'Last Activity: 2026-01-01',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- Use Node 22',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('#905: syncStateFrontmatter preserves scalars when body annotations are absent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync preserves current_phase from existing frontmatter when body lacks annotation', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPhase: 3 }));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_phase,
      '3',
      `current_phase must be preserved from existing frontmatter after sync (got: ${JSON.stringify(fm.current_phase)})`,
    );
  });

  test('state sync preserves current_phase_name from existing frontmatter when body lacks annotation', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPhaseName: 'Implementation' }));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_phase_name,
      'Implementation',
      `current_phase_name must be preserved from existing frontmatter after sync (got: ${JSON.stringify(fm.current_phase_name)})`,
    );
  });

  test('state sync preserves current_plan from existing frontmatter when body lacks annotation', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPlan: 2 }));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_plan,
      '2',
      `current_plan must be preserved from existing frontmatter after sync (got: ${JSON.stringify(fm.current_plan)})`,
    );
  });

  test('state update (resync:false) preserves curated progress from existing frontmatter when body lacks disk-scan data', () => {
    // state update "Last Activity" calls readModifyWriteStateMd with resync:false.
    // That path runs syncStateFrontmatter and then explicitly re-applies the
    // pre-existing progress block (lines 1243-1253 of state.cts). The curated
    // progress values must survive even though the phases dir is empty.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ progressPercent: 42 }));

    // Add body annotation for Last Activity so state update can find and replace it
    const initial = fs.readFileSync(statePath, 'utf8');
    fs.writeFileSync(statePath, initial.replace('Last Activity: 2026-01-01', 'Last Activity: 2026-01-01'));

    const updateResult = runGsdTools(
      ['state', 'update', 'Last Activity', '2026-06-08'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.ok(fm.progress, 'frontmatter must retain a progress block after body-only update');
    // shouldPreserveExistingProgress: existing completed_plans (4) > derived (0 from empty disk)
    // → curated block survives via cmdStateJson read-path fallback.
    assert.strictEqual(
      fm.progress.completed_plans,
      4,
      `progress.completed_plans must be preserved via shouldPreserveExistingProgress ` +
      `(got: ${JSON.stringify(fm.progress?.completed_plans)})`,
    );
  });

  test('state update field preserves current_phase frontmatter when body lacks annotation', () => {
    // Trigger the write path via `state update` (which calls readModifyWriteStateMd
    // with resync:true), confirming the fix covers every write path.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutBodyAnnotations({ currentPhase: 7 }));

    const updateResult = runGsdTools(
      ['state', 'update', 'Last Activity', '2026-06-08'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

    const jsonResult = runGsdTools('state json', tmpDir);
    assert.ok(jsonResult.success, `state json failed: ${jsonResult.error}`);

    const fm = JSON.parse(jsonResult.output);
    assert.strictEqual(
      fm.current_phase,
      '7',
      `current_phase must survive a state.update write (got: ${JSON.stringify(fm.current_phase)})`,
    );
  });

  test('body annotation beats existing frontmatter when both are present', () => {
    // When the body DOES carry the annotation, the derived value wins — we must
    // not accidentally lock stale frontmatter in place.
    // IMPORTANT: assert on the raw written STATE.md file (not just state json,
    // which rebuilds from the body and would return body-derived values regardless
    // of what syncStateFrontmatter wrote to disk).
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Frontmatter says phase 3; body says phase 5. Body should win.
    fs.writeFileSync(statePath, [
      '---',
      'gsd_state_version: 1.0',
      'current_phase: 3',
      'current_phase_name: Old Phase',
      'current_plan: 1',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Current Phase: 5',
      'Current Phase Name: New Phase',
      'Current Plan: 2',
      'Status: Executing',
      'Last Activity: 2026-01-01',
      '',
    ].join('\n'));

    const syncResult = runGsdTools('state sync', tmpDir);
    assert.ok(syncResult.success, `state sync failed: ${syncResult.error}`);

    // Assert on raw file: body-derived values must be written to frontmatter,
    // not the stale existing values. This guards against a fallback that locks
    // in stale data even when buildStateFrontmatter successfully derived values.
    const writtenContent = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(writtenContent);
    assert.strictEqual(
      rawFm.current_phase,
      '5',
      `body-derived current_phase (5) must be written to raw frontmatter (not stale 3), got: ${JSON.stringify(rawFm.current_phase)}`,
    );
    assert.strictEqual(
      rawFm.current_phase_name,
      'New Phase',
      `body-derived current_phase_name must be written to raw frontmatter, got: ${JSON.stringify(rawFm.current_phase_name)}`,
    );
    assert.strictEqual(
      rawFm.current_plan,
      '2',
      `body-derived current_plan must be written to raw frontmatter, got: ${JSON.stringify(rawFm.current_plan)}`,
    );
  });

  test('syncStateFrontmatter preserves progress from existing frontmatter when disk has no phases dir', () => {
    // Directly exercises the !derivedFm['progress'] fallback in syncStateFrontmatter.
    // Without a phases dir, buildStateFrontmatter returns no progress block at all
    // (the existsSync guard at line ~927 short-circuits the disk scan). The
    // existing frontmatter's progress must then survive the writeStateMd call.
    // Use createTempDir (no phases dir) and set up .planning/ manually.
    const dir = createTempDir('gsd-905-nophasesdir-');
    try {
      fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
      const statePath = path.join(dir, '.planning', 'STATE.md');

      // Body has the "Current Phase:" annotation so cmdStateSync can proceed;
      // the progress block is ONLY in frontmatter (no ROADMAP, no phases dir).
      fs.writeFileSync(statePath, [
        '---',
        'gsd_state_version: 1.0',
        'current_phase: 2',
        'status: executing',
        'progress:',
        '  total_phases: 4',
        '  completed_phases: 1',
        '  total_plans: 8',
        '  completed_plans: 3',
        '  percent: 38',
        '---',
        '',
        '# GSD State',
        '',
        '## Configuration',
        'Current Phase: 2',
        'Status: Executing',
        'Last Activity: 2026-01-01',
        '',
      ].join('\n'));

      // state update "Last Activity" → readModifyWriteStateMd (resync:true for
      // Progress/Total Phases/Total Plans fields, but resync:false for Last Activity)
      // This calls syncStateFrontmatter; without phases dir, buildStateFrontmatter
      // produces no progress → !derivedFm['progress'] guard fires → existing preserved.
      const updateResult = runGsdTools(
        ['state', 'update', 'Last Activity', '2026-06-08'],
        dir,
      );
      assert.ok(updateResult.success, `state update failed: ${updateResult.error}`);

      // Assert on the raw frontmatter file — cmdStateJson would apply
      // shouldPreserveExistingProgress separately, so we must verify the on-disk state.
      const written = fs.readFileSync(statePath, 'utf8');
      const rawFm = parseFrontmatter(written);

      // The progress block must be present in the written frontmatter.
      // parseFrontmatter returns flat keys, so check the presence indicator.
      assert.ok(
        written.includes('progress:'),
        'progress block must be preserved in raw frontmatter when disk has no phases dir',
      );
      // percent: 38 should survive (no disk scan to overwrite it)
      assert.ok(
        written.includes('percent: 38'),
        `progress.percent: 38 must survive syncStateFrontmatter when no phases dir exists (raw: ${rawFm.progress})`,
      );
    } finally {
      cleanup(dir);
    }
  });
});
