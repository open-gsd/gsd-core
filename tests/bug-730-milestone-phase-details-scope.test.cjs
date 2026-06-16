/**
 * Regression test for bug #730: phase details defined under a milestone-scoped
 * "## Milestone vX.Y — … (Phase Details)" section are invisible to phase
 * resolution (getRoadmapPhaseInternal / init phase-op) when the flat shared
 * "## Phase Details" section for an earlier milestone sits between the shared
 * ## Phases checklist and the per-milestone Phase Details section.
 *
 * The bug manifests ONLY before any .planning/phases/ directory exists because
 * findPhaseInternal masks it once the dir is created. RED step — tests 1 and 3
 * are expected to fail against current code.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runGsdTools, cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Shared fixture content
// ---------------------------------------------------------------------------

const STATE_CONTENT = `---
milestone: v1.1
---
`;

const ROADMAP_CONTENT = `# Roadmap: Example

## Phases

- [x] **Phase 1: Setup** — initial scaffold

### Milestone v1.1 — Second milestone (added 2026-01-01)

- [ ] **Phase 2: Feature** — the new thing

## Phase Details

### Phase 1: Setup
**Goal:** scaffold the app.

## Milestone v1.1 — Second milestone (Phase Details)

### Phase 2: Feature
**Goal:** build the new thing.
`;

// ---------------------------------------------------------------------------
// Helper: create a bare project with .planning/ but NO .planning/phases/ dir
// ---------------------------------------------------------------------------

function createBareProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-'));
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('bug #730 — milestone (Phase Details) section scope resolution', () => {
  let dir;

  beforeEach(() => {
    dir = createBareProject();
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), STATE_CONTENT, 'utf-8');
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), ROADMAP_CONTENT, 'utf-8');
  });

  afterEach(() => {
    cleanup(dir);
  });

  // -------------------------------------------------------------------------
  // Test 1 (AC1): init phase-op resolves phase defined only under its
  // per-milestone "(Phase Details)" section
  // -------------------------------------------------------------------------
  test('init phase-op resolves a current-milestone phase defined only under its (Phase Details) section', () => {
    const r = runGsdTools('init phase-op 2', dir);
    assert.ok(r.success, `init phase-op 2 failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.phase_found, true, `phase_found should be true; got phase_found=${out.phase_found}, expected_phase_dir=${out.expected_phase_dir}`);
    assert.strictEqual(out.phase_name, 'Feature', `phase_name should be 'Feature'; got '${out.phase_name}'`);
    assert.strictEqual(out.padded_phase, '02', `padded_phase should be '02'; got '${out.padded_phase}'`);
    assert.strictEqual(out.expected_phase_dir, '.planning/phases/02-feature', `expected_phase_dir should be '.planning/phases/02-feature'; got '${out.expected_phase_dir}'`);
  });

  // -------------------------------------------------------------------------
  // Test 2 (AC4): first-milestone phase still resolves via the flat
  // "## Phase Details" section — no regression
  // -------------------------------------------------------------------------
  test('init phase-op still resolves a first-milestone phase (no regression on flat Phase Details)', () => {
    const r = runGsdTools('init phase-op 1', dir);
    assert.ok(r.success, `init phase-op 1 failed: ${r.error}`);

    const out = JSON.parse(r.output);
    assert.strictEqual(out.phase_found, true, `phase_found should be true for phase 1; got ${out.phase_found}`);
    assert.strictEqual(out.phase_name, 'Setup', `phase_name should be 'Setup'; got '${out.phase_name}'`);
  });

  // -------------------------------------------------------------------------
  // Test 3 (AC5): getRoadmapPhaseInternal resolves the current-milestone phase
  // directly before any phases/ dir exists
  // -------------------------------------------------------------------------
  test('getRoadmapPhaseInternal resolves the current-milestone phase directly before any dir exists', () => {
    const { getRoadmapPhaseInternal } = require('../gsd-core/bin/lib/roadmap-parser.cjs');

    const res = getRoadmapPhaseInternal(dir, '2');
    assert.ok(res !== null && res !== undefined, `getRoadmapPhaseInternal returned null/undefined for phase 2`);
    assert.strictEqual(res.found, true, `res.found should be true; got ${JSON.stringify(res)}`);
    assert.strictEqual(res.phase_name, 'Feature', `res.phase_name should be 'Feature'; got '${res.phase_name}'`);
  });

  // -------------------------------------------------------------------------
  // Test 4 (AC3): validate health raises W006 for a current-milestone phase
  // defined under (Phase Details) with no directory on disk.
  //
  // Before the fix, extractCurrentMilestone's slice stopped before the
  // "## Milestone v1.1 — … (Phase Details)" section, so phase 2's
  // "### Phase 2: Feature" header was invisible and W006 was never raised.
  // After the fix the slice includes that section and W006 is emitted.
  //
  // This test uses its OWN local fixture (separate tmpdir) so it does not
  // disturb the shared beforeEach/afterEach fixture used by tests 1–3.
  // -------------------------------------------------------------------------
  test('validate health raises W006 for a started current-milestone phase defined under (Phase Details) with no directory', () => {
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-t4-'));
    try {
      const planning = path.join(localDir, '.planning');
      fs.mkdirSync(planning, { recursive: true });

      // STATE.md — milestone: v1.1
      fs.writeFileSync(
        path.join(planning, 'STATE.md'),
        `---\nmilestone: v1.1\n---\n`,
        'utf-8',
      );

      // ROADMAP.md — phase 2 is [x] (started/complete) so the not-started
      // guard does NOT suppress W006.  Phase 2's details live exclusively in
      // the per-milestone "(Phase Details)" section (the blind-spot pre-fix).
      fs.writeFileSync(
        path.join(planning, 'ROADMAP.md'),
        `# Roadmap: Example\n\n## Phases\n\n- [x] **Phase 1: Setup** — initial scaffold\n\n### Milestone v1.1 — Second milestone (added 2026-01-01)\n\n- [x] **Phase 2: Feature** — the new thing\n\n## Phase Details\n\n### Phase 1: Setup\n**Goal:** scaffold the app.\n\n## Milestone v1.1 — Second milestone (Phase Details)\n\n### Phase 2: Feature\n**Goal:** build the new thing.\n`,
        'utf-8',
      );

      // Create the phase 1 directory so phase 1 does NOT trigger W006.
      // Phase 2 has NO directory — that's the missing-dir condition under test.
      fs.mkdirSync(path.join(planning, 'phases', '01-setup'), { recursive: true });

      const result = runGsdTools(['validate', 'health'], localDir);
      const payload = JSON.parse(result.output);
      const warnings = payload.warnings || [];

      // Find a W006 entry whose message references phase 2 (by number or name).
      const w006ForPhase2 = warnings.find(
        (w) =>
          w.code === 'W006' &&
          (/\b2\b/.test(w.message) || /\b02\b/.test(w.message) || /Feature/i.test(w.message)),
      );

      assert.ok(
        w006ForPhase2 != null,
        `Expected a W006 warning referencing phase 2 (Feature) — phase 2 is started ([x]) and has no directory on disk, ` +
          `but its ### Phase 2: header lives in the Milestone v1.1 (Phase Details) section which was invisible before the fix. ` +
          `Got warnings: ${JSON.stringify(warnings)}`,
      );
    } finally {
      cleanup(localDir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: three-milestone roadmap, current = latest (v1.2)
  // -------------------------------------------------------------------------
  test('init phase-op resolves the latest milestone phase in a 3-milestone roadmap', () => {
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-t5-'));
    try {
      const planning = path.join(localDir, '.planning');
      fs.mkdirSync(planning, { recursive: true });

      fs.writeFileSync(
        path.join(planning, 'STATE.md'),
        `---\nmilestone: v1.2\n---\n`,
        'utf-8',
      );

      fs.writeFileSync(
        path.join(planning, 'ROADMAP.md'),
        `# Roadmap: Example\n\n## Phases\n\n- [x] **Phase 1: Setup** — done\n\n### Milestone v1.1 — Second (added 2026-01-01)\n\n- [x] **Phase 2: Feature** — done\n\n### Milestone v1.2 — Third (added 2026-02-01)\n\n- [ ] **Phase 3: Polish** — current\n\n## Phase Details\n\n### Phase 1: Setup\n**Goal:** scaffold.\n\n## Milestone v1.1 — Second (Phase Details)\n\n### Phase 2: Feature\n**Goal:** build.\n\n## Milestone v1.2 — Third (Phase Details)\n\n### Phase 3: Polish\n**Goal:** refine.\n`,
        'utf-8',
      );

      const r = runGsdTools('init phase-op 3', localDir);
      assert.ok(r.success, `init phase-op 3 failed: ${r.error}`);

      const out = JSON.parse(r.output);
      assert.strictEqual(out.phase_found, true, `phase_found should be true; got phase_found=${out.phase_found}`);
      assert.strictEqual(out.phase_name, 'Polish', `phase_name should be 'Polish'; got '${out.phase_name}'`);
      assert.strictEqual(out.padded_phase, '03', `padded_phase should be '03'; got '${out.padded_phase}'`);
      assert.strictEqual(out.expected_phase_dir, '.planning/phases/03-polish', `expected_phase_dir should be '.planning/phases/03-polish'; got '${out.expected_phase_dir}'`);
    } finally {
      cleanup(localDir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: sub-milestone sharing a version prefix — closed sibling must NOT
  // cross-pollinate into the active milestone's Phase Details lookup (#730)
  // -------------------------------------------------------------------------
  test('init phase-op anchors Phase Details to the selected sub-milestone, not a closed same-prefix sibling', () => {
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-730-t6-'));
    try {
      const planning = path.join(localDir, '.planning');
      fs.mkdirSync(planning, { recursive: true });

      // STATE.md — milestone: v3.0 (matches v3.0-B active slice)
      fs.writeFileSync(
        path.join(planning, 'STATE.md'),
        `---\nmilestone: v3.0\n---\n`,
        'utf-8',
      );

      // ROADMAP.md — v3.0-A is SHIPPED (closed), v3.0-B is active.
      // The Phase Details for v3.0-A comes FIRST — without version-boundary
      // anchoring the old code would grab it (first non-closed (Phase Details)
      // heading outside the window), returning phase_name='Alpha' instead of 'Beta'.
      fs.writeFileSync(
        path.join(planning, 'ROADMAP.md'),
        [
          '# Roadmap: Example',
          '',
          '## Phases',
          '',
          '### Milestone v3.0-A — First slice (added 2026-01-01) ✅ SHIPPED',
          '',
          '- [x] **Phase 1: Alpha** — done',
          '',
          '### Milestone v3.0-B — Second slice (added 2026-02-01)',
          '',
          '- [ ] **Phase 2: Beta** — current',
          '',
          '## Phase Details',
          '',
          '## Milestone v3.0-A — First slice (Phase Details)',
          '',
          '### Phase 1: Alpha',
          '**Goal:** alpha goal.',
          '',
          '## Milestone v3.0-B — Second slice (Phase Details)',
          '',
          '### Phase 2: Beta',
          '**Goal:** beta goal.',
          '',
        ].join('\n'),
        'utf-8',
      );

      const r = runGsdTools('init phase-op 2', localDir);
      assert.ok(r.success, `init phase-op 2 failed: ${r.error}`);

      const out = JSON.parse(r.output);
      assert.strictEqual(out.phase_found, true, `phase_found should be true; got phase_found=${out.phase_found}, output=${JSON.stringify(out)}`);
      assert.strictEqual(out.phase_name, 'Beta', `phase_name should be 'Beta' (v3.0-B section), not '${out.phase_name}' (would indicate v3.0-A cross-pollination)`);
      assert.strictEqual(out.expected_phase_dir, '.planning/phases/02-beta', `expected_phase_dir should be '.planning/phases/02-beta'; got '${out.expected_phase_dir}'`);
    } finally {
      cleanup(localDir);
    }
  });
});
