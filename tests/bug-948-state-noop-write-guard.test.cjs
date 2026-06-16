'use strict';
/**
 * Regression guard for bugs #948 and #944.
 *
 * #948 (data loss): a `state patch` whose fields all fail to match still
 * rewrites STATE.md — bumping `last_updated`, resetting `milestone_name` to
 * the template placeholder, and resurrecting a stale `stopped_at` from an
 * old body `## Session` block (body-derived value overwrites a newer
 * frontmatter value written by `record-session`).
 *
 * #944: `state record-session --stopped-at X --resume-file Y` silently
 * drops the supplied values when the STATE.md body lacks the exact session
 * labels the in-place replace expects, returning `{"recorded": false}` at
 * exit 0 and only bumping `last_updated`.
 *
 * Shared root cause: `readModifyWriteStateMd` always writes STATE.md even
 * when the transform produced no change, and `syncStateFrontmatter`
 * re-derives frontmatter (including milestone_name / stopped_at) from the
 * possibly-stale body on every write.
 *
 * Fixes:
 *   1. No-op guard in `readModifyWriteStateMd`: when transform output ===
 *      input, skip the write entirely.
 *   2. `syncStateFrontmatter` preserves existing `milestone_name` / `milestone`
 *      when the derived value is the template placeholder `'milestone'`.
 *   3. `syncStateFrontmatter` prefers existing frontmatter `stopped_at` /
 *      `paused_at` over a body-derived value (frontmatter wins).
 *   4. `cmdStateRecordSession` auto-creates a canonical `## Session` section
 *      when `--stopped-at` / `--resume-file` are supplied but no labels exist.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup, parseFrontmatter } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * STATE.md with:
 *  - real `milestone_name` in frontmatter (e.g. "My Real Milestone")
 *  - newer frontmatter `stopped_at` (written by a prior `record-session`)
 *  - stale `## Session` body section with an OLDER "Stopped at" line
 *
 * When a zero-match `state patch` runs on this file, NONE of these values
 * should be disturbed — the file must be byte-identical afterward.
 */
function buildStateMdWithStaleSectionAndRealFrontmatter(opts) {
  const {
    milestoneName = 'My Real Milestone',
    fmStoppedAt = 'Phase 3, Plan 2 — newer value',
    bodyStoppedAt = 'Phase 1, Plan 1 — stale historical value',
    lastUpdated = '2026-01-01T00:00:00.000Z',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v2.0',
    `milestone_name: ${milestoneName}`,
    'status: executing',
    `stopped_at: ${fmStoppedAt}`,
    `last_updated: ${lastUpdated}`,
    'progress:',
    '  total_phases: 5',
    '  completed_phases: 2',
    '  total_plans: 10',
    '  completed_plans: 4',
    '  percent: 40',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    'Status: Executing Phase 3',
    'Last Activity: 2026-01-01',
    '',
    '## Session',
    '',
    `**Last session:** 2026-01-01T00:00:00.000Z`,
    `**Stopped at:** ${bodyStoppedAt}`,
    '**Resume file:** None',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- [Phase 1]: Use Node 22',
    '',
  ].join('\n');
}

/**
 * STATE.md with NO session section at all — no "## Session" heading,
 * no Stopped at / Resume file labels. This is the #944 scenario.
 */
function buildStateMdWithoutSessionSection() {
  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: Foundation',
    'status: executing',
    'last_updated: 2026-01-01T00:00:00.000Z',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    'Status: Executing Phase 1',
    'Last Activity: 2026-01-01',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- [Phase 1]: Use TypeScript',
    '',
  ].join('\n');
}

/**
 * STATE.md with a canonical session section (the success path — must not regress).
 */
function buildStateMdWithCanonicalSessionSection() {
  return [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: Foundation',
    'status: executing',
    'last_updated: 2026-01-01T00:00:00.000Z',
    '---',
    '',
    '# GSD State',
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
    '**Stopped at:** Phase 1, Plan 1',
    '**Resume file:** None',
    '',
    '## Accumulated Context',
    '',
    '### Decisions',
    '',
    '- Use TypeScript',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug #948: zero-match patch must leave STATE.md byte-identical
// ─────────────────────────────────────────────────────────────────────────────

describe('#948: zero-match state patch must not rewrite STATE.md', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('STATE.md is byte-identical after a zero-match patch', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({});
    fs.writeFileSync(statePath, original);

    // Patch a field that does NOT exist in the file — zero matches expected.
    const result = runGsdTools('state patch --NonExistentFieldXYZ "some value"', tmpDir);
    assert.ok(result.success, `state patch should exit 0: ${result.error}`);

    const patchOutput = JSON.parse(result.output);
    assert.deepStrictEqual(patchOutput.updated, [], 'updated should be empty');
    assert.ok(Array.isArray(patchOutput.failed), 'failed should be an array');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(after, original, 'STATE.md must be byte-identical after zero-match patch');
  });

  test('milestone_name is preserved after zero-match patch (not reset to template placeholder)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({
      milestoneName: 'My Real Milestone',
    });
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentField "value"', tmpDir);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['milestone_name'], 'My Real Milestone',
      'milestone_name must not be reset to template placeholder by zero-match patch');
  });

  test('stopped_at frontmatter value is preserved after zero-match patch (via byte-identity)', () => {
    // The no-op guard prevents ANY rewrite when nothing changed, so the
    // frontmatter stopped_at is preserved because the file is never touched.
    // The stale body value cannot win because syncStateFrontmatter is never called.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({
      fmStoppedAt: 'Phase 3, Plan 2 — newer value',
      bodyStoppedAt: 'Phase 1, Plan 1 — stale historical value',
    });
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentField "value"', tmpDir);

    // The byte-identity test already covers this; this test confirms the key
    // field specifically is intact.
    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(after, original,
      'STATE.md must be byte-identical — stopped_at cannot be overwritten via a no-op patch');
  });

  test('last_updated is not bumped by a zero-match patch', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({
      lastUpdated: '2026-01-01T00:00:00.000Z',
    });
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentField "value"', tmpDir);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['last_updated'], '2026-01-01T00:00:00.000Z',
      'last_updated must not be bumped when no fields were changed');
  });

  test('a matching patch STILL updates STATE.md correctly (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const fixture = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** In Progress',
      '**Last Activity:** 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, fixture);

    const result = runGsdTools('state patch --Status "Phase complete — ready for verification"', tmpDir);
    assert.ok(result.success, `state patch should succeed: ${result.error}`);

    const patchOutput = JSON.parse(result.output);
    assert.ok(patchOutput.updated.includes('Status'), 'Status should be in updated list');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase complete — ready for verification'),
      'matching patch should update the field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #948: syncStateFrontmatter — milestone_name placeholder preservation
// ─────────────────────────────────────────────────────────────────────────────

describe('#948: syncStateFrontmatter preserves milestone_name when derived is template placeholder', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state sync preserves real milestone_name when disk yields only template placeholder', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Frontmatter has a real name, but no ROADMAP.md exists so getMilestoneInfo
    // will fall back to the 'milestone' placeholder — must not overwrite.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v2.5',
      'milestone_name: Very Real Project Name',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      'Status: Executing Phase 1',
      'Last Activity: 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['milestone_name'], 'Very Real Project Name',
      'milestone_name must not be reset to template placeholder by state sync');
  });

  test('state sync runs successfully and preserves milestone_name (no corruption)', () => {
    // state sync always rebuilds frontmatter from the body — the no-op guard
    // applies to commands whose transform produces no change. state sync always
    // writes because last_updated changes. This test verifies that a full sync
    // cycle does not corrupt milestone_name when the placeholder is derived.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v2.5',
      'milestone_name: Very Real Project Name',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      'Status: Executing Phase 1',
      'Last Activity: 2026-01-01',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['milestone_name'], 'Very Real Project Name',
      'state sync must not reset milestone_name to template placeholder');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #944: record-session with no session section must persist supplied values
// ─────────────────────────────────────────────────────────────────────────────

describe('#944: record-session persists values even when body lacks session labels', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('stopped-at and resume-file are present in STATE.md after record-session with no prior section', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());

    const PINNED_MS = Date.parse('2026-06-09T12:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 2, Plan 3" --resume-file ".planning/phases/02/02-03-PLAN.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `state record-session should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true,
      'recorded must be true when values were supplied and persisted');
    assert.ok(!output.reason || output.reason !== 'No session fields found in STATE.md',
      'must not return the silent no-op reason when values were supplied');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 2, Plan 3'),
      '--stopped-at value must appear in STATE.md');
    assert.ok(after.includes('.planning/phases/02/02-03-PLAN.md'),
      '--resume-file value must appear in STATE.md');
  });

  test('command does not silently no-op when values are supplied (recorded must not be false)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());

    const result = runGsdTools(
      'state record-session --stopped-at "Phase 5, Plan 1"',
      tmpDir,
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    // The key contract: if values were supplied, recorded must be true.
    assert.notStrictEqual(output.recorded, false,
      'recorded must not be false when --stopped-at was explicitly supplied');
  });

  test('STATE.md with non-canonical session labels still persists supplied values', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Session section exists but uses non-canonical label shapes (table, alternate caps)
    const nonCanonical = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '## Session Info',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Last Session | 2026-01-01 |',
      '| Stopped Here | Phase 1, Plan 1 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, nonCanonical);

    const PINNED_MS = Date.parse('2026-06-09T15:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 3, Plan 2" --resume-file "none.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true,
      'recorded must be true when values are persisted via auto-create fallback');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 3, Plan 2'),
      '--stopped-at value must be present in STATE.md');
    assert.ok(after.includes('none.md'),
      '--resume-file value must be present in STATE.md');
  });

  test('record-session with no args against a body-less file returns recorded:false (no regression)', () => {
    // When NO values are supplied and no session fields can be found/updated,
    // recorded:false is the correct behaviour — we only changed the contract
    // when the caller supplies values.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());

    const result = runGsdTools('state record-session', tmpDir);
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, false,
      'recorded should still be false when no session fields exist AND no values were supplied');
  });

  test('canonical session section still updates in place (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithCanonicalSessionSection());

    const PINNED_MS = Date.parse('2026-06-09T18:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 2, Plan 4" --resume-file ".planning/phases/02/02-04-PLAN.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true, 'recorded should be true');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 2, Plan 4'), 'stopped-at should be updated');
    assert.ok(after.includes('.planning/phases/02/02-04-PLAN.md'), 'resume-file should be updated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial fixtures: malformed frontmatter, missing fields, CRLF
// ─────────────────────────────────────────────────────────────────────────────

describe('#948/#944: adversarial fixture variants', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('zero-match patch on CRLF STATE.md leaves file unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Build with CRLF line endings
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({}).replace(/\n/g, '\r\n');
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentFieldXYZ "value"', tmpDir);

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(after, original, 'CRLF file must be byte-identical after zero-match patch');
  });

  test('zero-match patch on STATE.md with missing frontmatter fields does not corrupt', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const minimal = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** In Progress',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, minimal);

    const result = runGsdTools('state patch --NonExistentField "value"', tmpDir);
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const patchOutput = JSON.parse(result.output);
    assert.deepStrictEqual(patchOutput.updated, [], 'no fields should be updated');
  });

  test('record-session with empty body still records when values supplied', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Body is entirely empty (only frontmatter)
    const emptyBody = [
      '---',
      'gsd_state_version: 1.0',
      'status: planning',
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, emptyBody);

    const result = runGsdTools(
      'state record-session --stopped-at "Phase 1, Plan 1"',
      tmpDir,
    );
    assert.ok(result.success, `should exit 0: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.recorded, true,
      'should persist even into a body-less STATE.md');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Phase 1, Plan 1'),
      '--stopped-at value must appear in STATE.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial review findings: in-place update for existing ## Session heading
// ─────────────────────────────────────────────────────────────────────────────

describe('#944 adversarial: existing ## Session heading must be updated in place, not duplicated', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /**
   * HIGH finding: when a `## Session` heading already exists but uses
   * non-canonical rows (e.g. a markdown table), the DWIM code was appending
   * a second `## Session` block instead of normalizing the existing one.
   * buildStateFrontmatter / cmdStateSnapshot both read only the FIRST match,
   * so the newly-written Stopped at / Resume file end up in an ignored block.
   */
  test('record-session with existing non-canonical ## Session block: exactly one ## Session block afterward', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const nonCanonicalWithHeading = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '## Session',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Last Session | 2026-01-01 |',
      '| Stopped Here | Phase 1, Plan 1 |',
      '',
      '## Accumulated Context',
      '',
      '- Decision: use TypeScript',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, nonCanonicalWithHeading);

    const PINNED_MS = Date.parse('2026-06-09T20:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 4, Plan 2" --resume-file "resume.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');

    // (a) exactly ONE ## Session block — no duplicate
    const sessionHeadingCount = (after.match(/^## Session\s*$/gm) || []).length;
    assert.strictEqual(sessionHeadingCount, 1,
      'exactly ONE ## Session block must exist after record-session (no duplicate appended)');

    // (b) supplied values are present in the file
    assert.ok(after.includes('Phase 4, Plan 2'),
      '--stopped-at value must be present in STATE.md');
    assert.ok(after.includes('resume.md'),
      '--resume-file value must be present in STATE.md');
  });

  test('record-session with existing non-canonical ## Session block: state-snapshot sees supplied stopped_at', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const nonCanonicalWithHeading = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# GSD State',
      '',
      '## Session',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Last Session | 2026-01-01 |',
      '| Stopped Here | Phase 1, Plan 1 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, nonCanonicalWithHeading);

    const PINNED_MS = Date.parse('2026-06-09T20:30:00.000Z');
    runGsdTools(
      'state record-session --stopped-at "Phase 4, Plan 2" --resume-file "resume.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );

    // (c) state-snapshot must see the written stopped_at in the session block
    // (via buildStateFrontmatter frontmatter OR body Session section, first match)
    const snapshotResult = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snapshotResult.success, `state-snapshot should exit 0: ${snapshotResult.error}`);
    const snapshot = JSON.parse(snapshotResult.output);
    assert.strictEqual(
      snapshot.session && snapshot.session.stopped_at,
      'Phase 4, Plan 2',
      `state-snapshot session.stopped_at must reflect "Phase 4, Plan 2", got: ${JSON.stringify(snapshot.session)}`,
    );
  });

  /**
   * LOW finding: auto-created scaffold writes `**Last session:**` but
   * cmdStateSnapshot only matched `**Last Date:**`, so session.last_date
   * was null after auto-create despite a valid timestamp being written.
   * Fix: teach the snapshot parser to also accept `**Last session:**`.
   */
  test('state-snapshot returns non-null session.last_date after auto-create on body-less file', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithoutSessionSection());

    const PINNED_MS = Date.parse('2026-06-09T21:00:00.000Z');
    const recResult = runGsdTools(
      'state record-session --stopped-at "Phase 1, Plan 1"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(recResult.success, `record-session should exit 0: ${recResult.error}`);

    const snapshotResult = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snapshotResult.success, `state-snapshot should exit 0: ${snapshotResult.error}`);
    const snapshot = JSON.parse(snapshotResult.output);
    assert.notStrictEqual(
      snapshot.session && snapshot.session.last_date,
      null,
      `state-snapshot session.last_date must not be null after auto-create; got: ${JSON.stringify(snapshot.session)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #1101: record-session on a `## Session Continuity` bootstrap section must
// update IN PLACE, not append a duplicate `## Session` block.
//
// The reported symptom (recorded:false + frontmatter still mutated) is already
// fixed by #944/#948. The residual: the DWIM auto-create recognised only the
// canonical `## Session` heading, so a bootstrap `## Session Continuity` section
// (workstream.cts, gsd2-import.cts, templates/state.md) fell through to the
// append branch and produced a SECOND `## Session` block. The fix inserts the
// missing canonical fields into the existing `## Session Continuity` section,
// preserving the heading and any prose, and teaches the snapshot / frontmatter
// readers to recognise that heading.
// ─────────────────────────────────────────────────────────────────────────────

describe('#1101: record-session updates ## Session Continuity in place (no duplicate block)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  /** Workstream bootstrap shape: bold Stopped At/Resume File, no Last session. */
  function buildWorkstreamContinuity() {
    return [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '## Session Continuity',
      '**Stopped At:** N/A',
      '**Resume File:** None',
      '',
    ].join('\n');
  }

  test('workstream Session Continuity is updated in place — no duplicate ## Session appended', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildWorkstreamContinuity());

    const PINNED_MS = Date.parse('2026-06-12T12:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 1 context gathered" --resume-file ".planning/phases/01/01-CONTEXT.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.recorded, true, 'recorded must be true when values are supplied');

    const after = fs.readFileSync(statePath, 'utf-8');
    // No duplicate bare `## Session` heading appended (the only heading stays
    // `## Session Continuity`).
    assert.ok(!/^## Session[ \t]*$/m.test(after),
      `must not append a duplicate bare "## Session" block; got:\n${after}`);
    assert.strictEqual((after.match(/^## Session\b/gm) || []).length, 1,
      `exactly one Session-family heading must remain; got:\n${after}`);
    // Missing canonical field inserted; supplied values present.
    assert.ok(after.includes('**Last session:**'), 'Last session field must be inserted');
    assert.ok(after.includes('Phase 1 context gathered'), '--stopped-at value must be present');
    assert.ok(after.includes('.planning/phases/01/01-CONTEXT.md'), '--resume-file value must be present');
    // The frontmatter reader recognises `## Session Continuity` and derives stopped_at.
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm.stopped_at, 'Phase 1 context gathered',
      'frontmatter stopped_at must be derived from the ## Session Continuity section');
    // The cmdStateSnapshot reader (separate code path) must also resolve it.
    const snap = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snap.success, `state-snapshot should exit 0: ${snap.error}`);
    const snapshot = JSON.parse(snap.output);
    assert.strictEqual(snapshot.session.stopped_at, 'Phase 1 context gathered',
      'state-snapshot must read stopped_at from the ## Session Continuity section');
  });

  test('prose under ## Session Continuity is preserved (no data loss)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const withProse = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '## Session Continuity',
      '',
      '**Next recommended action:** keep-me-intact',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, withProse);

    const PINNED_MS = Date.parse('2026-06-12T13:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 2 done" --resume-file "none.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.recorded, true, 'recorded must be true');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('**Next recommended action:** keep-me-intact'),
      `existing prose must be preserved (no data loss); got:\n${after}`);
    assert.ok(!/^## Session[ \t]*$/m.test(after),
      'must not append a duplicate bare "## Session" block');
    assert.ok(after.includes('Phase 2 done'), '--stopped-at value must be present');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm.stopped_at, 'Phase 2 done',
      'frontmatter stopped_at must be derived from the ## Session Continuity section');
  });

  test('canonical ## Session block path is unchanged (no regression)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMdWithCanonicalSessionSection());

    const PINNED_MS = Date.parse('2026-06-12T14:00:00.000Z');
    const result = runGsdTools(
      'state record-session --stopped-at "Phase 9, Plan 9" --resume-file "r.md"',
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS) },
    );
    assert.ok(result.success, `record-session should exit 0: ${result.error}`);
    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual((after.match(/^## Session\b/gm) || []).length, 1,
      'canonical ## Session block must remain single');
    assert.ok(after.includes('Phase 9, Plan 9'), 'stopped-at value updated in canonical block');
  });

  test('legacy duplicate file: reader PREFERS canonical ## Session over ## Session Continuity (F1)', () => {
    // A file created by the OLD bug: a stale `## Session Continuity` first, then an
    // appended fresh `## Session`. The snapshot reader must read the canonical
    // `## Session` (fresh), matching the writer, not the stale Continuity block.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const duplicate = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '## Session Continuity',
      '**Stopped At:** STALE-continuity-value',
      '**Resume File:** None',
      '',
      '## Session',
      '',
      '**Last session:** 2026-06-12T10:00:00.000Z',
      '**Stopped at:** FRESH-canonical-value',
      '**Resume file:** r.md',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, duplicate);

    const snap = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snap.success, `state-snapshot should exit 0: ${snap.error}`);
    const snapshot = JSON.parse(snap.output);
    assert.strictEqual(snapshot.session.stopped_at, 'FRESH-canonical-value',
      'reader must prefer the canonical ## Session block over the stale ## Session Continuity');
  });

  test('h3 ### Session Continuity is NOT read as the session section (F4)', () => {
    // The reader is line-anchored to `^## `, so an h3 subsection must not be picked
    // up as the session section.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const h3Only = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'milestone_name: Foundation',
      'status: executing',
      'last_updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# State: example',
      '',
      '### Session Continuity',
      '**Last session:** 2026-06-12T10:00:00.000Z',
      '**Stopped at:** h3-should-not-be-session',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, h3Only);

    const snap = runGsdTools('state-snapshot', tmpDir);
    assert.ok(snap.success, `state-snapshot should exit 0: ${snap.error}`);
    const snapshot = JSON.parse(snap.output);
    assert.strictEqual(snapshot.session.last_date, null,
      'an h3 ### Session Continuity must not be treated as the ## Session section');
  });
});
