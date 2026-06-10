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

  test('stopped_at frontmatter value is preserved (stale body value must not win)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const original = buildStateMdWithStaleSectionAndRealFrontmatter({
      fmStoppedAt: 'Phase 3, Plan 2 — newer value',
      bodyStoppedAt: 'Phase 1, Plan 1 — stale historical value',
    });
    fs.writeFileSync(statePath, original);

    runGsdTools('state patch --NonExistentField "value"', tmpDir);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['stopped_at'], 'Phase 3, Plan 2 — newer value',
      'frontmatter stopped_at must not be overwritten by stale body value');
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

  test('state sync preserves frontmatter stopped_at over stale body value', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const content = buildStateMdWithStaleSectionAndRealFrontmatter({
      fmStoppedAt: 'Phase 4, Plan 3 — canonical value',
      bodyStoppedAt: 'Phase 1, Plan 1 — stale old value',
    });
    fs.writeFileSync(statePath, content);

    const result = runGsdTools('state sync', tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const after = fs.readFileSync(statePath, 'utf-8');
    const fm = parseFrontmatter(after);
    assert.strictEqual(fm['stopped_at'], 'Phase 4, Plan 3 — canonical value',
      'frontmatter stopped_at must win over stale body-derived value on sync');
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
