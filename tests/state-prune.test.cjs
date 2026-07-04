/**
 * Tests for `state prune` command (#1970).
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { sliceCurrentPositionSection } = require('../gsd-core/bin/lib/state-transition.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');

function writeStateMd(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);
}

function readStateMd(tmpDir) {
  return fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
}

function archiveExists(tmpDir) {
  return fs.existsSync(path.join(tmpDir, '.planning', 'STATE-ARCHIVE.md'));
}

function readArchive(tmpDir) {
  return fs.readFileSync(path.join(tmpDir, '.planning', 'STATE-ARCHIVE.md'), 'utf-8');
}

describe('state prune (#1970)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('prunes decisions older than cutoff', () => {
    writeStateMd(tmpDir, [
      '# Session State',
      '',
      '**Current Phase:** 10',
      '',
      '## Decisions',
      '',
      '- [Phase 1]: Old decision',
      '- [Phase 3]: Old decision 3',
      '- [Phase 8]: Recent decision',
      '- [Phase 10]: Current decision',
      '',
    ].join('\n'));

    const result = runGsdTools('state prune --keep-recent 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.pruned, true);
    assert.strictEqual(output.cutoff_phase, 7);

    const newState = readStateMd(tmpDir);
    assert.match(newState, /\[Phase 8\]: Recent decision/);
    assert.match(newState, /\[Phase 10\]: Current decision/);
    assert.doesNotMatch(newState, /\[Phase 1\]: Old decision/);
    assert.doesNotMatch(newState, /\[Phase 3\]: Old decision 3/);

    assert.ok(archiveExists(tmpDir), 'STATE-ARCHIVE.md should exist');
    const archive = readArchive(tmpDir);
    assert.match(archive, /\[Phase 1\]: Old decision/);
    assert.match(archive, /\[Phase 3\]: Old decision 3/);
  });

  test('--dry-run reports what would be pruned without modifying STATE.md', () => {
    const originalContent = [
      '# Session State',
      '',
      '**Current Phase:** 10',
      '',
      '## Decisions',
      '',
      '- [Phase 1]: Old decision',
      '- [Phase 2]: Another old decision',
      '- [Phase 9]: Recent decision',
      '',
    ].join('\n');
    writeStateMd(tmpDir, originalContent);

    const result = runGsdTools('state prune --keep-recent 3 --dry-run', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.pruned, false);
    assert.strictEqual(output.dry_run, true);
    assert.strictEqual(output.total_would_archive, 2);

    // STATE.md should be unchanged
    const unchanged = readStateMd(tmpDir);
    assert.strictEqual(unchanged, originalContent);

    // No archive file should be created
    assert.ok(!archiveExists(tmpDir), 'dry-run should not create archive');
  });

  test('prunes resolved blockers older than cutoff', () => {
    writeStateMd(tmpDir, [
      '# Session State',
      '',
      '**Current Phase:** 10',
      '',
      '## Blockers',
      '',
      '- ~~Phase 1: Old resolved issue~~',
      '- [RESOLVED] Phase 2: Another old issue',
      '- Phase 9: Current blocker (unresolved)',
      '',
    ].join('\n'));

    const result = runGsdTools('state prune --keep-recent 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.pruned, true);
    const blockerSection = output.sections.find(s => /Blockers/i.test(s.section));
    assert.ok(blockerSection, 'should report Blockers section');
    assert.strictEqual(blockerSection.entries_archived, 2);

    const newState = readStateMd(tmpDir);
    assert.match(newState, /Phase 9: Current blocker/);
    assert.doesNotMatch(newState, /Phase 1: Old resolved issue/);
  });

  test('returns pruned:false when nothing to prune', () => {
    writeStateMd(tmpDir, [
      '# Session State',
      '',
      '**Current Phase:** 2',
      '',
      '## Decisions',
      '',
      '- [Phase 1]: Recent decision',
      '- [Phase 2]: Current decision',
      '',
    ].join('\n'));

    const result = runGsdTools('state prune --keep-recent 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.pruned, false);
  });

  describe('Performance Metrics table pruning (#2087)', () => {
    test('prunes old metric table rows by phase number', () => {
      writeStateMd(tmpDir, [
        '# Session State',
        '',
        '**Current Phase:** 10',
        '',
        '## Performance Metrics',
        '',
        '| Phase | Plans | Duration | Status |',
        '|-------|-------|----------|--------|',
        '| 1 | 3/3 | 2h | Complete |',
        '| 2 | 2/2 | 1h | Complete |',
        '| 3 | 4/4 | 3h | Complete |',
        '| 8 | 5/5 | 4h | Complete |',
        '| 9 | 2/2 | 1h | Complete |',
        '| 10 | 1/3 | - | In Progress |',
        '',
      ].join('\n'));

      const result = runGsdTools('state prune --keep-recent 3', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.pruned, true);

      const newState = readStateMd(tmpDir);
      // Should keep phases 8, 9, 10 (within keep-recent of phase 10, cutoff=7)
      assert.match(newState, /\| 8 \|/);
      assert.match(newState, /\| 9 \|/);
      assert.match(newState, /\| 10 \|/);
      // Should prune phases 1, 2, 3
      assert.doesNotMatch(newState, /\| 1 \|.*Complete/);
      assert.doesNotMatch(newState, /\| 2 \|.*Complete/);
      assert.doesNotMatch(newState, /\| 3 \|.*Complete/);
      // Header row should be preserved
      assert.match(newState, /\| Phase \| Plans \| Duration \| Status \|/);
      assert.match(newState, /\|-------|-------|----------|--------\|/);
    });

    test('--dry-run reports metrics rows that would be pruned', () => {
      writeStateMd(tmpDir, [
        '# Session State',
        '',
        '**Current Phase:** 8',
        '',
        '## Performance Metrics',
        '',
        '| Phase | Plans | Status |',
        '|-------|-------|--------|',
        '| 1 | 3/3 | Complete |',
        '| 2 | 2/2 | Complete |',
        '| 6 | 4/4 | Complete |',
        '| 7 | 2/2 | Complete |',
        '| 8 | 1/3 | In Progress |',
        '',
      ].join('\n'));

      const result = runGsdTools('state prune --keep-recent 3 --dry-run', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.dry_run, true);
      assert.ok(output.total_would_archive > 0, 'should report rows to archive');
      const metricsSection = output.sections.find(s => /Metrics/i.test(s.section));
      assert.ok(metricsSection, 'should include Performance Metrics section');
      assert.strictEqual(metricsSection.entries_would_archive, 2);
    });

    test('does not touch prose lines outside the metrics table', () => {
      writeStateMd(tmpDir, [
        '# Session State',
        '',
        '**Current Phase:** 10',
        '',
        '## Performance Metrics',
        '',
        'Overall project velocity is improving.',
        '',
        '| Phase | Plans | Status |',
        '|-------|-------|--------|',
        '| 1 | 3/3 | Complete |',
        '| 9 | 2/2 | Complete |',
        '| 10 | 1/3 | In Progress |',
        '',
        'Average duration: 2.5 hours per phase.',
        '',
      ].join('\n'));

      const result = runGsdTools('state prune --keep-recent 3', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const newState = readStateMd(tmpDir);
      assert.match(newState, /Overall project velocity is improving\./);
      assert.match(newState, /Average duration: 2\.5 hours per phase\./);
      assert.doesNotMatch(newState, /\| 1 \|/);
      assert.match(newState, /\| 9 \|/);
    });

    test('preserves table when no rows are old enough to prune', () => {
      writeStateMd(tmpDir, [
        '# Session State',
        '',
        '**Current Phase:** 5',
        '',
        '## Performance Metrics',
        '',
        '| Phase | Plans | Status |',
        '|-------|-------|--------|',
        '| 3 | 3/3 | Complete |',
        '| 4 | 2/2 | Complete |',
        '| 5 | 1/3 | In Progress |',
        '',
      ].join('\n'));

      const result = runGsdTools('state prune --keep-recent 3', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const newState = readStateMd(tmpDir);
      assert.match(newState, /\| 3 \|/);
      assert.match(newState, /\| 4 \|/);
      assert.match(newState, /\| 5 \|/);
    });
  });
});

// #1776 — `cmdStatePrune` resolved the current phase by extracting the `Phase`
// field over the WHOLE STATE.md; `stateExtractField`'s pipe-table fallback then
// matched any `| Phase | N |` row anywhere (e.g. a historical verification
// table), so a stale table cell drove the cutoff. The fix scopes the prose
// `Phase:` lookup to the canonical `## Current Position` section.
describe('#1776: prune reads the current phase only from ## Current Position', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  // hiSandog's fixture shape: an unrelated `| Phase | 2 |` verification table,
  // with the real position only in frontmatter (`current_phase: 12`) and NO
  // `Current Phase` body field / prose `Phase:` line. Pre-fix, prune ignored
  // frontmatter and `stateExtractField(body, 'Phase')` fell to the table cell →
  // currentPhase=2 → cutoff -1 → "Only 2 phases" bail. Post-fix it reads the
  // frontmatter phase and the table cell is never consulted.
  test('a stray | Phase | N | table does not override the canonical (frontmatter) phase', () => {
    writeStateMd(tmpDir, [
      '---',
      'gsd_state_version: 1.0',
      'current_phase: 12',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      '## Verification History',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| Phase | 2 |',
      '| Result | passed |',
      '',
      '## Decisions',
      '',
      '- [Phase 1]: Old decision',
      '- [Phase 4]: Mid decision',
      '- [Phase 11]: Recent decision',
      '',
    ].join('\n'));

    const result = runGsdTools('state prune --keep-recent 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);

    // Phase 12, keep-recent 3 → cutoff 9. If the table cell (2) had leaked, the
    // cutoff would be -1 and prune would bail "Only 2 phases — nothing to prune".
    assert.strictEqual(out.pruned, true, `expected prune to engage, got: ${JSON.stringify(out)}`);
    assert.strictEqual(out.cutoff_phase, 9);
  });

  // AC2 — template-conformant STATE.md (prose Phase under Current Position, no
  // stray table) is unchanged: prune still engages off the real phase.
  test('template-conformant Current Position (no stray table) still prunes', () => {
    writeStateMd(tmpDir, [
      '# GSD State',
      '',
      '## Current Position',
      '',
      'Phase: 10 of 15',
      '',
      '## Decisions',
      '',
      '- [Phase 1]: Old',
      '- [Phase 9]: Recent',
      '',
    ].join('\n'));

    const result = runGsdTools('state prune --keep-recent 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.cutoff_phase, 7);
  });

  // Boundary-containment property — the core scoping invariant: a `| Phase | N |`
  // row OUTSIDE the `## Current Position` section is never visible to extraction
  // scoped to that section. The section here carries NO `Phase:` line, so a
  // correct slice yields `null`; a whole-document leak would instead surface the
  // stray table cell (`stateExtractField`'s pipe-table fallback). The table is
  // placed both before and after the section to exercise both span boundaries.
  test('property: a | Phase | N | table outside Current Position is excluded from the scoped slice', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 998 }), // stray table phase
        fc.boolean(),                     // stray table before (true) or after (false) the section
        (stray, before) => {
          const table = ['## History', '', '| Field | Value |', '| --- | --- |', `| Phase | ${stray} |`, ''];
          const position = ['## Current Position', '', '**Status:** Executing', '']; // deliberately no `Phase:` line
          const body = ['# GSD State', '', ...(before ? [...table, ...position] : [...position, ...table])].join('\n');
          const section = sliceCurrentPositionSection(body);
          // Slice must exist and must NOT see the out-of-section table cell.
          return section !== null && stateExtractField(section, 'Phase') === null;
        }
      )
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1760-state-prune-noop-template-field.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1760-state-prune-noop-template-field (consolidation epic #1969 B2 #1971)", () => {
'use strict';
// Regression test for issue #1760 — `state prune` no-ops on template-conformant
// STATE.md because it reads `Current Phase` only, never the `Phase: X of Y` line
// the canonical template emits.
//
// ADR-1769 Phase 7 fix: derive the current phase with a `Phase` / `Current Phase`
// fallback (mirroring buildStateFrontmatter), so prune engages on template STATE.md.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function writeStateMd(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);
}

describe('#1760: state prune engages on template-conformant STATE.md (Phase: X of Y)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('prune engages when STATE.md uses "Phase: N of M" (no Current Phase field)', () => {
    // Template-conformant STATE.md: Current Position uses `Phase: 10 of 15`, and
    // there is NO `**Current Phase:**` body field. Pre-fix this made prune bail
    // with "Only 0 phases — nothing to prune".
    writeStateMd(tmpDir, [
      '# Session State',
      '',
      '## Current Position',
      '',
      'Phase: 10 of 15',
      'Plan: 2 of 4',
      'Status: Executing Phase 10',
      '',
      '## Decisions',
      '',
      '- [Phase 1]: Old decision',
      '- [Phase 3]: Older decision',
      '- [Phase 9]: Recent decision',
      '',
    ].join('\n'));

    const result = runGsdTools('state prune --keep-recent 3 --dry-run', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);

    // Pre-fix: { pruned: false, reason: 'Only 0 phases — nothing to prune...' }.
    // Post-fix: prune engages and reports a real cutoff_phase (10 - 3 = 7).
    assert.strictEqual(out.pruned, false, 'dry-run must report pruned:false');
    assert.ok(out.reason === undefined || !/Only 0 phases/i.test(String(out.reason)),
      `prune must not bail with "Only 0 phases" on template STATE.md; got reason=${JSON.stringify(out.reason)}`);
    assert.strictEqual(out.cutoff_phase, 7,
      `cutoff_phase must be 7 (current 10 - keep-recent 3); got ${JSON.stringify(out.cutoff_phase)}`);
  });

  test('prune still engages when "Current Phase:" IS present (no regression)', () => {
    writeStateMd(tmpDir, [
      '# Session State',
      '',
      '**Current Phase:** 10',
      '',
      '## Decisions',
      '',
      '- [Phase 1]: Old decision',
      '- [Phase 9]: Recent decision',
      '',
    ].join('\n'));

    const result = runGsdTools('state prune --keep-recent 3 --dry-run', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.cutoff_phase, 7);
  });
});
  });
}
