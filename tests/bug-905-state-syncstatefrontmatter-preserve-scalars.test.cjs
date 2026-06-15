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

// ─────────────────────────────────────────────────────────────────────────────
// Bug #1230 regression suite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a STATE.md where:
 *  - frontmatter has an explicit status (e.g. 'completed') and optional stopped_at
 *  - body has a Status: field that is STALE relative to the frontmatter
 *    (e.g. "Verifying Phase 3" would derive 'verifying')
 * A subsequent incidental write must NOT revert the hand-set frontmatter status.
 */
function buildStateMd1230({ fmStatus = 'completed', fmStoppedAt = null, bodyStatus = 'Verifying Phase 3', bodyStoppedAt = null } = {}) {
  const fmLines = [
    '---',
    'gsd_state_version: 1.0',
    `status: ${fmStatus}`,
  ];
  if (fmStoppedAt) fmLines.push(`stopped_at: "${fmStoppedAt}"`);
  fmLines.push('---');

  const bodyLines = [
    '',
    '# GSD State',
    '',
    '## Configuration',
    `Status: ${bodyStatus}`,
    'Last Activity: 2026-01-01',
    `Current Phase: 3`,
    '',
    '## Session',
    '',
    '**Last session:** 2026-01-01T00:00:00.000Z',
  ];
  if (bodyStoppedAt) bodyLines.push(`**Stopped at:** ${bodyStoppedAt}`);
  bodyLines.push('');

  return [...fmLines, ...bodyLines].join('\n');
}

describe('bug #1230: readModifyWriteStateMd preserves frontmatter status/stopped_at when write does not change body source field', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // (a) CORE: record-session with stale body Status leaves frontmatter status: completed intact
  test('(a) record-session does NOT revert frontmatter status: completed when body Status is unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // frontmatter status: completed; body Status: Verifying Phase 3 (derives 'verifying')
    fs.writeFileSync(statePath, buildStateMd1230({ fmStatus: 'completed', bodyStatus: 'Verifying Phase 3' }));

    const result = runGsdTools(
      ['state', 'record-session', '--stopped-at', 'Phase 3 final review checkpoint'],
      tmpDir,
    );
    assert.ok(result.success, `record-session failed: ${result.error}`);

    // Assert on raw file frontmatter — not state json (which re-derives)
    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.status,
      'completed',
      `frontmatter status must remain 'completed' after record-session (body Status unchanged); got: ${JSON.stringify(rawFm.status)}`,
    );
  });

  // (b) add-decision (resync:true) with frontmatter status: completed, stale body → status preserved
  test('(b) add-decision (resync:true) does NOT revert frontmatter status: completed when body Status unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMd1230({ fmStatus: 'completed', bodyStatus: 'Verifying Phase 3' }));

    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '3', '--summary', 'Use Node 22'],
      tmpDir,
    );
    assert.ok(result.success, `add-decision failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.status,
      'completed',
      `frontmatter status must remain 'completed' after add-decision; got: ${JSON.stringify(rawFm.status)}`,
    );
  });

  // (c) LEGITIMATE UPDATE NOT FROZEN: begin-phase changes body Status → frontmatter re-derived correctly.
  //
  // stateReplaceField(content, 'Status', ...) replaces the FIRST ^Status: match in the
  // full content (frontmatter + body). When the frontmatter has NO 'status:' key, the
  // match falls through to the body 'Status:' line, which IS changed. The delta then
  // fires (preBodyStatus ≠ postBodyStatus), the preservation guard is skipped, and
  // syncStateFrontmatter re-derives from the new body value as intended.
  test('(c) begin-phase changes body Status → frontmatter status reflects new body-derived value', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Frontmatter intentionally has NO 'status:' key so stateReplaceField targets the body
    // 'Status:' line. After the transform, body Status becomes "Executing Phase 3" →
    // normalizeStateStatus → 'executing' must be written to frontmatter.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Status: Ready to execute',
      'Last Activity: 2026-01-01',
      'Current Phase: 2',
      'Current Phase Name: Planning',
      'Current Plan: 1',
      '',
      '## Current Position',
      '',
      'Phase: 2 (Planning) — READY',
      'Plan: 1 of 1',
      'Status: Ready to execute',
      'Last activity: 2026-01-01 -- Phase 2 planning complete',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(
      ['state', 'begin-phase', '--phase', '3', '--name', 'Execution'],
      tmpDir,
    );
    assert.ok(result.success, `begin-phase failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    // begin-phase changed body Status to "Executing Phase 3" → delta fired → re-derived → 'executing'
    assert.strictEqual(
      rawFm.status,
      'executing',
      `frontmatter status must be updated to 'executing' when begin-phase changes body Status; got: ${JSON.stringify(rawFm.status)}`,
    );
  });

  // (d) stopped_at: TRUE RED — frontmatter stopped_at preserved when body Stopped at differs
  //
  // Change C: this is a TRUE regression guard. Frontmatter stopped_at ("Phase 7 verified PASS")
  // differs from the body ## Session "Stopped at:" value ("Phase 3 work"). The write operation
  // (add-decision) does NOT touch the Session Stopped at line. The delta heuristic must detect
  // that the Session Stopped at did NOT change (pre == post == "Phase 3 work") and therefore
  // preserve the frontmatter value "Phase 7 verified PASS". Pre-fix code would REVERT to
  // "Phase 3 work" (the body-derived value) — making this a genuine red.
  test('(d) add-decision preserves frontmatter stopped_at when body Session Stopped at differs from frontmatter and is unchanged', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'status: completed',
      'stopped_at: "Phase 7 verified PASS"',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Status: Phase 3 complete',
      'Last Activity: 2026-01-01',
      'Current Phase: 3',
      '',
      '## Session',
      '',
      '**Last session:** 2026-01-01T00:00:00.000Z',
      // body Session Stopped at is STALE (different from frontmatter stopped_at)
      '**Stopped at:** Phase 3 work',
      '**Resume file:** None',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // add-decision does NOT touch ## Session Stopped at → pre and post body value identical
    // ("Phase 3 work" unchanged) → delta fires → frontmatter "Phase 7 verified PASS" preserved.
    const result = runGsdTools(
      ['state', 'add-decision', '--phase', '3', '--summary', 'Preserve stopped_at check'],
      tmpDir,
    );
    assert.ok(result.success, `add-decision failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.stopped_at,
      'Phase 7 verified PASS',
      `frontmatter stopped_at must be preserved ("Phase 7 verified PASS") when body Session Stopped at ` +
      `is unchanged (stale "Phase 3 work"); got: ${JSON.stringify(rawFm.stopped_at)}`,
    );
  });

  // (f) PRODUCTION-PATH: legitimate status transition is NOT frozen by the delta heuristic.
  //
  // Change A: prove that begin-phase on a STATE.md with inline "Status: Executing Phase 1"
  // (the standard template format) correctly transitions frontmatter status from
  // 'executing' to a new 'executing' value when the body Status CHANGES.
  // More critically: also verify a complete-phase → frontmatter becomes 'completed'
  // when the body Status field IS changed. This locks in that the delta heuristic
  // re-derives correctly whenever the body's Status source field actually changes.
  test('(f) begin-phase changes inline body Status → delta fires → frontmatter status updated (not frozen)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    // Realistic STATE.md: frontmatter status: executing, body Status: Executing Phase 1 (inline format)
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'status: executing',
      'current_phase: 1',
      'current_phase_name: Planning',
      'current_plan: 1',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Status: Executing Phase 1',
      'Last Activity: 2026-01-01',
      'Current Phase: 1',
      'Current Phase Name: Planning',
      'Current Plan: 1',
      'Total Plans in Phase: 2',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // begin-phase 2 changes body Status from "Executing Phase 1" to "Executing Phase 2"
    // → pre and post body Status differ → delta does NOT fire → syncStateFrontmatter
    // re-derives status from new body value → frontmatter status must reflect 'executing'
    // (still 'executing' after begin-phase 2 is a correct transition).
    const beginResult = runGsdTools(
      ['state', 'begin-phase', '--phase', '2', '--name', 'Implementation'],
      tmpDir,
    );
    assert.ok(beginResult.success, `state begin-phase failed: ${beginResult.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    // Frontmatter status must have been updated (not frozen at original 'executing' for phase 1).
    // After begin-phase 2, body Status becomes "Executing Phase 2" → re-derived → still 'executing'
    // but it must NOT be the stale body-derived value from before the transform; the key check is
    // that the write completed successfully and status is a known valid value.
    assert.ok(
      rawFm.status === 'executing',
      `frontmatter status must be 'executing' after begin-phase 2 (delta fires, re-derived); got: ${JSON.stringify(rawFm.status)}`,
    );

    // Stronger check: if we then run a command that changes Status to a DIFFERENT value,
    // the frontmatter MUST reflect the new body-derived status (not be frozen).
    // Use state update to change Status to "Phase 2 complete" → derives 'completed'.
    const updateResult = runGsdTools(
      ['state', 'update', 'Status', 'Phase 2 complete'],
      tmpDir,
    );
    assert.ok(updateResult.success, `state update Status failed: ${updateResult.error}`);

    const written2 = fs.readFileSync(statePath, 'utf8');
    const rawFm2 = parseFrontmatter(written2);
    assert.strictEqual(
      rawFm2.status,
      'completed',
      `frontmatter status must be 'completed' after body Status → 'Phase 2 complete' (delta fires, re-derived); ` +
      `got: ${JSON.stringify(rawFm2.status)}. The delta heuristic must NOT freeze status when the body field changes.`,
    );
  });

  // (e) milestone-switch uses platformWriteSync directly (not RMW) — check it still resets status correctly
  test('(e) milestone-switch still resets frontmatter status to planning (uses writeStateMd path, not RMW)', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, buildStateMd1230({ fmStatus: 'completed', bodyStatus: 'Phase 3 complete' }));
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v2.0 Next\n\n### Phase 4: Next steps\n',
      'utf-8',
    );

    const result = runGsdTools(
      ['state', 'milestone-switch', '--milestone', 'v2.0', '--name', 'Next'],
      tmpDir,
    );
    assert.ok(result.success, `milestone-switch failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf8');
    const rawFm = parseFrontmatter(written);
    assert.strictEqual(
      rawFm.status,
      'planning',
      `milestone-switch must reset frontmatter status to 'planning'; got: ${JSON.stringify(rawFm.status)}`,
    );
  });
});
