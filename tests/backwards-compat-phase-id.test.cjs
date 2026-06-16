/**
 * Backwards-compatibility tests for legacy phase ID conventions.
 *
 * Covers:
 *   1. Legacy 'Phase N' ROADMAP entries still work when phase_id_convention
 *      is null (the default — no config key set).
 *   2a. Deprecated warning is SUPPRESSED when phase_id_convention is not set
 *       (legacy/default projects must see ZERO warnings). [regression guard]
 *   2b. Deprecated warning FIRES when phase_id_convention is explicitly
 *       'milestone-prefixed' and the roadmap doesn't conform (non-fatal).
 *   3. No automatic migration happens when a free-form roadmap is loaded.
 *   4. isDirInMilestone still works for old-style dirs ('02-setup') against
 *      ROADMAP entries 'Phase 2:'.
 *   5. isDirInMilestone works for new-style dirs ('GSD-02-01-setup') against
 *      ROADMAP entries 'Phase 2-01:'.
 *   6. Heading regex matches both '### Phase 2-01: Setup' and
 *      '### [GSD] Phase 2-01: Setup'.
 *
 * Tests 1-3 exercise new/regression behavior.
 * Tests 4-6 exercise existing/new behavior.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, captureConsole } = require('./helpers.cjs');
const { getMilestonePhaseFilter } = require('../gsd-core/bin/lib/roadmap-parser.cjs');

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeRoadmap(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

function writeConfig(tmpDir, obj) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(obj)
  );
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe('backwards-compat: legacy Phase N roadmap entries', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── test 1: legacy entries work with null phase_id_convention ──────────────

  test('Phase N ROADMAP entries work when phase_id_convention is null (default)', () => {
    // No phase_id_convention key → default (null) must still honour Phase N headings.
    writeRoadmap(tmpDir, [
      '## Roadmap v1.0: Current',
      '',
      '### Phase 1: Setup',
      '**Goal:** initial setup',
      '',
      '### Phase 2: Build',
      '**Goal:** build the thing',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('01-setup'), true, 'old-style dir must match Phase 1');
    assert.strictEqual(filter('02-build'), true, 'old-style dir must match Phase 2');
    assert.strictEqual(filter('03-deploy'), false, 'unlisted phase must not match');
  });

  // ── test 2a: NO warning for legacy/default projects (regression guard) ───────
  // This is the PRIMARY regression guard: a project with no phase_id_convention
  // must never receive the deprecation warning. Before the fix this test FAILS
  // because the warning fires unconditionally.

  test('no deprecation warning when phase_id_convention is not set (legacy default)', () => {
    // Free-form roadmap (no versioned milestone headings) AND no config file at
    // all — the warning must be fully suppressed.
    writeRoadmap(tmpDir, [
      '### Phase 1: Setup',
      '**Goal:** setup',
      '',
      '### Phase 2: Build',
      '**Goal:** build',
    ].join('\n'));

    const { stderr } = captureConsole(() => {
      getMilestonePhaseFilter(tmpDir);
    });

    assert.strictEqual(
      stderr,
      '',
      'no deprecation warning must be emitted when phase_id_convention is not set'
    );
  });

  // ── test 2b: deprecated warning fires when convention is milestone-prefixed ──

  test('deprecated warning fires (non-fatal) when phase_id_convention is milestone-prefixed and roadmap lacks versioned milestones', () => {
    // A "free-form" roadmap (no ## vX.Y milestone section) combined with the
    // explicit milestone-prefixed convention — the warning is actionable here.
    writeRoadmap(tmpDir, [
      '### Phase 1: Setup',
      '**Goal:** setup',
      '',
      '### Phase 2: Build',
      '**Goal:** build',
    ].join('\n'));

    const { stderr } = captureConsole(() => {
      getMilestonePhaseFilter(tmpDir, null, 'milestone-prefixed');
    });

    // Warning must fire but must not throw — non-fatal.
    assert.match(
      stderr,
      /deprecated|free.form|phase_id_convention/i,
      'a deprecation warning must be emitted when milestone-prefixed convention is set but roadmap is free-form'
    );
  });

  // ── test 3: no automatic migration ────────────────────────────────────────

  test('loading a free-form roadmap does not rewrite ROADMAP.md on disk', () => {
    const roadmapContent = [
      '### Phase 1: Setup',
      '**Goal:** setup',
    ].join('\n');

    writeRoadmap(tmpDir, roadmapContent);
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const before = fs.readFileSync(roadmapPath, 'utf-8');

    // Trigger a load — must not silently migrate the file. The deprecation
    // warning is covered by the previous test, so keep this fixture quiet.
    captureConsole(() => {
      getMilestonePhaseFilter(tmpDir);
    });

    const after = fs.readFileSync(roadmapPath, 'utf-8');
    assert.equal(after, before, 'ROADMAP.md must not be rewritten during load');
  });

  // ── test 4: old-style dirs ('02-setup') match 'Phase 2:' ─────────────────

  test('isDirInMilestone: old-style dir "02-setup" matches ROADMAP "Phase 2:"', () => {
    writeRoadmap(tmpDir, [
      '## Roadmap v1.0: Current',
      '',
      '### Phase 2: Setup',
      '**Goal:** setup',
    ].join('\n'));

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(filter('02-setup'), true, '"02-setup" must match "Phase 2:"');
    assert.strictEqual(filter('2-setup'), true, '"2-setup" must also match "Phase 2:"');
    assert.strictEqual(filter('03-other'), false, 'unlisted dir must not match');
  });

  // ── test 5: new-style dirs ('GSD-02-01-setup') match 'Phase 2-01:' ───────

  test('isDirInMilestone: new-style dir "GSD-02-01-setup" matches ROADMAP "Phase 2-01:"', () => {
    writeRoadmap(tmpDir, [
      '## Roadmap v1.0: Current',
      '',
      '### Phase 2-01: Setup',
      '**Goal:** setup',
    ].join('\n'));
    writeConfig(tmpDir, { project_code: 'GSD' });

    const filter = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(
      filter('GSD-02-01-setup'),
      true,
      '"GSD-02-01-setup" must match "Phase 2-01:"'
    );
    assert.strictEqual(
      filter('02-01-setup'),
      true,
      '"02-01-setup" must match "Phase 2-01:" without project prefix'
    );
  });

  // ── test 6: heading regex matches both plain and [GSD]-prefixed headings ──

  test('phase heading regex matches "### Phase 2-01: Setup" and "### [GSD] Phase 2-01: Setup"', () => {
    const plain = '### Phase 2-01: Setup';
    const bracketed = '### [GSD] Phase 2-01: Setup';

    // Both heading variants must be captured by the phasePattern used internally.
    // We exercise this via getMilestonePhaseFilter with a roadmap containing each form.

    const plainRoadmap = ['## Roadmap v1.0: Current', '', plain, '**Goal:** g'].join('\n');
    const bracketedRoadmap = ['## Roadmap v1.0: Current', '', bracketed, '**Goal:** g'].join('\n');

    writeRoadmap(tmpDir, plainRoadmap);
    const filterPlain = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(
      filterPlain('02-01-setup'),
      true,
      'plain heading "### Phase 2-01:" must be matched'
    );

    writeRoadmap(tmpDir, bracketedRoadmap);
    const filterBracketed = getMilestonePhaseFilter(tmpDir);
    assert.strictEqual(
      filterBracketed('02-01-setup'),
      true,
      '"### [GSD] Phase 2-01:" must also be matched by the heading regex'
    );
  });
});
