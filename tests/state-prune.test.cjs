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

// ────────────────────────────────────────────────────────────────────────
// #5831 — prune is lossless: the archive is written first, under the STATE.md
// lock, and rolled back to its exact previous bytes if STATE.md then fails.
// The archive append is asserted on its production plan (planStateArchiveAppend)
// and the writer through its I/O seam (it writes exactly what the renderer
// produces from that plan); the rollback invariant compares raw bytes; STATE.md
// entries are read through the pure prune transition.
// ────────────────────────────────────────────────────────────────────────
describe('#5831: state prune never loses entries', () => {
  const { mock } = require('node:test');
  const stateLib = require('../gsd-core/bin/lib/state.cjs');
  const scp = require('../gsd-core/bin/lib/shell-command-projection.cjs');
  const { transitionCore } = require('../gsd-core/bin/lib/state-transition.cjs');
  const { realClock } = require('../gsd-core/bin/lib/clock.cjs');
  const PINNED_DAY = '2026-11-08';
  function pinDay() { mock.method(realClock, 'localToday', () => PINNED_DAY); }
  const { makeFakeClock } = require('./helpers/clock.cjs');

  const PHASE1 = '- [Phase 1]: Decision one, only copy';
  const PHASE2 = '- [Phase 2]: Decision two, only copy';
  const PHASE4 = '- [Phase 4]: Decision four, only copy';
  const PHASE7 = '- [Phase 7]: Recent decision';
  const OLD_ENTRIES = [PHASE1, PHASE2, PHASE4];
  const ALL = 1000; // a cutoff that reaches every fixture entry
  const SEED_ARCHIVE = '# STATE Archive\n\nSeeded by the test.\n';

  function stateLines(currentPhase, decisions, eol = '\n') {
    return ['# Session State', '', `**Current Phase:** ${currentPhase}`, '', '## Decisions', '', ...decisions, ''].join(eol);
  }

  let tmpDir;
  let statePath;
  let archivePath;

  beforeEach(() => {
    tmpDir = createTempProject();
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    archivePath = path.join(tmpDir, '.planning', 'STATE-ARCHIVE.md');
    writeStateMd(tmpDir, stateLines(8, [...OLD_ENTRIES, PHASE7]));
    // A constant date: the production block heading and the expected one cannot straddle midnight.
    pinDay();
  });

  afterEach(() => {
    mock.restoreAll();
    stateLib._resetStateLockTestHooks();
    cleanup(tmpDir);
  });

  /** Sections the real prune transition would archive from STATE.md at `cutoff` (raw pruned lines). */
  function prunableRaw(cutoff = ALL) {
    const result = transitionCore(fs.readFileSync(statePath, 'utf-8'), { kind: 'prune', cutoff }, { clock: realClock });
    return result.data.archivedSections;
  }
  function prunable(cutoff = ALL) {
    return prunableRaw(cutoff).map(s => ({ section: s.section, lines: s.lines }));
  }

  function bytesOrNull(p) {
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }

  function prune(keepRecent) {
    stateLib.cmdStatePrune(tmpDir, { keepRecent: String(keepRecent), dryRun: false, silent: true }, true);
  }

  /**
   * Record every archive write at the platformWriteSync seam: the text handed
   * to the writer, the archive text it replaced, and the bytes it published.
   */
  function captureArchiveWrites() {
    const writes = [];
    const realPws = scp.platformWriteSync;
    mock.method(scp, 'platformWriteSync', (p, content, ...rest) => {
      if (p !== archivePath) return realPws.call(scp, p, content, ...rest);
      const prior = bytesOrNull(archivePath);
      // `state`: the STATE.md bytes the run pruned (the lock is held, so they are still on disk).
      const write = { content, prior: prior === null ? null : prior.toString('utf-8'), state: fs.readFileSync(statePath), after: null };
      writes.push(write);
      realPws.call(scp, p, content, ...rest);
      write.after = fs.readFileSync(archivePath); // the bytes as published
    });
    return writes;
  }

  /** The production plan for an append of `sections` (the entries actually written) onto `prior` (null = absent archive). */
  function planFor(prior, sections, cutoff, keepRecent) {
    return stateLib.planStateArchiveAppend(prior, sections, { date: PINNED_DAY, cutoff, keepRecent });
  }

  /** Assert a captured write is exactly the rendered production plan, and return that plan. */
  function assertWriteIsPlan(write, sections, cutoff, keepRecent) {
    const plan = planFor(write.prior, sections, cutoff, keepRecent);
    assert.strictEqual(write.content, stateLib.renderStateArchiveAppend(plan), 'the writer writes the rendered plan');
    return plan;
  }

  // The seam writes temp files through an exclusively-created descriptor
  // (`fs.writeFileSync(fd, ...)`), so a mock that matches by path resolves the
  // descriptor back to the path it was opened under.
  const openedPaths = new Map();
  function pathOf(target) {
    return typeof target === 'number' ? openedPaths.get(target) : target;
  }
  function trackOpenedPaths() {
    const realOpen = fs.openSync;
    mock.method(fs, 'openSync', (p, ...rest) => {
      const fd = realOpen.call(fs, p, ...rest);
      if (typeof p === 'string') openedPaths.set(fd, p);
      return fd;
    });
  }

  /**
   * Make writes to paths under `prefix` throw `code`; `before(p)` runs first
   * (e.g. to truncate the target the way a direct-write fallback would).
   */
  function failWritesTo(prefix, code, before = () => {}) {
    const realWrite = fs.writeFileSync;
    trackOpenedPaths();
    mock.method(fs, 'writeFileSync', (p, ...rest) => {
      const target = pathOf(p);
      if (typeof target === 'string' && target.startsWith(prefix)) {
        before(target, realWrite);
        const err = new Error(`${code}: simulated write failure`);
        err.code = code;
        throw err;
      }
      return realWrite.call(fs, p, ...rest);
    });
  }

  /** Files in .planning/ other than STATE.md, the archive and the lock: temp-file leftovers. */
  function planningLeftovers() {
    const keep = new Set([path.basename(statePath), path.basename(archivePath), path.basename(statePath) + '.lock']);
    return fs.readdirSync(path.dirname(statePath)).filter(f => !keep.has(f) && /\.(tmp|restore)\.\d+(\.[0-9a-f]{12})?$/.test(f));
  }

  /** How many archive lines are exactly `line`. */
  function archiveCount(line) {
    return fs.readFileSync(archivePath, 'utf-8').split(/\r?\n/).filter(l => l === line).length;
  }

  function assertArchivedOnce(lines) {
    assert.deepStrictEqual(lines.map(archiveCount), lines.map(() => 1), 'each entry is in the archive exactly once');
  }

  function lockReleased() {
    return !fs.existsSync(statePath + '.lock');
  }

  // ── archive write fails: nothing changes ───────────────────────────────

  test('an archive that cannot be read fails the prune and leaves both files untouched', () => {
    fs.mkdirSync(archivePath); // a directory in place of the archive
    const stateBefore = fs.readFileSync(statePath);

    const result = runGsdTools('state prune --keep-recent 3', tmpDir);
    assert.notStrictEqual(result.exitCode, 0, 'prune must exit non-zero');
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md bytes unchanged');
    assert.strictEqual(fs.statSync(archivePath).isDirectory(), true, 'the archive path is untouched');
    assert.ok(lockReleased(), 'the STATE.md lock is released');
  });

  for (const archiveBefore of ['absent', 'present']) {
    test(`a failed archive write (archive ${archiveBefore}) leaves both files untouched and releases the lock`, () => {
      if (archiveBefore === 'present') fs.writeFileSync(archivePath, SEED_ARCHIVE);
      const stateBefore = fs.readFileSync(statePath);
      const archiveBytes = bytesOrNull(archivePath);

      failWritesTo(archivePath, 'EIO');
      assert.throws(() => prune(3), (err) => err.code === 'EIO');
      mock.restoreAll();
      pinDay();

      assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md bytes unchanged');
      assert.deepStrictEqual(bytesOrNull(archivePath), archiveBytes, 'archive bytes unchanged / still absent');
      assert.ok(lockReleased(), 'the STATE.md lock is released');
    });
  }

  // ── STATE.md write fails after the archive write: rollback ──────────────

  const ROLLBACK_CASES = [
    { label: 'LF, archive absent', eol: '\n', archive: null },
    { label: 'LF, archive present', eol: '\n', archive: SEED_ARCHIVE },
    { label: 'CRLF, archive absent', eol: '\r\n', archive: null },
    { label: 'CRLF, archive present', eol: '\r\n', archive: SEED_ARCHIVE },
    { label: 'LF, non-empty CRLF archive', eol: '\n', archive: '# STATE Archive\r\n\r\n## Pruned 2026-01-01 (phases 1-0, kept recent 3)\r\n\r\n### Decisions\r\n\r\n- [Phase 0]: x\r\n' },
  ];
  for (const c of ROLLBACK_CASES) {
    test(`a failed STATE.md write restores the archive byte-for-byte, and the retry archives once (${c.label})`, () => {
      writeStateMd(tmpDir, stateLines(8, [...OLD_ENTRIES, PHASE7], c.eol));
      if (c.archive !== null) fs.writeFileSync(archivePath, c.archive);
      const stateBefore = fs.readFileSync(statePath);
      const archiveBytes = bytesOrNull(archivePath);

      failWritesTo(statePath, 'ENOSPC');
      assert.throws(() => prune(3), (err) => err.code === 'ENOSPC');
      mock.restoreAll();
      pinDay();

      assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md bytes unchanged');
      assert.deepStrictEqual(bytesOrNull(archivePath), archiveBytes, 'archive restored exactly / removed again');
      assert.ok(lockReleased(), 'the STATE.md lock is released');

      const sections = prunableRaw(5);
      const writes = captureArchiveWrites();
      prune(3);
      assert.strictEqual(writes.length, 1, 'the retry writes the archive once');
      const plan = assertWriteIsPlan(writes[0], sections, 5, 3);
      assert.deepStrictEqual(plan.block.sections.map(s => s.lines.length), [OLD_ENTRIES.length], 'each entry planned exactly once');
      assert.deepStrictEqual(prunable(5), [], 'every old entry left STATE.md');
      assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE7] }]);
    });
  }

  test('when the restore write fails partway, the error carries both causes, no temp file is left, and the retry archives once', () => {
    fs.writeFileSync(archivePath, SEED_ARCHIVE);
    const stateBefore = fs.readFileSync(statePath);
    const writes = captureArchiveWrites();

    const realWrite = fs.writeFileSync;
    trackOpenedPaths();
    mock.method(fs, 'writeFileSync', (p, data, ...rest) => {
      const fail = (code) => { const e = new Error(`${code}: simulated`); e.code = code; throw e; };
      const target = pathOf(p);
      if (typeof target === 'string' && target.startsWith(statePath)) fail('ENOSPC');
      if (typeof target === 'string' && target.startsWith(archivePath + '.restore.')) {
        realWrite.call(fs, p, data.subarray(0, 4)); // the temp file exists, partly written
        fail('EIO');
      }
      return realWrite.call(fs, p, data, ...rest);
    });
    let thrown = null;
    try { prune(3); } catch (err) { thrown = err; }
    mock.restoreAll();
    pinDay();

    assert.ok(thrown instanceof AggregateError, 'a combined error is thrown');
    assert.deepStrictEqual(thrown.errors.map(e => e.code), ['ENOSPC', 'EIO'], 'both the STATE.md and the restore cause');
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md still holds every entry');
    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(fs.readFileSync(archivePath), writes[0].after, 'the archive keeps the published block');
    assert.deepStrictEqual(planningLeftovers(), [], 'the partial restore temp file is removed');
    assert.ok(lockReleased(), 'the STATE.md lock is released');

    prune(3);
    assert.strictEqual(writes.length, 1, 'the retry recognises the published block and does not write the archive');
    assertArchivedOnce(OLD_ENTRIES);
    assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE7] }], 'the retry removed the entries from STATE.md');
  });

  for (const step of ['rename', 'removal']) {
    test(`when the restore ${step} fails, the error carries both causes`, () => {
      if (step === 'rename') fs.writeFileSync(archivePath, SEED_ARCHIVE);
      failWritesTo(statePath, 'ENOSPC');
      if (step === 'rename') {
        const realRename = fs.renameSync;
        mock.method(fs, 'renameSync', (from, ...rest) => {
          if (typeof from === 'string' && from.startsWith(archivePath + '.restore.')) {
            const e = new Error('EIO: simulated'); e.code = 'EIO'; throw e;
          }
          return realRename.call(fs, from, ...rest);
        });
      } else {
        const realRm = fs.rmSync;
        mock.method(fs, 'rmSync', (p, ...rest) => {
          if (p === archivePath) { const e = new Error('EIO: simulated'); e.code = 'EIO'; throw e; }
          return realRm.call(fs, p, ...rest);
        });
      }
      let thrown = null;
      try { prune(3); } catch (err) { thrown = err; }
      mock.restoreAll();
      pinDay();

      assert.ok(thrown instanceof AggregateError, 'a combined error is thrown');
      assert.deepStrictEqual(thrown.errors.map(e => e.code), ['ENOSPC', 'EIO']);
      assert.deepStrictEqual(prunable(5), [{ section: 'Decisions', lines: OLD_ENTRIES }], 'STATE.md still holds every entry');
      assert.ok(lockReleased(), 'the STATE.md lock is released');
    });
  }

  // ── STATE.md damaged by its failed write: put it back, then roll back ──

  /**
   * Make the STATE.md write (temp file or direct) damage STATE.md and fail;
   * writes of the restore temp file go through unless `failRestore`.
   */
  function damagingStateWrite(damage, failRestore = false) {
    const realWrite = fs.writeFileSync;
    trackOpenedPaths();
    mock.method(fs, 'writeFileSync', (p, ...rest) => {
      const fail = (code) => { const e = new Error(`${code}: simulated`); e.code = code; throw e; };
      const target = pathOf(p);
      if (target === statePath || (typeof target === 'string' && target.startsWith(statePath + '.tmp.'))) {
        if (damage === 'truncated') realWrite.call(fs, statePath, '');
        else if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
        fail('ENOSPC');
      }
      if (failRestore && typeof target === 'string' && target.startsWith(statePath + '.restore.')) fail('EIO');
      return realWrite.call(fs, p, ...rest);
    });
  }

  for (const damage of ['truncated', 'removed']) {
    test(`a STATE.md write that ${damage} STATE.md before failing is undone: STATE.md and the archive are as before`, () => {
      writeStateMd(tmpDir, stateLines(8, [...OLD_ENTRIES, PHASE7]) + '\n## Notes\n\nunpruned notes\n');
      fs.writeFileSync(archivePath, SEED_ARCHIVE);
      const stateBefore = fs.readFileSync(statePath);
      const writes = captureArchiveWrites();
      damagingStateWrite(damage);
      assert.throws(() => prune(3), (err) => err.code === 'ENOSPC' && !(err instanceof AggregateError),
        'the original STATE.md error propagates');
      mock.restoreAll();
      pinDay();

      assert.strictEqual(writes.length, 1, 'the archive was published before the STATE.md write');
      assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md is byte-identical, kept entries and notes included');
      assert.strictEqual(fs.readFileSync(archivePath, 'utf-8'), SEED_ARCHIVE, 'the archive is restored');
      assert.deepStrictEqual(planningLeftovers(), []);
      assert.ok(lockReleased(), 'the STATE.md lock is released');
    });
  }

  test('when STATE.md cannot be put back after a damaging write, both causes surface and the archive is kept', () => {
    const writes = captureArchiveWrites();
    damagingStateWrite('truncated', true);
    let thrown = null;
    try { prune(3); } catch (err) { thrown = err; }
    mock.restoreAll();
    pinDay();

    assert.ok(thrown instanceof AggregateError, 'a combined error is thrown');
    assert.deepStrictEqual(thrown.errors.map(e => e.code), ['ENOSPC', 'EIO']);
    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(fs.readFileSync(archivePath), writes[0].after,
      'the archive is left exactly as published — it holds the only copy of the pruned entries');
    assertWriteIsPlan(writes[0], prunableRawFrom(stateLines(8, [...OLD_ENTRIES, PHASE7]), 5), 5, 3);
    assert.deepStrictEqual(planningLeftovers(), []);
    assert.ok(lockReleased(), 'the STATE.md lock is released');
  });

  function prunableRawFrom(content, cutoff) {
    return transitionCore(content, { kind: 'prune', cutoff }, { clock: realClock }).data.archivedSections;
  }

  test('when STATE.md cannot be re-read after its failed write, both causes surface and the archive is kept', () => {
    const writes = captureArchiveWrites();
    let stateWriteFailed = false;
    failWritesTo(statePath, 'ENOSPC', () => { stateWriteFailed = true; });
    const realRead = fs.readFileSync;
    mock.method(fs, 'readFileSync', (p, ...rest) => {
      if (stateWriteFailed && pathOf(p) === statePath) { const e = new Error('EIO: simulated read'); e.code = 'EIO'; throw e; }
      return realRead.call(fs, p, ...rest);
    });
    let thrown = null;
    try { prune(3); } catch (err) { thrown = err; }
    mock.restoreAll();
    pinDay();

    assert.ok(thrown instanceof AggregateError, 'a combined error is thrown');
    assert.deepStrictEqual(thrown.errors.map(e => e.code), ['ENOSPC', 'EIO'], 'the STATE.md write cause and the re-read cause');
    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(realRead.call(fs, archivePath), writes[0].after, 'the archive is left as published');
    assert.ok(lockReleased(), 'the STATE.md lock is released');
  });

  // ── hostile archive: a file swapped in after the snapshot ──
  // (the link-and-pipe archive rows live in tests/config-loader-bounded-read.platform.test.cjs)

  test('a rollback does not delete a file that replaced the archive after this run created it', () => {
    const foreign = 'FOREIGN archive, not created by this prune\n';
    let swapped = false;
    failWritesTo(statePath, 'ENOSPC', () => {
      if (swapped) return;
      swapped = true;
      // Created while the archive still exists, so it has a different inode.
      const incoming = path.join(tmpDir, '.planning', 'incoming-archive');
      fs.writeFileSync(incoming, foreign);
      fs.renameSync(incoming, archivePath);
    });
    let thrown = null;
    try { prune(3); } catch (err) { thrown = err; }
    mock.restoreAll();
    pinDay();

    assert.ok(thrown instanceof AggregateError, 'the refused rollback is reported alongside the STATE.md error');
    assert.strictEqual(thrown.errors[0].code, 'ENOSPC');
    assert.strictEqual(fs.readFileSync(archivePath, 'utf-8'), foreign, 'the foreign file is left in place');
    assert.ok(lockReleased(), 'the STATE.md lock is released');
  });

  // ── ordering, contention, occurrences, boundary, dry-run ───────────────

  test('the archive is written while the STATE.md lock is held and before STATE.md changes', () => {
    const stateBefore = fs.readFileSync(statePath);
    const observed = [];
    const realWrite = fs.writeFileSync;
    trackOpenedPaths();
    mock.method(fs, 'writeFileSync', (p, ...rest) => {
      const target = pathOf(p);
      if (typeof target === 'string' && target.startsWith(archivePath)) {
        observed.push({ lockHeld: fs.existsSync(statePath + '.lock'), stateUnchanged: fs.readFileSync(statePath).equals(stateBefore) });
      }
      return realWrite.call(fs, p, ...rest);
    });
    prune(3);
    mock.restoreAll();
    pinDay();

    assert.ok(observed.length > 0, 'prune must write the archive');
    assert.deepStrictEqual(observed, observed.map(() => ({ lockHeld: true, stateUnchanged: true })));
  });

  test('a prune contending for the STATE.md lock touches the archive only after the holder releases it', () => {
    // Drive the lock's backoff through a fake clock: no real sleep.
    const fake = makeFakeClock(1_700_000_000_000);
    mock.method(realClock, 'now', () => fake.now());
    mock.method(realClock, 'sleep', (ms) => fake.sleep(ms));

    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, String(process.pid)); // a live holder: never stolen
    const sectionsHolder = prunableRaw(3);

    const archiveAccess = [];
    const realRead = fs.readFileSync;
    const realWrite = fs.writeFileSync;
    trackOpenedPaths();
    mock.method(fs, 'readFileSync', (p, ...rest) => {
      if (typeof pathOf(p) === 'string' && pathOf(p).startsWith(archivePath)) archiveAccess.push('read');
      return realRead.call(fs, p, ...rest);
    });
    mock.method(fs, 'writeFileSync', (p, ...rest) => {
      if (typeof pathOf(p) === 'string' && pathOf(p).startsWith(archivePath)) archiveAccess.push('write');
      return realWrite.call(fs, p, ...rest);
    });
    const writes = captureArchiveWrites();

    let accessWhileHeld = null;
    stateLib._setStateLockTestHooks({
      onLoopIteration: ({ iteration }) => {
        if (accessWhileHeld !== null || iteration < 1) return;
        accessWhileHeld = archiveAccess.slice();
        // The holder is itself a prune (cutoff 3): it finishes and releases.
        fs.unlinkSync(lockPath);
        prune(5);
      },
    });

    prune(3); // cutoff 5, computed before it waits

    assert.ok(fake.sleepCalls.length >= 1, 'the contending prune backed off on the held lock');
    assert.deepStrictEqual(accessWhileHeld, [], 'no archive read or write while another prune holds the lock');
    assert.strictEqual(writes.length, 2);
    const holderPlan = assertWriteIsPlan(writes[0], sectionsHolder, 3, 5);
    const waiterPlan = assertWriteIsPlan(writes[1], [{ section: 'Decisions', count: 1, lines: [PHASE4] }], 5, 3);
    assert.strictEqual(writes[0].prior, null, 'the holder created the archive');
    assert.notStrictEqual(writes[1].prior, null, 'the waiter appended onto the holder\'s archive');
    assert.deepStrictEqual([...holderPlan.block.sections, ...waiterPlan.block.sections].flatMap(s => s.lines), OLD_ENTRIES,
      'the union of both cutoffs, each entry once');
    assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE7] }]);
  });

  test('an identical entry pruned again at the same cutoff is removed from STATE.md and not archived a second time', () => {
    writeStateMd(tmpDir, stateLines(8, [PHASE1, PHASE7]));
    const writes = captureArchiveWrites();
    prune(3);
    const archiveAfterFirst = fs.readFileSync(archivePath);
    writeStateMd(tmpDir, stateLines(8, [PHASE1, PHASE7])); // the same decision text lands again
    prune(3);

    assert.strictEqual(writes.length, 1, 'only the first prune writes the archive');
    assertWriteIsPlan(writes[0], [{ section: 'Decisions', count: 1, lines: [PHASE1] }], 5, 3);
    assert.deepStrictEqual(fs.readFileSync(archivePath), archiveAfterFirst, 'the archive is unchanged by the second prune');
    assert.strictEqual(archiveCount(PHASE1), 1, 'the identical text is already archived');
    assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE7] }], 'the entry left STATE.md');
  });

  test('an archive without a trailing newline gets a clean block boundary', () => {
    const prev = SEED_ARCHIVE + 'hand-edited note without a newline';
    fs.writeFileSync(archivePath, prev);
    const sections = prunableRaw(5);
    const writes = captureArchiveWrites();
    prune(3);

    assert.strictEqual(writes.length, 1);
    const plan = assertWriteIsPlan(writes[0], sections, 5, 3);
    assert.strictEqual(plan.base, prev, 'the existing text is kept as-is');
    assert.strictEqual(plan.boundary, '\n\n', 'a separator puts the new heading on its own line');
    assert.strictEqual(planFor(SEED_ARCHIVE, sections, 5, 3).boundary, '', 'no separator when the archive ends with a newline');
  });

  test('--dry-run writes neither STATE.md nor the archive', () => {
    const stateBefore = fs.readFileSync(statePath);
    const result = runGsdTools('state prune --keep-recent 3 --dry-run', tmpDir);
    assert.ok(result.success, `dry-run failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.dry_run, true);
    assert.strictEqual(out.total_would_archive, OLD_ENTRIES.length);
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md bytes unchanged');
    assert.strictEqual(archiveExists(tmpDir), false, 'dry-run must not create STATE-ARCHIVE.md');
  });

  // ── the archive write itself fails partway: earlier entries survive ────

  for (const archiveBefore of ['present', 'absent']) {
    test(`a temp-file write failure never reaches the archive through a truncating direct write (archive ${archiveBefore})`, () => {
      if (archiveBefore === 'present') fs.writeFileSync(archivePath, SEED_ARCHIVE);
      const stateBefore = fs.readFileSync(statePath);
      const archiveBytes = bytesOrNull(archivePath);

      // Every archive write fails on a full disk; a write to the archive
      // itself (the direct-write fallback) truncates it before failing.
      failWritesTo(archivePath, 'ENOSPC', (p, realWrite) => { if (p === archivePath) realWrite.call(fs, p, ''); });
      assert.throws(() => prune(3), (err) => err.code === 'ENOSPC');
      mock.restoreAll();
      pinDay();

      assert.deepStrictEqual(bytesOrNull(archivePath), archiveBytes, 'the archive keeps its exact previous bytes / stays absent');
      assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md bytes unchanged');
      assert.deepStrictEqual(planningLeftovers(), [], 'no temp file is left');
      assert.ok(lockReleased(), 'the STATE.md lock is released');
    });
  }

  test('an archive write that damages the archive and then throws is undone before the error propagates (archive present)', () => {
    fs.writeFileSync(archivePath, SEED_ARCHIVE);
    const stateBefore = fs.readFileSync(statePath);
    const archiveBytes = bytesOrNull(archivePath);
    const realPws = scp.platformWriteSync;
    mock.method(scp, 'platformWriteSync', (p, ...rest) => {
      if (p !== archivePath) return realPws.call(scp, p, ...rest);
      fs.writeFileSync(archivePath, 'half a bl'); // any write path that leaves the file damaged
      const e = new Error('EIO: simulated'); e.code = 'EIO'; throw e;
    });
    assert.throws(() => prune(3), (err) => err.code === 'EIO' && !(err instanceof AggregateError));
    mock.restoreAll();
    pinDay();

    assert.deepStrictEqual(bytesOrNull(archivePath), archiveBytes, 'the archive is put back exactly');
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md bytes unchanged');
    assert.ok(lockReleased(), 'the STATE.md lock is released');
  });

  // No archive existed before the run. One is there after the failed write, so it is not this run's: it is never deleted.
  test('a failed write leaves in place an archive that appeared while none existed before, and reports both causes (ESTALE)', () => {
    const stateBefore = fs.readFileSync(statePath);
    const realPws = scp.platformWriteSync;
    mock.method(scp, 'platformWriteSync', (p, content, opts, ...rest) => {
      if (p !== archivePath) return realPws.call(scp, p, content, opts, ...rest);
      fs.writeFileSync(archivePath, 'FOREIGN');
      const e = new Error('EIO: simulated'); e.code = 'EIO'; throw e;
    });
    let thrown = null;
    try { prune(3); } catch (err) { thrown = err; }
    mock.restoreAll();
    pinDay();

    assert.ok(thrown instanceof AggregateError, 'a combined error is thrown');
    assert.deepStrictEqual(thrown.errors.map(e => e.code), ['EIO', 'ESTALE']);
    assert.strictEqual(fs.readFileSync(archivePath, 'utf-8'), 'FOREIGN', 'the file that is not this run\'s is left in place');
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md bytes unchanged');
    assert.ok(lockReleased(), 'the STATE.md lock is released');
  });

  test('when undoing a damaging archive write also fails, both causes surface and STATE.md is untouched', () => {
    fs.writeFileSync(archivePath, SEED_ARCHIVE);
    const stateBefore = fs.readFileSync(statePath);
    const realPws = scp.platformWriteSync;
    mock.method(scp, 'platformWriteSync', (p, ...rest) => {
      if (p !== archivePath) return realPws.call(scp, p, ...rest);
      fs.writeFileSync(archivePath, 'half a bl');
      const e = new Error('EIO: simulated'); e.code = 'EIO'; throw e;
    });
    mock.method(scp, 'platformRestoreFileSync', () => { const e = new Error('EROFS: simulated'); e.code = 'EROFS'; throw e; });
    let thrown = null;
    try { prune(3); } catch (err) { thrown = err; }
    mock.restoreAll();
    pinDay();

    assert.ok(thrown instanceof AggregateError, 'a combined error is thrown');
    assert.deepStrictEqual(thrown.errors.map(e => e.code), ['EIO', 'EROFS']);
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md still holds every entry');
    assert.ok(lockReleased(), 'the STATE.md lock is released');
  });

  // ── a retry after a kill between the two writes is idempotent ──────────

  /**
   * The on-disk result of a prune killed after it published the archive and
   * before it wrote STATE.md: the archive holds the new block, STATE.md is
   * byte-for-byte what the run read. (The lock a killed process leaves is
   * stale-recovered separately; it is not what this pins.)
   */
  function pruneKilledBeforeStateWrite(keepRecent) {
    const stateBefore = fs.readFileSync(statePath);
    prune(keepRecent);
    fs.writeFileSync(statePath, stateBefore);
  }

  for (const archiveBefore of ['absent', 'present', 'present with an older block']) {
    test(`a prune re-run after a kill between the archive and STATE.md writes archives each entry once (archive ${archiveBefore})`, () => {
      if (archiveBefore === 'present') fs.writeFileSync(archivePath, SEED_ARCHIVE);
      if (archiveBefore === 'present with an older block') {
        // An archive that already holds an earlier prune's block.
        fs.writeFileSync(archivePath, '# STATE Archive\n\n## Pruned 2026-01-01 (phases 1-2, kept recent 3)\n\n### Decisions\n\n- [Phase 0]: older\n\n');
      }
      pruneKilledBeforeStateWrite(3);
      assert.deepStrictEqual(OLD_ENTRIES.map(archiveCount), [1, 1, 1], 'the killed run published its block');
      assert.deepStrictEqual(prunable(5), [{ section: 'Decisions', lines: OLD_ENTRIES }], 'STATE.md still holds the entries');
      const archiveAfterKill = fs.readFileSync(archivePath);

      const writes = captureArchiveWrites();
      prune(3);

      assert.strictEqual(writes.length, 0, 'the retry does not write the archive');
      assert.deepStrictEqual(fs.readFileSync(archivePath), archiveAfterKill, 'the archive is unchanged by the retry');
      assertArchivedOnce(OLD_ENTRIES);
      assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE7] }], 'the retry finished the prune');
    });
  }

  test('after a killed run and its retry, an identical entry pruned again later is removed from STATE.md and not archived a second time', () => {
    writeStateMd(tmpDir, stateLines(8, [PHASE1, PHASE7]));
    pruneKilledBeforeStateWrite(3);
    prune(3); // the retry
    writeStateMd(tmpDir, stateLines(8, [PHASE1, PHASE7])); // the same decision text lands again
    const writes = captureArchiveWrites();
    prune(3);

    assert.strictEqual(writes.length, 0, 'identical text already in the latest block is not written again');
    assert.strictEqual(archiveCount(PHASE1), 1, 'the entry is in the archive exactly once');
    assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE7] }], 'the entry left STATE.md');
  });

  test('a retry at a larger cutoff after a kill appends only the entries the first run did not archive', () => {
    const PHASE6 = '- [Phase 6]: Decision six, only copy';
    writeStateMd(tmpDir, stateLines(8, [PHASE1, PHASE2, PHASE4, PHASE6, PHASE7]));
    pruneKilledBeforeStateWrite(4); // cutoff 4 archives phases 1, 2, 4
    assertArchivedOnce(OLD_ENTRIES);
    const writes = captureArchiveWrites();
    prune(2); // cutoff 6 also reaches phase 6

    assert.strictEqual(writes.length, 1, 'the retry appends one block');
    const plan = assertWriteIsPlan(writes[0], [{ section: 'Decisions', count: 1, lines: [PHASE6] }], 6, 2);
    assert.deepStrictEqual(plan.block.sections, [{ section: 'Decisions', lines: [PHASE6] }], 'only the newly prunable entry');
    assertArchivedOnce([...OLD_ENTRIES, PHASE6]);
    assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE7] }], 'STATE.md holds only the kept entry');
  });

  /** How many `## Pruned` blocks the archive holds. */
  function archiveBlockCount() {
    return (fs.readFileSync(archivePath, 'utf-8').match(/^## Pruned /gm) || []).length;
  }

  test('a retry at a smaller cutoff after a kill completes the interrupted run: each entry is archived once, in one block', () => {
    const PHASE6 = '- [Phase 6]: Decision six, only copy';
    writeStateMd(tmpDir, stateLines(8, [PHASE1, PHASE2, PHASE4, PHASE6, PHASE7]));
    pruneKilledBeforeStateWrite(3); // cutoff 5 archives phases 1, 2, 4
    assertArchivedOnce(OLD_ENTRIES);
    const archiveAfterKill = fs.readFileSync(archivePath);
    const writes = captureArchiveWrites();
    prune(5); // cutoff 3 on its own would prune phases 1, 2 only

    assert.strictEqual(writes.length, 0, 'the interrupted run is completed without a second archive block');
    assert.deepStrictEqual(fs.readFileSync(archivePath), archiveAfterKill, 'the archive is unchanged by the retry');
    assertArchivedOnce(OLD_ENTRIES);
    assert.strictEqual(archiveBlockCount(), 1, 'one block holds these entries');
    assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE6, PHASE7] }], 'phase 4 left STATE.md with the block\'s other entries');
  });

  test('a retry at a smaller cutoff after a kill uses its own cutoff when the last block is not contained in STATE.md', () => {
    const PHASE6 = '- [Phase 6]: Decision six, only copy';
    writeStateMd(tmpDir, stateLines(8, [PHASE1, PHASE2, PHASE4, PHASE6, PHASE7]));
    pruneKilledBeforeStateWrite(3); // cutoff 5 archives phases 1, 2, 4
    writeStateMd(tmpDir, stateLines(8, [PHASE1, PHASE2, PHASE6, PHASE7])); // phase 4 is gone: the block is not contained
    const writes = captureArchiveWrites();
    prune(5); // cutoff 3

    assert.strictEqual(writes.length, 1, 'a separate block is written');
    assertWriteIsPlan(writes[0], [{ section: 'Decisions', count: 2, lines: [PHASE1, PHASE2] }], 3, 5);
    assert.strictEqual(archiveBlockCount(), 2, 'the kill\'s block and this run\'s own block');
    assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE6, PHASE7] }]);
    for (const entry of [PHASE1, PHASE2, PHASE4]) assert.ok(archiveCount(entry) >= 1, `${entry} is archived`);
  });

  test('a retry at a smaller cutoff does not adopt the block\'s cutoff when STATE.md gained an entry since the kill', () => {
    const PHASE5 = '- [Phase 5]: Decision five, only copy';
    pruneKilledBeforeStateWrite(3); // cutoff 5 archives phases 1, 2, 4
    writeStateMd(tmpDir, stateLines(8, [...OLD_ENTRIES, PHASE5, PHASE7])); // a new phase-5 entry lands
    const writes = captureArchiveWrites();
    prune(5); // cutoff 3: pruning at 5 would also take the new entry, which the block does not hold

    assert.strictEqual(writes.length, 1, 'a block is written at this run\'s own cutoff');
    assertWriteIsPlan(writes[0], [{ section: 'Decisions', count: 2, lines: [PHASE1, PHASE2] }], 3, 5);
    assert.strictEqual(archiveCount(PHASE5), 0, 'the new entry was not archived');
    assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE4, PHASE5, PHASE7] }], 'the new entry stays in STATE.md');
    for (const entry of OLD_ENTRIES) assert.ok(archiveCount(entry) >= 1, `${entry} is archived (nothing is lost)`);
  });

  test('a forged heading cutoff past the current phase is never adopted, even when its block equals the whole prune', () => {
    const forged = '# STATE Archive\n\n## Pruned 2026-01-01 (phases 1-999999, kept recent 3)\n\n### Decisions\n\n' +
      [...OLD_ENTRIES, PHASE7].join('\n') + '\n\n';
    fs.writeFileSync(archivePath, forged);
    const writes = captureArchiveWrites();
    prune(3); // cutoff 5, current phase 8

    assert.strictEqual(writes.length, 1, 'this run\'s own prune is appended');
    assertWriteIsPlan(writes[0], [{ section: 'Decisions', count: 3, lines: OLD_ENTRIES }], 5, 3);
    assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE7] }], 'the recent entry is not pruned');
  });

  test('--dry-run after a kill reports the adopted cutoff and the entries the real run then removes, and writes nothing', () => {
    pruneKilledBeforeStateWrite(3); // cutoff 5 archives phases 1, 2, 4
    const stateBefore = fs.readFileSync(statePath);
    const archiveBefore = fs.readFileSync(archivePath);
    const writes = captureArchiveWrites();
    const preview = stateLib.cmdStatePrune(tmpDir, { keepRecent: '5', dryRun: true, silent: true }, true); // cutoff 3

    assert.strictEqual(preview.dry_run, true);
    assert.strictEqual(preview.cutoff_phase, 5, 'the interrupted run\'s cutoff is reported');
    assert.strictEqual(preview.total_would_archive, OLD_ENTRIES.length, 'every entry the run removes from STATE.md is listed');
    assert.deepStrictEqual(preview.sections, [{ section: 'Decisions', entries_would_archive: OLD_ENTRIES.length }]);
    assert.strictEqual(writes.length, 0);
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md is untouched');
    assert.deepStrictEqual(fs.readFileSync(archivePath), archiveBefore, 'the archive is untouched');

    const real = stateLib.cmdStatePrune(tmpDir, { keepRecent: '5', dryRun: false, silent: true }, true);
    assert.strictEqual(real.total_archived, preview.total_would_archive, 'the real run reports the number the preview gave');
    assert.strictEqual(real.cutoff_phase, preview.cutoff_phase);
    assert.strictEqual(writes.length, 0, 'the real run writes no second block');
  });

  test('--dry-run without adoption (an entry was added after the kill) reports this run\'s own cutoff', () => {
    const PHASE5 = '- [Phase 5]: Decision five, only copy';
    pruneKilledBeforeStateWrite(3); // cutoff 5
    writeStateMd(tmpDir, stateLines(8, [...OLD_ENTRIES, PHASE5, PHASE7]));
    const stateBefore = fs.readFileSync(statePath);
    const archiveBefore = fs.readFileSync(archivePath);
    const preview = stateLib.cmdStatePrune(tmpDir, { keepRecent: '5', dryRun: true, silent: true }, true); // cutoff 3

    assert.strictEqual(preview.cutoff_phase, 3, 'the block is not adopted');
    assert.strictEqual(preview.total_would_archive, 2, 'phases 1 and 2');
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore);
    assert.deepStrictEqual(fs.readFileSync(archivePath), archiveBefore);
    const real = stateLib.cmdStatePrune(tmpDir, { keepRecent: '5', dryRun: false, silent: true }, true);
    assert.strictEqual(real.total_archived, preview.total_would_archive);
    assert.strictEqual(real.cutoff_phase, 3);
  });

  describe('adoption boundaries (current phase 8, this run at cutoff 3 or 5)', () => {
    const blockArchive = (n, lines) =>
      `# STATE Archive\n\n## Pruned 2026-01-01 (phases 1-${n}, kept recent 3)\n\n### Decisions\n\n${lines.join('\n')}\n\n`;

    test('N equal to this run\'s cutoff is not adopted, and the block it matches is not written again', () => {
      fs.writeFileSync(archivePath, blockArchive(3, [PHASE1, PHASE2]));
      const archiveBefore = fs.readFileSync(archivePath);
      const writes = captureArchiveWrites();
      prune(5); // cutoff 3 prunes phases 1, 2 = the block

      assert.strictEqual(writes.length, 0, 'no duplicate block');
      assert.deepStrictEqual(fs.readFileSync(archivePath), archiveBefore);
      assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE4, PHASE7] }], 'cutoff 3, not wider');
    });

    test('N equal to the current phase is adopted when the prune at N equals the block', () => {
      fs.writeFileSync(archivePath, blockArchive(8, [...OLD_ENTRIES, PHASE7]));
      const writes = captureArchiveWrites();
      const out = stateLib.cmdStatePrune(tmpDir, { keepRecent: '3', dryRun: false, silent: true }, true); // cutoff 5

      assert.strictEqual(writes.length, 0, 'the block already holds everything');
      assert.strictEqual(out.cutoff_phase, 8, 'N is adopted');
      assert.deepStrictEqual(prunable(), [], 'the whole prune at N left STATE.md');
    });

    test('N one past the current phase is not adopted', () => {
      fs.writeFileSync(archivePath, blockArchive(9, [...OLD_ENTRIES, PHASE7]));
      const writes = captureArchiveWrites();
      const out = stateLib.cmdStatePrune(tmpDir, { keepRecent: '3', dryRun: false, silent: true }, true); // cutoff 5

      assert.strictEqual(out.cutoff_phase, 5, 'this run\'s own cutoff');
      assert.strictEqual(writes.length, 1);
      assertWriteIsPlan(writes[0], [{ section: 'Decisions', count: 3, lines: OLD_ENTRIES }], 5, 3);
      assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE7] }], 'the recent entry stays');
    });
  });

  const sec = (section, lines) => ({ section, count: lines.length, lines });
  const blk = (section, lines) => ({ section, lines });

  test('subtractPendingBlock: exact, one extra pruned line, one block line missing, multiplicity, other section, null, CRLF', () => {
    const A = '- a';
    const B = '- b';
    const C = '- c';
    const sub = stateLib.subtractPendingBlock;

    assert.deepStrictEqual(sub([blk('Decisions', [A, B])], [sec('Decisions', [A, B])]), { pending: true, remainder: [] }, 'exact match');
    assert.deepStrictEqual(sub([blk('Decisions', [A, C])], [sec('Decisions', [A, B, C])]),
      { pending: true, remainder: [sec('Decisions', [B])] }, 'one extra pruned line');
    const missing = [sec('Decisions', [A, B])];
    const missingResult = sub([blk('Decisions', [A, B, C])], missing);
    assert.strictEqual(missingResult.pending, false, 'one block line missing from the prune');
    assert.strictEqual(missingResult.remainder, missing, 'remainder is the sections unchanged');

    assert.strictEqual(sub([blk('Decisions', [A, A])], [sec('Decisions', [A])]).pending, false, 'a block line twice, pruned once');
    assert.deepStrictEqual(sub([blk('Decisions', [A])], [sec('Decisions', [A, A])]),
      { pending: true, remainder: [sec('Decisions', [A])] }, 'a block line once, pruned twice');
    assert.strictEqual(sub([blk('Blockers', [A])], [sec('Decisions', [A])]).pending, false, 'the same line under a different section');
    assert.strictEqual(sub([blk('Decisions', [A]), blk('Blockers', [B])], [sec('Decisions', [A])]).pending, false,
      'a block section absent from the prune');

    const sections = [sec('Decisions', [A])];
    assert.deepStrictEqual(sub(null, sections), { pending: false, remainder: sections }, 'null block');
    assert.strictEqual(sub([], sections).pending, false, 'a block with no sections');
    assert.strictEqual(sub([blk('Decisions', [])], sections).pending, false, 'a block with no entries');

    assert.deepStrictEqual(sub([blk('Decisions', [`${A}\r`])], [sec('Decisions', [A])]), { pending: true, remainder: [] }, 'CRLF block line, LF pruned line');
    assert.deepStrictEqual(sub([blk('Decisions', [A])], [sec('Decisions', [`${A}\r`])]), { pending: true, remainder: [] }, 'LF block line, CRLF pruned line');
    assert.deepStrictEqual(sub([blk('Decisions', [A])], [sec('Decisions', [A, `${B}\r`])]),
      { pending: true, remainder: [sec('Decisions', [`${B}\r`])] }, 'remainder keeps the original line strings');

    assert.deepStrictEqual(
      sub([blk('Decisions', [A]), blk('Blockers', [B])], [sec('Decisions', [A]), sec('Blockers', [B, C])]),
      { pending: true, remainder: [sec('Blockers', [C])] },
      'sections with nothing left are dropped');
  });

  const parsedBlock = (cutoff, sections) => ({ cutoff, sections });

  test('parseLastArchiveBlock reads only the last block, with its heading cutoff', () => {
    const parse = stateLib.parseLastArchiveBlock;
    assert.strictEqual(parse(''), null, 'empty text');
    assert.strictEqual(parse('# STATE Archive\n\nno blocks\n'), null, 'no heading');
    assert.deepStrictEqual(parse('## Pruned x\n'), parsedBlock(null, []), 'a heading with no sections and no cutoff');

    const twoBlocks = '# STATE Archive\n\n## Pruned 1 (phases 1-1, kept recent 3)\n\n### Decisions\n\n- a\n\n' +
      '## Pruned 2 (phases 1-2, kept recent 3)\n\n### Decisions\n\n- b\n\n### Blockers\n\n- c\n- d\n\n';
    const last = parsedBlock(2, [blk('Decisions', ['- b']), blk('Blockers', ['- c', '- d'])]);
    assert.deepStrictEqual(parse(twoBlocks), last, 'only the last block');
    assert.deepStrictEqual(parse(twoBlocks.replace(/\n/g, '\r\n')), last, 'CRLF is stripped from the heading, sections and lines');

    assert.strictEqual(parse('## Pruned 2026-01-01 (kept recent 3)\n\n### Decisions\n\n- a\n').cutoff, null, 'a heading without (phases 1-N, has no cutoff');
    assert.strictEqual(parse('## Pruned x (phases 1-, kept recent 3)\n').cutoff, null, 'a heading with no digits has no cutoff');
    assert.strictEqual(parse('## Pruned x (phases 1-99999999999999999999, kept recent 3)\n').cutoff, null, 'an unsafe integer has no cutoff');
    assert.strictEqual(parse('## Pruned x (phases 1-0, kept recent 3)\n').cutoff, 0, 'a zero cutoff parses');

    assert.deepStrictEqual(parse('## Pruned x\n\nstray text\n\n### Decisions\n\n- a\n').sections, [blk('Decisions', ['- a'])],
      'text before the first ### is ignored');
    assert.deepStrictEqual(parse('## Pruned x\n\n### Decisions\n\n\n- a\n\n   \n- b\n').sections, [blk('Decisions', ['- a', '- b'])],
      'blank lines are skipped');
    assert.deepStrictEqual(parse('## Pruned x\n\n### Decisions\n\n- a\n\n## Other\n\n- z\n').sections, [blk('Decisions', ['- a'])],
      'a later ## heading ends the block');

    const spaces = ' '.repeat(50000);
    assert.deepStrictEqual(parse(`## Pruned x\n\n### Decisions\n\n${spaces}x\n- a\n`).sections,
      [blk('Decisions', [`${spaces}x`, '- a'])], 'a 50,000-space entry line followed by x');
    assert.deepStrictEqual(parse(`## Pruned x\n\n### Decisions${spaces}x\n\n- a\n`).sections,
      [blk(`Decisions${spaces}x`, ['- a'])], 'a 50,000-space run inside a section heading');
    assert.deepStrictEqual(parse(`## Pruned x\n\n### Decisions${spaces}\n\n- a\n`).sections, [blk('Decisions', ['- a'])],
      'trailing whitespace on a section heading is trimmed');
  });

  test('property: parsing a rendered block returns the cutoff and sections it was rendered from', () => {
    const entry = fc.string({ unit: fc.constantFrom('a', 'Z', '0', ' ', '-', '#', '[', ']', ':', '<', '!', '>', 'é', '\t'), maxLength: 30 }).map(t => `- ${t}`);
    const section = fc.record({
      section: fc.constantFrom('Decisions', 'Recently Completed', 'Blockers'),
      lines: fc.array(entry, { minLength: 1, maxLength: 6 }),
    });
    fc.assert(fc.property(fc.array(section, { minLength: 1, maxLength: 3 }), fc.nat(1000), fc.nat(9), (generated, cutoff, keepRecent) => {
      // fc.record yields null-prototype objects and deepStrictEqual compares prototypes, so rebuild plain objects.
      const sections = generated.map(sx => ({ section: sx.section, lines: [...sx.lines] }));
      const input = sections.map(sx => ({ ...sx, count: sx.lines.length }));
      const out = stateLib.renderStateArchiveAppend(stateLib.planStateArchiveAppend(null, input, { date: '2026-11-04', cutoff, keepRecent }));
      assert.deepStrictEqual(stateLib.parseLastArchiveBlock(out), { cutoff, sections }, 'the round trip returns the same block');
    }), { seed: 5831 });
  });

  test('a prune with nothing old enough to archive writes neither STATE.md nor the archive', () => {
    writeStateMd(tmpDir, stateLines(8, [PHASE7]));
    const stateBefore = fs.readFileSync(statePath);
    const writes = captureArchiveWrites();
    prune(3); // cutoff 5: the only entry is phase 7
    assert.strictEqual(writes.length, 0, 'no archive write');
    assert.strictEqual(fs.existsSync(archivePath), false, 'no archive is created');
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md is byte-identical');
    assert.ok(lockReleased(), 'the lock is released');
  });

  test('a retry after a kill still archives each entry once when another state command rewrote STATE.md in between', () => {
    pruneKilledBeforeStateWrite(3);
    const beforeOther = fs.readFileSync(statePath);
    const other = runGsdTools(['state', 'record-session', '--stopped-at', 'between the kill and the retry'], tmpDir);
    assert.ok(other.success, `record-session failed: ${other.error}`);
    assert.notDeepStrictEqual(fs.readFileSync(statePath), beforeOther, 'the other state command changed STATE.md');

    const writes = captureArchiveWrites();
    prune(3);
    assert.strictEqual(writes.length, 0, 'the retry does not write the archive');
    assertArchivedOnce(OLD_ENTRIES);
    assert.deepStrictEqual(prunable(), [{ section: 'Decisions', lines: [PHASE7] }], 'the retry finished the prune');
  });

  test('a STATE.md that disappears while the lock is held fails the prune, leaves the archive unchanged and releases the lock', () => {
    fs.writeFileSync(archivePath, SEED_ARCHIVE);
    const archiveBefore = fs.readFileSync(archivePath);
    const realRead = scp.platformReadBytesSync;
    // The first in-lock read is readModifyWriteStateMd's own; only the second in-lock
    // read (the snapshot inside publishPrunedToArchive) sees the file gone.
    let inLockReads = 0;
    mock.method(scp, 'platformReadBytesSync', (p, ...rest) => {
      if (p === statePath && fs.existsSync(statePath + '.lock')) {
        inLockReads += 1;
        if (inLockReads === 2) return null;
      }
      return realRead.call(scp, p, ...rest);
    });
    assert.throws(() => prune(3), /disappeared while its lock was held/);
    mock.restoreAll();
    pinDay();

    assert.deepStrictEqual(fs.readFileSync(archivePath), archiveBefore, 'the archive is unchanged');
    assert.ok(lockReleased(), 'the STATE.md lock is released');
  });

  test('a pure retry whose STATE.md write fails throws and leaves the archive and STATE.md unchanged', () => {
    pruneKilledBeforeStateWrite(3);
    const archiveBefore = fs.readFileSync(archivePath);
    const stateBefore = fs.readFileSync(statePath);
    const writes = captureArchiveWrites();

    failWritesTo(statePath, 'ENOSPC');
    assert.throws(() => prune(3), (err) => err.code === 'ENOSPC');
    mock.restoreAll();
    pinDay();

    assert.strictEqual(writes.length, 0, 'the retry did not write the archive');
    assert.deepStrictEqual(fs.readFileSync(archivePath), archiveBefore, 'the archive is unchanged');
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore, 'STATE.md is unchanged');
    assert.ok(lockReleased(), 'the STATE.md lock is released');
    assert.deepStrictEqual(planningLeftovers(), [], 'no temp file is left');
  });

  // ── boundaries of the archive base ─────────────────────────────────────

  test('an existing 0-byte archive is appended to as-is: no header, no separator', () => {
    fs.writeFileSync(archivePath, '');
    const sections = prunableRaw(5);
    const writes = captureArchiveWrites();
    prune(3);

    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].prior, '', 'the empty archive is the base');
    const plan = assertWriteIsPlan(writes[0], sections, 5, 3);
    assert.strictEqual(plan.base, '', 'the header is not added to an existing archive');
    assert.strictEqual(plan.boundary, '', 'no separator before the first heading');
    assert.ok(fs.readFileSync(archivePath, 'utf-8').startsWith('## Pruned '), 'the archive starts with the block heading');
    assertArchivedOnce(OLD_ENTRIES);
  });

  // ── the plan/render pair: properties ───────────────────────────────────

  test('property: the rendered append keeps the base, separates it cleanly, holds every planned line, and adds no comment line', () => {
    const lineChar = fc.constantFrom('a', 'Z', '0', ' ', '-', '#', '[', ']', ':', '<', '!', '>', 'é', '\t');
    const entry = fc.string({ unit: lineChar, maxLength: 30 }).map(t => `- ${t}`);
    const baseChar = fc.constantFrom('a', ' ', '#', '\n', '\r', '-', '<', '!', '>');
    const base = fc.option(fc.string({ unit: baseChar, maxLength: 60 }), { nil: null });
    const section = fc.record({
      section: fc.constantFrom('Decisions', 'Recently Completed', 'Blockers'),
      lines: fc.array(entry, { minLength: 1, maxLength: 6 }),
    });

    fc.assert(fc.property(base, fc.array(section, { minLength: 1, maxLength: 3 }), fc.nat(50), fc.nat(9),
      (existing, sections, cutoff, keepRecent) => {
        const input = sections.map(s => ({ ...s, count: s.lines.length }));
        const plan = stateLib.planStateArchiveAppend(existing, input, { date: '2026-11-04', cutoff, keepRecent });
        const out = stateLib.renderStateArchiveAppend(plan);

        if (existing === null) assert.ok(plan.base.startsWith('# STATE Archive\n'), 'an absent archive gets the header');
        else assert.strictEqual(plan.base, existing, 'an existing archive is the base, even when empty');
        assert.ok(out.startsWith(plan.base), 'the base is kept byte-for-byte');
        assert.strictEqual(plan.boundary === '\n\n', plan.base.length > 0 && !plan.base.endsWith('\n'),
          'a separator exactly when the base is non-empty without a trailing LF');

        const block = out.slice(plan.base.length + plan.boundary.length);
        assert.ok(block.startsWith(`## Pruned 2026-11-04 (phases 1-${cutoff}, kept recent ${keepRecent})\n`), 'the heading starts the block on its own line');
        const blockLines = block.split('\n');
        const planned = input.flatMap(s => s.lines);
        for (const line of new Set(planned)) {
          assert.strictEqual(blockLines.filter(l => l === line).length, planned.filter(l => l === line).length,
            'every planned line appears once per occurrence');
        }
        assert.ok(!blockLines.some(l => l.startsWith('<!--')), 'the block has no comment line');
      }), { seed: 5831 });
  });

  test('property: a block drawn from the pruned lines is pending and leaves exactly the rest; a block with a foreign line is not pending', () => {
    const entry = fc.string({ unit: fc.constantFrom('a', 'Z', '0', ' ', '-', '[', ']', ':', 'é'), maxLength: 12 }).map(t => `- ${t}`);
    const lines = fc.array(entry, { maxLength: 6 });
    const names = ['Decisions', 'Recently Completed', 'Blockers'];
    const sorted = (a) => [...a].sort();

    fc.assert(fc.property(fc.tuple(lines, lines, lines), fc.array(fc.boolean(), { minLength: 18, maxLength: 18 }), fc.nat(2),
      (perSection, mask, foreignIn) => {
        const sections = names.map((n, i) => ({ section: n, count: perSection[i].length, lines: perSection[i] }))
          .filter(s => s.lines.length > 0);
        let idx = 0;
        const block = sections.map(s => ({ section: s.section, lines: s.lines.filter(() => mask[idx++ % mask.length]) }))
          .filter(b => b.lines.length > 0);
        fc.pre(block.length > 0);

        const { pending, remainder } = stateLib.subtractPendingBlock(block, sections);
        assert.strictEqual(pending, true, 'a sub-multiset of the pruned lines is pending');
        for (const s of sections) {
          const taken = (block.find(b => b.section === s.section) || { lines: [] }).lines;
          const left = (remainder.find(r => r.section === s.section) || { lines: [] }).lines;
          assert.deepStrictEqual(sorted([...left, ...taken]), sorted(s.lines), 'remainder plus block is the pruned section');
        }
        for (const r of remainder) assert.strictEqual(r.count, r.lines.length, 'count is recomputed');

        const foreign = block.map((b, i) => (i === foreignIn % block.length ? { ...b, lines: [...b.lines, 'NOT AN ENTRY'] } : b));
        const bad = stateLib.subtractPendingBlock(foreign, sections);
        assert.strictEqual(bad.pending, false, 'a block line that was not pruned is not pending');
        assert.strictEqual(bad.remainder, sections, 'remainder is the sections unchanged');
      }), { seed: 5831 });
  });
});
