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

  // #6389: the block IR also carries the recorded phase retention K and the quick N (null when the heading has none).
  const parsedBlock = (cutoff, sections, keepRecent = null) => ({ cutoff, keepRecent, keepRecentQuick: null, sections });

  test('parseLastArchiveBlock reads only the last block, with its heading cutoff', () => {
    const parse = stateLib.parseLastArchiveBlock;
    assert.strictEqual(parse(''), null, 'empty text');
    assert.strictEqual(parse('# STATE Archive\n\nno blocks\n'), null, 'no heading');
    assert.deepStrictEqual(parse('## Pruned x\n'), parsedBlock(null, []), 'a heading with no sections and no cutoff');

    const twoBlocks = '# STATE Archive\n\n## Pruned 1 (phases 1-1, kept recent 3)\n\n### Decisions\n\n- a\n\n' +
      '## Pruned 2 (phases 1-2, kept recent 3)\n\n### Decisions\n\n- b\n\n### Blockers\n\n- c\n- d\n\n';
    const last = parsedBlock(2, [blk('Decisions', ['- b']), blk('Blockers', ['- c', '- d'])], 3);
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
      assert.deepStrictEqual(stateLib.parseLastArchiveBlock(out), { cutoff, keepRecent, keepRecentQuick: null, sections }, 'the round trip returns the same block');
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

// ────────────────────────────────────────────────────────────────────────
// #6389 — a run without --keep-recent-quick is what it was before #6389.
// Asserted structurally: the result object and its key order, the archive
// write captured at the platformWriteSync seam against the production plan
// for the expected block (no quick part in it), and STATE.md as the input
// document minus the pruned lines. The Quick Tasks table in the fixture must
// come through every phase-only run untouched.
// ────────────────────────────────────────────────────────────────────────
describe('#6389: a phase-only state prune is unchanged (characterization)', () => {
  const { mock } = require('node:test');
  const { realClock } = require('../gsd-core/bin/lib/clock.cjs');
  const stateLib = require('../gsd-core/bin/lib/state.cjs');
  const scp = require('../gsd-core/bin/lib/shell-command-projection.cjs');

  const DAY = '2026-11-08';
  const BODY_HEAD = ['# Session State', '', '**Current Phase:** 8', '', '## Decisions', ''];
  const QUICK = [
    '### Quick Tasks Completed', '',
    '| # | Description | Date | Commit | Directory |', '|---|-------------|------|--------|-----------|',
    '| 1 | fast one | 2026-01-01 | a1 | — |', '| 2 | fast two | 2026-01-02 | a2 | — |', '',
  ];
  const ONE = '- [Phase 1]: one';
  const FOUR = '- [Phase 4]: four';
  const SEVEN = '- [Phase 7]: seven';
  const state = (decisions) => [...BODY_HEAD, ...decisions, '', ...QUICK].join('\n');

  let tmpDir;
  let archiveWrites;
  const p = (f) => path.join(tmpDir, '.planning', f);
  beforeEach(() => {
    tmpDir = createTempProject();
    mock.method(realClock, 'localToday', () => DAY);
    archiveWrites = [];
    const realPws = scp.platformWriteSync;
    mock.method(scp, 'platformWriteSync', (target, content, ...rest) => {
      if (target === p('STATE-ARCHIVE.md')) archiveWrites.push(content);
      return realPws.call(scp, target, content, ...rest);
    });
  });
  afterEach(() => {
    mock.restoreAll();
    cleanup(tmpDir);
  });

  /** STATE.md from its body heading on: a real run adds frontmatter with a live timestamp. */
  const body = () => {
    const text = fs.readFileSync(p('STATE.md'), 'utf-8');
    return text.slice(text.indexOf('# Session State'));
  };

  const RESULT_KEYS = ['pruned', 'cutoff_phase', 'keep_recent', 'sections', 'total_archived', 'archive_file'];
  const DRY_KEYS = ['pruned', 'dry_run', 'cutoff_phase', 'keep_recent', 'sections', 'total_would_archive', 'note'];
  const archivedResult = (cutoff, keepRecent, n) => ({
    pruned: true, cutoff_phase: cutoff, keep_recent: keepRecent, sections: [{ section: 'Decisions', entries_archived: n }],
    total_archived: n, archive_file: 'STATE-ARCHIVE.md',
  });
  const CASES = [
    {
      name: 'a real run', args: ['--keep-recent', '3'], decisions: [ONE, FOUR, SEVEN], keys: RESULT_KEYS,
      out: archivedResult(5, 3, 2), raw: 'true', body: state([SEVEN]),
      block: { cutoff: 5, keepRecent: 3, lines: [ONE, FOUR] },
    },
    {
      name: 'the default --keep-recent', args: [], decisions: [ONE, FOUR, SEVEN], keys: RESULT_KEYS,
      out: archivedResult(5, 3, 2), raw: 'true', body: state([SEVEN]),
      block: { cutoff: 5, keepRecent: 3, lines: [ONE, FOUR] },
    },
    {
      name: 'a dry-run', args: ['--keep-recent', '3', '--dry-run'], decisions: [ONE, FOUR, SEVEN], keys: DRY_KEYS,
      out: { pruned: false, dry_run: true, cutoff_phase: 5, keep_recent: 3, sections: [{ section: 'Decisions', entries_would_archive: 2 }], total_would_archive: 2, note: 'Run without --dry-run to actually prune' },
      raw: 'true', body: state([ONE, FOUR, SEVEN]), block: null,
    },
    {
      name: 'the cutoff <= 0 early return', args: ['--keep-recent', '8'], decisions: [ONE, FOUR, SEVEN], keys: ['pruned', 'reason'],
      out: { pruned: false, reason: 'Only 8 phases — nothing to prune with --keep-recent 8' },
      raw: 'false', body: state([ONE, FOUR, SEVEN]), block: null,
    },
    // Today's handling of 0 and of a negative value, which #6542 changes: 0 becomes 3, and -2 moves the cutoff past
    // the current phase (8 + 2) and archives every phase-tagged entry. Pinned here as the behavior this PR keeps.
    {
      name: '--keep-recent 0 (as today: read as 3)', args: ['--keep-recent', '0'], decisions: [ONE, FOUR, SEVEN], keys: RESULT_KEYS,
      out: archivedResult(5, 3, 2), raw: 'true', body: state([SEVEN]),
      block: { cutoff: 5, keepRecent: 3, lines: [ONE, FOUR] },
    },
    {
      name: '--keep-recent -2 (as today: cutoff past the current phase)', args: ['--keep-recent', '-2'], decisions: [ONE, FOUR, SEVEN], keys: RESULT_KEYS,
      out: archivedResult(10, -2, 3), raw: 'true', body: [...BODY_HEAD, ...QUICK].join('\n'),
      block: { cutoff: 10, keepRecent: -2, lines: [ONE, FOUR, SEVEN] },
    },
    {
      name: 'a run with nothing old enough', args: ['--keep-recent', '3'], decisions: [SEVEN], keys: RESULT_KEYS,
      out: { pruned: false, cutoff_phase: 5, keep_recent: 3, sections: [], total_archived: 0, archive_file: null },
      raw: 'false', body: state([SEVEN]), block: null,
    },
  ];

  for (const c of CASES) {
    for (const raw of [false, true]) {
      test(`${c.name}${raw ? ' (--raw)' : ''}: the same result, STATE.md and archive write as before #6389`, () => {
        fs.writeFileSync(p('STATE.md'), state(c.decisions));
        const result = runGsdTools(['state', 'prune', ...c.args, ...(raw ? ['--raw'] : [])], tmpDir);
        assert.strictEqual(result.exitCode, 0, result.error);
        if (raw) {
          assert.strictEqual(result.output, c.raw);
        } else {
          const out = JSON.parse(result.output);
          assert.deepStrictEqual(out, c.out);
          assert.deepStrictEqual(Object.keys(out), c.keys, 'key order');
        }
        assert.strictEqual(body(), c.body);
        if (c.block === null) {
          assert.deepStrictEqual(archiveWrites, []);
          assert.strictEqual(fs.existsSync(p('STATE-ARCHIVE.md')), false);
          return;
        }
        const plan = stateLib.planStateArchiveAppend(null, [{ section: 'Decisions', count: c.block.lines.length, lines: c.block.lines }],
          { date: DAY, cutoff: c.block.cutoff, keepRecent: c.block.keepRecent });
        assert.deepStrictEqual(plan.block,
          { date: DAY, cutoff: c.block.cutoff, keepRecent: c.block.keepRecent, sections: [{ section: 'Decisions', lines: c.block.lines }] },
          'a phase-only block carries no quick part');
        assert.strictEqual(archiveWrites.length, 1, 'one archive write');
        assert.strictEqual(Buffer.byteLength(archiveWrites[0]), Buffer.byteLength(stateLib.renderStateArchiveAppend(plan)),
          'the writer wrote the rendering of that plan (size; content not compared)');
      });
    }
  }
});

// ────────────────────────────────────────────────────────────────────────
// #6389 — `state prune --keep-recent-quick N` keeps the last N rows of the
// Quick Tasks table (table order) and moves the older rows, verbatim, into
// STATE-ARCHIVE.md through the #5831 archive-first transaction.
// ────────────────────────────────────────────────────────────────────────
describe('#6389: state prune --keep-recent-quick', () => {
  const { mock } = require('node:test');
  const stateLib = require('../gsd-core/bin/lib/state.cjs');
  const scp = require('../gsd-core/bin/lib/shell-command-projection.cjs');
  const { realClock } = require('../gsd-core/bin/lib/clock.cjs');
  const { createBatch, completeQuickItem } = require('../gsd-core/bin/lib/quick-batch.cjs');
  const { seedWorkstream } = require('./fixtures/index.cjs');
  const { homeSandboxEnv } = require('./helpers.cjs');

  const DAY = '2026-11-08';
  const QUICK = 'Quick Tasks Completed';
  const HEADER = '| # | Description | Date | Commit | Directory |';
  const DELIM = '|---|-------------|------|--------|-----------|';
  const ARCHIVE_HEADER = '# STATE Archive\n\nPruned entries from STATE.md. Recoverable but no longer loaded into agent context.\n\n';
  const D1 = '- [Phase 1]: one';
  const D4 = '- [Phase 4]: four';
  const D7 = '- [Phase 7]: seven';

  /** Row i of the table: directory-less ordinal rows, the shape `/gsd-fast` logs. */
  const row = (i) => `| ${i} | task ${i} | 2026-10-01 | c${i} | — |`;
  const rows = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => row(from + k));

  /**
   * A STATE.md with an optional phase position, a Decisions section and the
   * Quick Tasks table, joined with `eol`.
   */
  function stateDoc({ phase = 8, decisions = [D1, D4, D7], table = rows(1, 5), eol = '\n', header = HEADER, delim = DELIM } = {}) {
    return [
      '# Session State', '',
      ...(phase === null ? [] : [`**Current Phase:** ${phase}`, '']),
      '## Decisions', '', ...decisions, '',
      `### ${QUICK}`, '', header, delim, ...table, '',
      '### Blockers/Concerns', '', 'None', '',
    ].join(eol);
  }

  let tmpDir;
  let statePath;
  let archivePath;
  /** Every archive write (any STATE-ARCHIVE.md), captured at the platformWriteSync seam: target, prior text, text written. */
  let archiveWrites;
  /**
   * Per-test write interception (fault injection, STATE.md write records), called before every write through the
   * seam. One mock only: stacking a second `mock.method` on the same function would let `mock.restoreAll()` put the
   * first mock back instead of the real function.
   */
  let beforeWrite = null;
  function captureAllArchiveWrites() {
    const realPws = scp.platformWriteSync;
    mock.method(scp, 'platformWriteSync', (target, content, ...rest) => {
      if (beforeWrite !== null) beforeWrite(target, content);
      if (path.basename(target) === 'STATE-ARCHIVE.md') {
        archiveWrites.push({ target, prior: fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null, content });
      }
      return realPws.call(scp, target, content, ...rest);
    });
  }
  beforeEach(() => {
    tmpDir = createTempProject();
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    archivePath = path.join(tmpDir, '.planning', 'STATE-ARCHIVE.md');
    mock.method(realClock, 'localToday', () => DAY);
    archiveWrites = [];
    beforeWrite = null;
    captureAllArchiveWrites();
    published = [];
    seeded = [];
    stateLib._setStatePruneTestHooks({ onArchivePublication: (p) => published.push(p) });
  });

  /**
   * The publication IR handed to the archive writer (V2): `{ archivePath, kind: 'append' | 'extend', block }`,
   * where `block.sections` are the lines that publication ADDS. With `seeded` (the entry lines of any archive a
   * test authored itself), this is the whole multiplicity record: no archive text is inspected.
   */
  let published;
  let seeded;
  /** Write an authored archive and record its entry lines (the IR the test wrote, not a read-back). */
  function seedArchive(text, entryLines) {
    fs.writeFileSync(archivePath, text);
    seeded.push(...entryLines);
  }
  /** Forget publications a rollback undid (the archive is back to its snapshot). */
  function dropRolledBack() { published.length = 0; }
  const publishedHere = () => published.filter((p) => p.archivePath === archivePath);
  /** How many times `line` is in the archive: authored lines plus every line a publication added. */
  const archiveCount = (line) =>
    seeded.filter((l) => l === line).length +
    publishedHere().flatMap((p) => p.block.sections.flatMap((s) => s.lines)).filter((l) => l === line).length;
  /** Blocks this test's archive holds beyond any authored ones: each 'append' publication is one block. */
  const blockCount = () => publishedHere().filter((p) => p.kind === 'append').length;

  const qs = (lines, head = [HEADER, DELIM]) => ({ section: QUICK, head, lines });
  const ds = (lines) => ({ section: 'Decisions', lines });
  /**
   * The documented writer pattern (CONTRIBUTING, "Rendered file"): the pure builder's IR for the expected block
   * is asserted field by field, and the last archive write to `target` is checked to be the rendering of that
   * plan by size, without comparing content. Occurrence counts and STATE.md are asserted by the tests themselves.
   */
  function assertLastArchiveWrite(meta, sections, target = archivePath, kind = 'append') {
    const writes = archiveWrites.filter((w) => w.target === target);
    assert.ok(writes.length > 0, 'the archive was written');
    const last = writes[writes.length - 1];
    // `meta.date` is the date the block's heading records (an extended block keeps its own); the run's date is DAY.
    const expectedBlock = { date: meta.date ?? DAY, cutoff: meta.cutoff, keepRecent: meta.keepRecent, sections };
    if (meta.keepRecentQuick !== undefined) expectedBlock.keepRecentQuick = meta.keepRecentQuick;
    const pubs = published.filter((p) => p.archivePath === target);
    assert.deepStrictEqual(pubs[pubs.length - 1], { archivePath: target, kind, block: expectedBlock },
      'the publication IR handed to the writer: heading fields, table head and the verbatim rows it adds');
    const added = sections.map((s) => ({ ...s, count: s.lines.length }));
    const runMeta = { ...meta, date: DAY };
    const plan = kind === 'append'
      ? stateLib.planStateArchiveAppend(last.prior, added, runMeta)
      : stateLib.planStateArchiveExtend(last.prior, added, runMeta);
    const rendered = kind === 'append' ? stateLib.renderStateArchiveAppend(plan) : stateLib.renderStateArchiveExtend(plan);
    assert.strictEqual(Buffer.byteLength(last.content), Buffer.byteLength(rendered), 'the writer wrote the rendering of that plan');
    return plan;
  }
  const QUICK_ONLY = (q) => ({ cutoff: null, keepRecent: null, keepRecentQuick: q });
  afterEach(() => {
    mock.restoreAll();
    stateLib._resetStateLockTestHooks();
    stateLib._resetStatePruneTestHooks();
    cleanup(tmpDir);
  });
  function pinDay() { mock.method(realClock, 'localToday', () => DAY); }
  /** Make writes to `target` fail with `code`. */
  function failWritesTo(target, code) {
    beforeWrite = (p) => { if (p === target) { const e = new Error(`${code}: simulated`); e.code = code; throw e; } };
  }
  /** End a fault injection: no more interception, any other mock removed, the clock pinned again. */
  function endFaults() {
    beforeWrite = null;
    mock.restoreAll();
    pinDay();
    captureAllArchiveWrites();
  }

  const write = (content) => fs.writeFileSync(statePath, content);
  const archiveText = () => (fs.existsSync(archivePath) ? fs.readFileSync(archivePath, 'utf-8') : null);
  /** STATE.md from its body heading on (a real run adds frontmatter with a live timestamp). */
  const body = () => {
    const text = fs.readFileSync(statePath, 'utf-8');
    return text.slice(text.indexOf('# Session State'));
  };
  /** The data rows of the Quick Tasks table in STATE.md, by `#`. */
  const tableIds = () => {
    const t = findTableBySchema(fs.readFileSync(statePath, 'utf-8'), 'QuickTasks');
    return t === null ? null : t.rows.map((r) => r['#']);
  };
  const ids = (from, to) => rows(from, to).map((_, k) => String(from + k));
  /** How many lines of the archive are exactly `line`. */
  const cli = (...args) => runGsdTools(['state', 'prune', ...args], tmpDir);
  const run = (opts) => stateLib.cmdStatePrune(tmpDir, { dryRun: false, silent: true, ...opts }, true);
  const quickBlock = (heading, moved) => `## Pruned ${DAY} (${heading})\n\n### ${QUICK}\n\n${[HEADER, DELIM, ...moved].join('\n')}\n`;
  const { findTableBySchema } = require('../gsd-core/bin/lib/markdown-table.cjs');

  // ── what a run does ────────────────────────────────────────────────────

  test('quick only, with no phase position at all: keeps the last N rows and archives the rest verbatim as a table', () => {
    write(stateDoc({ phase: null }));
    const result = cli('--keep-recent-quick', '2');
    assert.strictEqual(result.exitCode, 0, result.error);
    assert.deepStrictEqual(JSON.parse(result.output), {
      pruned: true, cutoff_phase: null, keep_recent: null, keep_recent_quick: 2,
      sections: [{ section: QUICK, entries_archived: 3 }], total_archived: 3, archive_file: 'STATE-ARCHIVE.md',
    });
    assert.strictEqual(body(), stateDoc({ phase: null, table: rows(4, 5) }));
    assert.strictEqual(archiveWrites.length, 1);
    assertLastArchiveWrite(QUICK_ONLY(2), [qs(rows(1, 3))]);
  });

  test('quick only leaves the phase-tagged sections alone even when a phase position exists', () => {
    write(stateDoc());
    const out = JSON.parse(cli('--keep-recent-quick', '4').output);
    assert.deepStrictEqual(out.sections, [{ section: QUICK, entries_archived: 1 }]);
    assert.strictEqual(body(), stateDoc({ table: rows(2, 5) }), 'Decisions keep every entry');
  });

  test('both options: one block, one heading recording both, phase sections first, one STATE.md write', () => {
    write(stateDoc());
    const stateWrites = [];
    beforeWrite = (p) => { if (p === statePath) stateWrites.push(p); };
    const out = run({ keepRecent: '3', keepRecentQuick: 1 });
    assert.deepStrictEqual(out, {
      pruned: true, cutoff_phase: 5, keep_recent: 3, keep_recent_quick: 1,
      sections: [{ section: 'Decisions', entries_archived: 2 }, { section: QUICK, entries_archived: 4 }],
      total_archived: 6, archive_file: 'STATE-ARCHIVE.md',
    });
    assert.strictEqual(archiveWrites.length, 1, 'one archive write');
    assertLastArchiveWrite({ cutoff: 5, keepRecent: 3, keepRecentQuick: 1 }, [ds([D1, D4]), qs(rows(1, 4))]);
    assert.ok(stateWrites.length <= 1, 'at most one STATE.md write through the seam');
    assert.strictEqual(body(), stateDoc({ decisions: [D7], table: rows(5, 5) }));
  });

  for (const [label, phase, keepRecent] of [['no phase position', null, '3'], ['a cutoff of 0', 8, '8'], ['a negative cutoff', 2, '3']]) {
    test(`both options with ${label}: the phase part is skipped, the quick part still runs`, () => {
      write(stateDoc({ phase }));
      const out = run({ keepRecent, keepRecentQuick: 3 });
      assert.deepStrictEqual(out, {
        pruned: true, cutoff_phase: null, keep_recent: Number(keepRecent), keep_recent_quick: 3,
        sections: [{ section: QUICK, entries_archived: 2 }], total_archived: 2, archive_file: 'STATE-ARCHIVE.md',
      });
      // The heading records both options; the phase part is `phases none` (no positive cutoff).
      assertLastArchiveWrite({ cutoff: null, keepRecent: Number(keepRecent), keepRecentQuick: 3 }, [qs(rows(1, 2))]);
      assert.strictEqual(body(), stateDoc({ phase, table: rows(3, 5) }), 'Decisions untouched, [Phase 0]-style cutoff never applied');
    });
  }

  test('both options with cutoff 0 never archives a [Phase 0] entry (the phase part is skipped, not run at cutoff 0)', () => {
    write(stateDoc({ phase: 3, decisions: ['- [Phase 0]: zero', D1] }));
    run({ keepRecent: '3', keepRecentQuick: 5 });
    assert.strictEqual(body(), stateDoc({ phase: 3, decisions: ['- [Phase 0]: zero', D1] }));
    assert.strictEqual(archiveText(), null, 'nothing to archive: rows <= N and no phase part');
  });

  test('N = 0 archives every row and keeps the header', () => {
    write(stateDoc({ phase: null }));
    const out = run({ keepRecentQuick: 0 });
    assert.strictEqual(out.total_archived, 5);
    assert.deepStrictEqual(tableIds(), []);
    assertLastArchiveWrite(QUICK_ONLY(0), [qs(rows(1, 5))]);
  });

  for (const n of [5, 6, 10000]) {
    test(`N = ${n} with 5 rows archives nothing and writes nothing`, () => {
      write(stateDoc({ phase: null }));
      const before = fs.readFileSync(statePath);
      const result = cli('--keep-recent-quick', String(n));
      assert.strictEqual(result.exitCode, 0, result.error);
      assert.deepStrictEqual(JSON.parse(result.output), {
        pruned: false, cutoff_phase: null, keep_recent: null, keep_recent_quick: n, sections: [], total_archived: 0, archive_file: null,
      });
      assert.deepStrictEqual(fs.readFileSync(statePath), before, 'STATE.md byte-identical');
      assert.strictEqual(archiveText(), null);
    });
  }

  test('--dry-run reports what the real run then does and writes nothing', () => {
    write(stateDoc());
    const before = fs.readFileSync(statePath);
    const preview = cli('--keep-recent', '3', '--keep-recent-quick', '2', '--dry-run');
    assert.strictEqual(preview.exitCode, 0, preview.error);
    assert.deepStrictEqual(JSON.parse(preview.output), {
      pruned: false, dry_run: true, cutoff_phase: 5, keep_recent: 3, keep_recent_quick: 2,
      sections: [{ section: 'Decisions', entries_would_archive: 2 }, { section: QUICK, entries_would_archive: 3 }],
      total_would_archive: 5, note: 'Run without --dry-run to actually prune',
    });
    assert.deepStrictEqual(fs.readFileSync(statePath), before);
    assert.strictEqual(archiveText(), null);
    const real = JSON.parse(cli('--keep-recent', '3', '--keep-recent-quick', '2').output);
    assert.strictEqual(real.total_archived, 5);
  });

  test('--raw prints the pruned verdict', () => {
    write(stateDoc({ phase: null }));
    assert.strictEqual(cli('--keep-recent-quick', '9', '--dry-run', '--raw').output, 'false');
    assert.strictEqual(cli('--keep-recent-quick', '1', '--raw').output, 'true');
  });

  test('no Quick Tasks section: the quick part archives nothing, the run succeeds, and the phase part still runs', () => {
    const noQuick = ['# Session State', '', '**Current Phase:** 8', '', '## Decisions', '', D1, D7, ''].join('\n');
    write(noQuick);
    const quickOnly = cli('--keep-recent-quick', '0');
    assert.strictEqual(quickOnly.exitCode, 0, quickOnly.error);
    assert.deepStrictEqual(JSON.parse(quickOnly.output).sections, []);
    assert.strictEqual(fs.readFileSync(statePath, 'utf-8'), noQuick, 'quick only: nothing written');
    const both = JSON.parse(cli('--keep-recent', '3', '--keep-recent-quick', '0').output);
    assert.deepStrictEqual(both.sections, [{ section: 'Decisions', entries_archived: 1 }]);
    assertLastArchiveWrite({ cutoff: 5, keepRecent: 3, keepRecentQuick: 0 }, [ds([D1])]);
  });

  for (const [label, header, delim, table] of [
    ['an unknown schema', '| # | Thing | When |', '|---|---|---|', ['| 1 | a | b |']],
    ['a ragged row', HEADER, DELIM, ['| 1 | only | three |']],
    ['no table under the heading', 'just prose', 'more prose', []],
  ]) {
    test(`${label}: refused with quick_table_unrecognized, nothing written (quick only, both, dry-run)`, () => {
      write(stateDoc({ header, delim, table }));
      const before = fs.readFileSync(statePath);
      for (const args of [['--keep-recent-quick', '0'], ['--keep-recent', '3', '--keep-recent-quick', '0'], ['--keep-recent-quick', '0', '--dry-run']]) {
        const result = runGsdTools(['--json-errors', 'state', 'prune', ...args], tmpDir);
        assert.strictEqual(result.exitCode, 1, `${args.join(' ')} must fail`);
        assert.strictEqual(JSON.parse(result.error).reason, 'quick_table_unrecognized');
        assert.deepStrictEqual(fs.readFileSync(statePath), before, 'STATE.md byte-identical');
        assert.strictEqual(archiveText(), null, 'no archive');
      }
    });
  }

  test('only the first recognized Quick Tasks table is pruned; an older suffixed (v1.0) table is left alone', () => {
    const doc = [
      '# Session State', '',
      '### Quick Tasks Completed (v1.1+)', '', HEADER, DELIM, ...rows(1, 3), '',
      '### Quick Tasks Completed (v1.0)', '', HEADER, DELIM, ...rows(100, 102), '',
    ].join('\n');
    write(doc);
    run({ keepRecentQuick: 1 });
    assert.strictEqual(body(), [
      '# Session State', '',
      '### Quick Tasks Completed (v1.1+)', '', HEADER, DELIM, row(3), '',
      '### Quick Tasks Completed (v1.0)', '', HEADER, DELIM, ...rows(100, 102), '',
    ].join('\n'));
    assertLastArchiveWrite(QUICK_ONLY(1), [qs(rows(1, 2))]);
  });

  test('the with-status variant and quick-id rows move verbatim', () => {
    const h6 = '| # | Description | Date | Commit | Status | Directory |';
    const d6 = '| --- | --- | --- | --- | --- | --- |';
    const table = ['| 260101-abc | one | 2026-01-01 | a1 | Pass | [dir](./quick/260101-abc-one/) |', '|  2  | two  | 2026-01-02 | a2 | — | — |', '| 260103-xyz | three | 2026-01-03 | a3 | Pass | — |'];
    write(stateDoc({ phase: null, header: h6, delim: d6, table }));
    run({ keepRecentQuick: 1 });
    assertLastArchiveWrite(QUICK_ONLY(1), [qs([table[0], table[1]], [h6, d6])]);
    assert.strictEqual(body(), stateDoc({ phase: null, header: h6, delim: d6, table: [table[2]] }));
  });

  test('CRLF: the moved rows keep their CRLF in the archive; STATE.md keeps the other rows', () => {
    write(stateDoc({ phase: null, eol: '\r\n' }));
    const transformed = [];
    beforeWrite = (p, content) => { if (p === statePath) transformed.push(String(content)); };
    run({ keepRecentQuick: 3 });
    // STATE.md's own write seam normalizes line endings as it does for every state command; the rows kept are
    // asserted through the table, the archived rows through the publication IR.
    assert.deepStrictEqual(tableIds(), ids(3, 5));
    const cr = (l) => `${l}\r`;
    assertLastArchiveWrite(QUICK_ONLY(3), [qs(rows(1, 2).map(cr), [cr(HEADER), cr(DELIM)])]);
    for (const r of rows(1, 2)) assert.strictEqual(archiveCount(cr(r)), 1, `${r} is published with its CR`);
    assert.strictEqual(transformed.length, 1, 'one STATE.md write');
  });

  test('a workstream prunes its own STATE.md and writes its own STATE-ARCHIVE.md', () => {
    const rootDoc = stateDoc({ phase: null });
    write(rootDoc);
    const wsDir = seedWorkstream(tmpDir, { name: 'alpha', state: stateDoc({ phase: null, table: rows(10, 13) }) });
    const result = runGsdTools(['state', 'prune', '--ws', 'alpha', '--keep-recent-quick', '1'], tmpDir, homeSandboxEnv(tmpDir));
    assert.strictEqual(result.exitCode, 0, result.error);
    assert.strictEqual(JSON.parse(result.output).total_archived, 3);
    const wsState = fs.readFileSync(path.join(wsDir, 'STATE.md'), 'utf-8');
    assert.deepStrictEqual(findTableBySchema(wsState, 'QuickTasks').rows.map((r) => r['#']), ['13']);
    assert.ok(fs.statSync(path.join(wsDir, 'STATE-ARCHIVE.md')).isFile(), 'the workstream archive exists');
    assertLastArchiveWrite(QUICK_ONLY(1), [qs(rows(10, 12))], path.join(wsDir, 'STATE-ARCHIVE.md'));
    assert.strictEqual(fs.readFileSync(statePath, 'utf-8'), rootDoc, 'the root STATE.md is untouched');
    assert.strictEqual(archiveText(), null, 'no root archive');
  });

  test('a directory-less row appended after a prune gets the next free number', () => {
    write(stateDoc({ phase: null, table: rows(1, 30) }));
    run({ keepRecentQuick: 20 });
    const appended = runGsdTools(['quick-tasks-append', '--task', 'after the prune'], tmpDir);
    assert.strictEqual(appended.exitCode, 0, appended.error);
    assert.deepStrictEqual(tableIds(), [...ids(11, 30), '31']);
  });

  // ── fault injection: the archive-first transaction carries the rows ────

  test('a failed archive write leaves STATE.md and the archive untouched', () => {
    write(stateDoc({ phase: null }));
    const before = fs.readFileSync(statePath);
    failWritesTo(archivePath, 'EIO');
    assert.throws(() => run({ keepRecentQuick: 1 }), (err) => err.code === 'EIO');
    endFaults();
    assert.deepStrictEqual(fs.readFileSync(statePath), before);
    assert.strictEqual(archiveText(), null);
    assert.ok(!fs.existsSync(statePath + '.lock'), 'the lock is released');
  });

  for (const seed of [null, '# STATE Archive\n\nSeeded.\n']) {
    test(`a failed STATE.md write restores the archive byte for byte (archive ${seed === null ? 'absent' : 'present'}), and the retry archives each row once`, () => {
      write(stateDoc());
      if (seed !== null) seedArchive(seed, []);
      const before = fs.readFileSync(statePath);
      failWritesTo(statePath, 'ENOSPC');
      assert.throws(() => run({ keepRecent: '3', keepRecentQuick: 2 }), (err) => err.code === 'ENOSPC');
      endFaults();
      assert.deepStrictEqual(fs.readFileSync(statePath), before, 'STATE.md unchanged');
      assert.strictEqual(archiveText(), seed, 'archive restored / absent again');
      dropRolledBack();

      run({ keepRecent: '3', keepRecentQuick: 2 });
      for (const line of [D1, D4, ...rows(1, 3)]) assert.strictEqual(archiveCount(line), 1, `${line} archived once`);
      assert.deepStrictEqual(tableIds(), ids(4, 5));
    });
  }

  // ── retry after a kill between the archive write and the STATE.md write ─

  /** The on-disk result of a run killed after it published the archive and before it wrote STATE.md. */
  function killedAfterArchive(opts) {
    const before = fs.readFileSync(statePath);
    run(opts);
    fs.writeFileSync(statePath, before);
  }
  /** A view of the archive writes made from now on (the capture itself is installed in beforeEach). */
  function captureArchiveWrites() {
    const start = archiveWrites.length;
    return { get length() { return archiveWrites.length - start; } };
  }

  test('same options: the retry writes no second block and removes the rows', () => {
    write(stateDoc({ phase: null, table: rows(1, 30) }));
    killedAfterArchive({ keepRecentQuick: 20 });
    const archived = archiveText();
    const writes = captureArchiveWrites();
    const out = run({ keepRecentQuick: 20 });
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(archiveText(), archived);
    assert.strictEqual(out.total_archived, 10);
    assert.deepStrictEqual(tableIds(), ids(11, 30));
  });

  for (const retryN of [25, 30, 31]) {
    test(`a retry keeping more rows (N=${retryN}) completes the interrupted N=20 run`, () => {
      write(stateDoc({ phase: null, table: rows(1, 30) }));
      killedAfterArchive({ keepRecentQuick: 20 });
      const archived = archiveText();
      const writes = captureArchiveWrites();
      const out = run({ keepRecentQuick: retryN });
      assert.strictEqual(writes.length, 0, 'no second block');
      assert.strictEqual(archiveText(), archived);
      assert.strictEqual(out.keep_recent_quick, 20, 'the interrupted run\'s N is reported');
      assert.deepStrictEqual(tableIds(), ids(11, 30));
    });
  }

  test('a dry-run after the kill reports the completion the real run then does', () => {
    write(stateDoc({ phase: null, table: rows(1, 30) }));
    killedAfterArchive({ keepRecentQuick: 20 });
    const stateBefore = fs.readFileSync(statePath);
    const archiveBefore = archiveText();
    const preview = stateLib.cmdStatePrune(tmpDir, { keepRecentQuick: 30, dryRun: true, silent: true }, true);
    assert.strictEqual(preview.keep_recent_quick, 20);
    assert.strictEqual(preview.total_would_archive, 10);
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore);
    assert.strictEqual(archiveText(), archiveBefore);
  });

  test('a retry with a different N that does not complete the interrupted run appends its whole prune as a table', () => {
    write(stateDoc({ phase: null, table: rows(1, 30) }));
    killedAfterArchive({ keepRecentQuick: 20 });
    run({ keepRecentQuick: 10 });
    assert.strictEqual(blockCount(), 2);
    assertLastArchiveWrite(QUICK_ONLY(10), [qs(rows(1, 20))]);
    for (const line of rows(1, 10)) assert.strictEqual(archiveCount(line), 2, `${line} twice, never lost`);
    for (const line of rows(11, 20)) assert.strictEqual(archiveCount(line), 1);
    assert.deepStrictEqual(tableIds(), ids(21, 30));
  });

  test('an LF row in the archive never stands in for the same row with CRLF in STATE.md', () => {
    write(stateDoc({ phase: null, table: rows(1, 30), eol: '\r\n' }));
    seedArchive(ARCHIVE_HEADER + quickBlock('quick: kept recent 20', rows(1, 10)), rows(1, 10));
    run({ keepRecentQuick: 20 });
    for (const r of rows(1, 10)) {
      assert.strictEqual(archiveCount(`${r}\r`), 1, `${r} is archived with its CRLF`);
      assert.strictEqual(archiveCount(r), 1, 'the LF copy stays');
    }
    assert.deepStrictEqual(tableIds(), ids(11, 30));
  });

  test('mixed-EOL duplicate rows are counted separately', () => {
    const doc = ['# Session State', '', `### ${QUICK}`, '', HEADER, DELIM, `${row(1)}\r`, row(1), row(2), row(3), ''].join('\n');
    write(doc);
    seedArchive(ARCHIVE_HEADER + quickBlock('quick: kept recent 1', [row(1), row(1)]), [row(1), row(1)]);
    run({ keepRecentQuick: 1 });
    assert.strictEqual(archiveCount(`${row(1)}\r`), 1, 'the CRLF copy is archived');
    assert.deepStrictEqual(tableIds(), ['3']);
  });

  test('discovery without publication: an N that archives nothing never touches an archive it cannot complete', () => {
    write(stateDoc({ phase: null, table: rows(1, 5) }));
    const foreign = ARCHIVE_HEADER + quickBlock('quick: kept recent 0', rows(100, 101));
    seedArchive(foreign, rows(100, 101));
    const before = fs.readFileSync(statePath);
    const out = run({ keepRecentQuick: 5 });
    assert.strictEqual(out.pruned, false);
    assert.strictEqual(archiveText(), foreign, 'the archive is byte-identical');
    assert.deepStrictEqual(fs.readFileSync(statePath), before);
    fs.unlinkSync(archivePath);
    run({ keepRecentQuick: 9 });
    assert.strictEqual(archiveText(), null, 'no archive is created');
  });

  test('a row appended after the kill: the same N adds only the newly displaced row, to the same block', () => {
    write(stateDoc({ phase: null, table: rows(1, 30) }));
    killedAfterArchive({ keepRecentQuick: 20 });
    write(stateDoc({ phase: null, table: rows(1, 31) }));
    run({ keepRecentQuick: 20 });
    // Added to the block's existing quick section: no second table head.
    assertLastArchiveWrite(QUICK_ONLY(20), [{ section: QUICK, lines: [row(11)] }], archivePath, 'extend');
    assert.strictEqual(blockCount(), 1, 'still one block for the one run');
    for (const line of rows(1, 11)) assert.strictEqual(archiveCount(line), 1);
    assert.deepStrictEqual(tableIds(), ids(12, 31));
  });

  for (const [label, opts, decisions] of [
    ['quick only', { keepRecentQuick: 20 }, [D7]],
    ['combined', { keepRecent: '3', keepRecentQuick: 20 }, [D1, D4, D7]],
  ]) {
    test(`two interruptions with a row appended in between (${label}): the next identical retry archives every row once`, () => {
      write(stateDoc({ decisions, table: rows(1, 30) }));
      killedAfterArchive(opts); // publishes rows 1-10 (and phases 1, 4)
      write(stateDoc({ decisions, table: rows(1, 31) }));
      killedAfterArchive(opts); // adds row 11 to the same (still pending) block
      assertLastArchiveWrite(opts.keepRecent ? { cutoff: 5, keepRecent: 3, keepRecentQuick: 20 } : QUICK_ONLY(20),
        [{ section: QUICK, lines: [row(11)] }], archivePath, 'extend');
      assert.strictEqual(blockCount(), 1, 'one block holds everything the run published');
      const writes = captureArchiveWrites();
      run(opts);
      assert.strictEqual(writes.length, 0, 'the single pending block holds every row the run moves');
      for (const line of [...rows(1, 11), ...decisions.filter((d) => d !== D7)]) assert.strictEqual(archiveCount(line), 1, `${line} once`);
      assert.deepStrictEqual(tableIds(), ids(12, 31));
    });
  }

  test('an earlier completed run with the same options is not subtracted from a new prune', () => {
    write(stateDoc({ phase: null, table: rows(1, 25) }));
    run({ keepRecentQuick: 20 }); // completed: rows 1-5 archived and gone
    write(stateDoc({ phase: null, table: [...rows(6, 25), row(1)] })); // the same text as row 1 comes back
    const writes = captureArchiveWrites();
    run({ keepRecentQuick: 20 }); // moves row 6, the oldest
    assert.strictEqual(writes.length, 1, 'the completed block is not mistaken for this run\'s publication');
    assertLastArchiveWrite(QUICK_ONLY(20), [qs([row(6)])]);
    assert.strictEqual(archiveCount(row(1)), 1, 'the recurring row stays in STATE.md, archived only by the earlier run');
    assert.deepStrictEqual(tableIds(), [...ids(7, 25), '1']);
  });

  test('a phase advance between the kill and an identical combined retry: each entry and row archived once', () => {
    write(stateDoc({ table: rows(1, 30) }));
    killedAfterArchive({ keepRecent: '3', keepRecentQuick: 20 }); // phase 8: cutoff 5
    write(stateDoc({ phase: 11, decisions: [D1, D4, D7], table: rows(1, 30) }));
    const out = run({ keepRecent: '3', keepRecentQuick: 20 }); // phase 11: cutoff 8
    assert.strictEqual(out.cutoff_phase, 8);
    for (const line of [D1, D4, D7, ...rows(1, 10)]) assert.strictEqual(archiveCount(line), 1, `${line} once`);
    assertLastArchiveWrite({ cutoff: 8, keepRecent: 3, keepRecentQuick: 20 }, [ds([D7])], archivePath, 'extend');
    assert.strictEqual(blockCount(), 1);
  });

  test('a retry on a later day that extends the pending block keeps the block\'s date and records the wider cutoff', () => {
    const KILLED_ON = '2026-11-01';
    write(stateDoc({ table: rows(1, 30) }));
    mock.method(realClock, 'localToday', () => KILLED_ON);
    killedAfterArchive({ keepRecent: '3', keepRecentQuick: 20 }); // phase 8: cutoff 5, written on KILLED_ON
    pinDay();
    write(stateDoc({ phase: 11, decisions: [D1, D4, D7], table: rows(1, 30) }));
    const out = run({ keepRecent: '3', keepRecentQuick: 20 }); // DAY, phase 11: cutoff 8 adds D7 to the block
    assert.strictEqual(out.cutoff_phase, 8);
    const plan = assertLastArchiveWrite({ date: KILLED_ON, cutoff: 8, keepRecent: 3, keepRecentQuick: 20 }, [ds([D7])], archivePath, 'extend');
    assert.strictEqual(plan.date, KILLED_ON, 'the run\'s own date (DAY) does not replace the block\'s');
    assert.strictEqual(plan.heading.text, `## Pruned ${KILLED_ON} (phases 1-8, kept recent 3; quick: kept recent 20)`);
    assert.strictEqual(blockCount(), 1);
  });

  // The legacy --keep-recent parsing (unchanged here, see #6542) can record a negative or unsafe K; the recorded K
  // is compared exactly as it was printed, so an identical retry still matches.
  // '-1000000000000000000000' parses to -1e21, which the heading prints as `-1e+21`.
  for (const k of ['-2', '-9007199254740992', '-1000000000000000000000']) {
    test(`a recorded --keep-recent of ${k} still matches an identical combined retry`, () => {
      write(stateDoc({ phase: 3, table: rows(1, 30) }));
      killedAfterArchive({ keepRecent: k, keepRecentQuick: 20 });
      const writes = captureArchiveWrites();
      run({ keepRecent: k, keepRecentQuick: 20 });
      assert.strictEqual(writes.length, 0, 'the retry recognizes its own publication');
      for (const line of [D1, D4, D7, ...rows(1, 10)]) assert.ok(archiveCount(line) <= 1, `${line} at most once`);
      for (const line of [D1, D4, ...rows(1, 10)]) assert.strictEqual(archiveCount(line), 1, `${line} once`);
    });
  }

  test('identical combined arguments across the zero crossing (phase part skipped, then active): rows archived once', () => {
    write(stateDoc({ phase: 2, table: rows(1, 30) }));
    killedAfterArchive({ keepRecent: '3', keepRecentQuick: 20 }); // phase 2: no positive cutoff, `phases none`
    assertLastArchiveWrite({ cutoff: null, keepRecent: 3, keepRecentQuick: 20 }, [qs(rows(1, 10))]);
    write(stateDoc({ phase: 4, table: rows(1, 30) }));
    const out = run({ keepRecent: '3', keepRecentQuick: 20 }); // phase 4: cutoff 1
    assert.strictEqual(out.cutoff_phase, 1);
    for (const line of [D1, ...rows(1, 10)]) assert.strictEqual(archiveCount(line), 1, `${line} once`);
    // The block had no Decisions section yet: it is added at the block's end.
    assertLastArchiveWrite({ cutoff: 1, keepRecent: 3, keepRecentQuick: 20 }, [ds([D1])], archivePath, 'extend');
    assert.deepStrictEqual(tableIds(), ids(11, 30));
  });

  test('identical row text that recurs after a completed run is archived again, as its own occurrence', () => {
    write(stateDoc({ phase: null, table: rows(1, 21) }));
    run({ keepRecentQuick: 20 }); // completed: row 1 archived
    write(stateDoc({ phase: null, table: [...rows(2, 21), row(22), row(23)] }));
    killedAfterArchive({ keepRecentQuick: 20 }); // publishes rows 2-3, killed
    write(stateDoc({ phase: null, table: [row(1), ...rows(2, 21), row(22), row(23)] })); // the identical row 1 text comes back, oldest
    const writes = captureArchiveWrites();
    run({ keepRecentQuick: 20 }); // prunes rows 1-3: 2-3 are the pending block; the new row 1 is not in it
    assert.strictEqual(writes.length, 1);
    assertLastArchiveWrite(QUICK_ONLY(20), [{ section: QUICK, lines: [row(1)] }], archivePath, 'extend');
    assert.strictEqual(archiveCount(row(1)), 2, 'the completed run\'s copy and the new occurrence');
    for (const line of rows(2, 3)) assert.strictEqual(archiveCount(line), 1, `${line} once`);
    assert.deepStrictEqual(tableIds(), ids(4, 23));
  });

  test('a row appended after the kill: a larger N is not adopted and nothing is lost', () => {
    write(stateDoc({ phase: null, table: rows(1, 30) }));
    killedAfterArchive({ keepRecentQuick: 20 });
    write(stateDoc({ phase: null, table: rows(1, 31) }));
    const out = run({ keepRecentQuick: 25 });
    assert.strictEqual(out.keep_recent_quick, 25);
    assert.deepStrictEqual(tableIds(), ids(7, 31));
    for (const line of rows(1, 10)) assert.ok(archiveCount(line) >= 1, `${line} archived`);
  });

  test('an interrupted combined run is completed in both parts by a narrower combined retry', () => {
    write(stateDoc({ table: rows(1, 30) }));
    killedAfterArchive({ keepRecent: '3', keepRecentQuick: 20 }); // cutoff 5
    const archived = archiveText();
    const writes = captureArchiveWrites();
    const out = run({ keepRecent: '5', keepRecentQuick: 25 }); // cutoff 3
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(archiveText(), archived);
    assert.strictEqual(out.cutoff_phase, 5);
    assert.strictEqual(out.keep_recent_quick, 20);
    assert.strictEqual(body(), stateDoc({ decisions: [D7], table: rows(11, 30) }));
  });

  test('an interrupted combined run is completed when only its phase part is wider', () => {
    write(stateDoc({ table: rows(1, 30) }));
    killedAfterArchive({ keepRecent: '3', keepRecentQuick: 20 });
    const writes = captureArchiveWrites();
    const out = run({ keepRecent: '5', keepRecentQuick: 20 });
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(out.cutoff_phase, 5);
    assert.strictEqual(body(), stateDoc({ decisions: [D7], table: rows(11, 30) }));
  });

  for (const [label, first, retry] of [
    ['wider phase part, narrower quick part', { keepRecent: '3', keepRecentQuick: 20 }, { keepRecent: '5', keepRecentQuick: 10 }],
    ['narrower phase part, wider quick part', { keepRecent: '5', keepRecentQuick: 10 }, { keepRecent: '3', keepRecentQuick: 20 }],
  ]) {
    test(`opposite directions (${label}): no completion, the retry's own prune is appended, nothing is lost`, () => {
      write(stateDoc({ table: rows(1, 30) }));
      killedAfterArchive(first);
      const out = run(retry);
      assert.strictEqual(out.keep_recent_quick, retry.keepRecentQuick);
      assert.strictEqual(blockCount(), 2, 'a second block');
      const keptRows = tableIds();
      assert.deepStrictEqual(keptRows, ids(31 - retry.keepRecentQuick, 30));
      // Every entry and row that left STATE.md (both runs reach phases 1 and 4) is archived at least once.
      for (const line of [D1, D4, ...rows(1, 30 - retry.keepRecentQuick)]) assert.ok(archiveCount(line) >= 1, `${line} archived`);
    });
  }

  for (const [label, first, retry] of [
    ['a phase-only run after an interrupted combined run', { keepRecent: '3', keepRecentQuick: 20 }, { keepRecent: '3' }],
    ['a quick-only run after an interrupted combined run', { keepRecent: '3', keepRecentQuick: 20 }, { keepRecentQuick: 20 }],
    ['a combined run after an interrupted quick-only run', { keepRecentQuick: 20 }, { keepRecent: '3', keepRecentQuick: 20 }],
    ['a quick-only run after an interrupted phase-only run', { keepRecent: '3' }, { keepRecentQuick: 20 }],
  ]) {
    test(`${label}: a different set of options appends its whole prune, nothing is lost`, () => {
      write(stateDoc({ table: rows(1, 30) }));
      killedAfterArchive(first);
      const writes = captureArchiveWrites();
      const out = run(retry);
      assert.strictEqual(writes.length, 1, 'one block for this run');
      assert.strictEqual(blockCount(), 2);
      assert.strictEqual(out.total_archived, (retry.keepRecent ? 2 : 0) + (retry.keepRecentQuick !== undefined ? 10 : 0), 'the whole prune');
    });
  }

  test('an interrupted combined run whose quick part archived nothing is still a combined run: a phase-only retry appends its whole prune', () => {
    write(stateDoc({ table: rows(1, 5) }));
    killedAfterArchive({ keepRecent: '3', keepRecentQuick: 20 }); // quick part archives nothing
    run({ keepRecent: '3' });
    assert.strictEqual(blockCount(), 2);
    assert.strictEqual(archiveCount(D1), 2, 'duplicated, not lost');
    assert.strictEqual(body(), stateDoc({ decisions: [D7], table: rows(1, 5) }));
  });

  test('an interrupted combined run whose phase part archived nothing: a quick-only retry appends its whole prune', () => {
    write(stateDoc({ decisions: [D7], table: rows(1, 30) }));
    killedAfterArchive({ keepRecent: '3', keepRecentQuick: 20 }); // phase part archives nothing
    run({ keepRecentQuick: 20 });
    assert.strictEqual(blockCount(), 2);
    assert.strictEqual(archiveCount(row(1)), 2);
    assert.deepStrictEqual(tableIds(), ids(11, 30));
  });

  test('the same combined options after a combined block with an empty quick part: no second block', () => {
    write(stateDoc({ table: rows(1, 5) }));
    killedAfterArchive({ keepRecent: '3', keepRecentQuick: 20 });
    const writes = captureArchiveWrites();
    run({ keepRecent: '3', keepRecentQuick: 20 });
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(archiveCount(D1), 1);
  });

  // ── hand-written archives the renderer never produces ──────────────────

  const handBlock = (heading, sectionLines) => `${ARCHIVE_HEADER}## Pruned 2026-01-01 (${heading})\n\n${sectionLines.join('\n')}\n\n`;
  const ADVERSARIAL = [
    ['a negative N', 'quick: kept recent -1', [`### ${QUICK}`, '', HEADER, DELIM, ...rows(1, 30)]],
    ['an exponent N', 'quick: kept recent 1e3', [`### ${QUICK}`, '', HEADER, DELIM, ...rows(1, 10)]],
    ['an empty N', 'quick: kept recent ', [`### ${QUICK}`, '', HEADER, DELIM, ...rows(1, 10)]],
    ['an unsafe N', 'quick: kept recent 99999999999999999999', [`### ${QUICK}`, '', HEADER, DELIM]],
    ['quick named twice', 'quick: kept recent 0; quick: kept recent 0', [`### ${QUICK}`, '', HEADER, DELIM, ...rows(1, 30)]],
    ['a header-only quick section', 'quick: kept recent 0', [`### ${QUICK}`, '', HEADER, DELIM]],
    ['a header without a delimiter', 'quick: kept recent 0', [`### ${QUICK}`, '', HEADER, ...rows(1, 30)]],
    ['a mismatched delimiter', 'quick: kept recent 0', [`### ${QUICK}`, '', HEADER, '|---|---|', ...rows(1, 30)]],
    // Not something the renderer writes, but every row the prune at its N would move IS in it, verbatim, so it
    // completes like any interrupted N=0 run (the phase prune adopts a hand-written block on the same terms).
    ['a duplicated quick section holding the whole table', 'quick: kept recent 0', [`### ${QUICK}`, '', HEADER, DELIM, ...rows(1, 15), '', `### ${QUICK}`, '', HEADER, DELIM, ...rows(16, 30)], []],
    ['a block cut off mid-row', 'quick: kept recent 0', [`### ${QUICK}`, '', HEADER, DELIM, ...rows(1, 9), '| 10 | task 1']],
    ['a forged N=0 holding part of the table', 'quick: kept recent 0', [`### ${QUICK}`, '', HEADER, DELIM, ...rows(1, 10)]],
    ['a quick section under a phase-only heading', 'phases 1-5, kept recent 3', [`### ${QUICK}`, '', HEADER, DELIM, ...rows(1, 30)]],
    ['a data row shaped like the header', 'quick: kept recent 0', [`### ${QUICK}`, '', HEADER, HEADER, DELIM, ...rows(1, 30)]],
  ];
  for (const [label, heading, lines, expectedLeft = ids(11, 30)] of ADVERSARIAL) {
    test(`a hand-written last block with ${label}: no row leaves STATE.md without being archived, and the rows due are archived`, () => {
      write(stateDoc({ phase: null, table: rows(1, 30) }));
      seedArchive(handBlock(heading, lines), lines);
      run({ keepRecentQuick: 20 });
      const left = new Set(tableIds());
      for (let i = 1; i <= 30; i++) {
        if (!left.has(String(i))) assert.ok(archiveCount(row(i)) >= 1, `row ${i} left STATE.md and must be archived`);
      }
      assert.deepStrictEqual(tableIds(), expectedLeft);
    });
  }

  // ── the archive block IR ───────────────────────────────────────────────

  test('parseLastArchiveBlock reads the quick N and moves the table head out of the quick section', () => {
    const parse = stateLib.parseLastArchiveBlock;
    const text = `${ARCHIVE_HEADER}## Pruned x (phases 1-5, kept recent 3; quick: kept recent 20)\n\n### Decisions\n\n${D1}\n\n### ${QUICK}\n\n${HEADER}\r\n${DELIM}\n${row(1)}\n`;
    assert.deepStrictEqual(parse(text), {
      cutoff: 5, keepRecent: 3, keepRecentQuick: 20,
      sections: [{ section: 'Decisions', lines: [D1] }, { section: QUICK, head: [`${HEADER}\r`, DELIM], lines: [row(1)] }],
    }, 'a quick line keeps its CR; the head is still recognized');
    assert.deepStrictEqual(parse(`## Pruned x (quick: kept recent 7)\n`), { cutoff: null, keepRecent: null, keepRecentQuick: 7, sections: [] });
    assert.deepStrictEqual(parse(`## Pruned x (quick: kept recent 7)\r\n`).keepRecentQuick, 7, 'a CRLF heading');
    for (const bad of ['-1', '1e3', '', '99999999999999999999', ' 3', '٣', '7; quick: kept recent 7', '7, more']) {
      assert.strictEqual(parse(`## Pruned x (quick: kept recent ${bad})\n`).keepRecentQuick, null, `"${bad}" is not an N`);
    }
    assert.strictEqual(parse('## Pruned x (quick: kept recent 7) trailing\n').keepRecentQuick, null, 'not the end of the heading');
    assert.strictEqual(parse('## Pruned x (phases 1-5, kept recent -2; quick: kept recent 7)\n').keepRecent, -2, 'K is signed');
    assert.strictEqual(parse('## Pruned x (phases 1-5, kept recent 99999999999999999999)\n').keepRecent, null, 'an unsafe K');
    assert.deepStrictEqual(parse(`## Pruned x (quick: kept recent 0)\n\n### ${QUICK}\n\n${HEADER}\n${row(1)}\n`).sections,
      [{ section: QUICK, lines: [HEADER, row(1)] }], 'no delimiter: no head, every line is an entry');
    assert.deepStrictEqual(parse(`## Pruned x (phases 1-2, kept recent 3)\n\n### Decisions\n\n${HEADER}\n${DELIM}\n`).sections,
      [{ section: 'Decisions', lines: [HEADER, DELIM] }], 'only the quick section has a table head');
  });

  test('property: a rendered quick block parses back to its N, head and rows', () => {
    const cell = fc.string({ unit: fc.constantFrom('a', 'Z', '0', ' ', '-', '[', ']', 'é'), maxLength: 8 });
    const dataRow = cell.map((c) => `| ${c.trim() || 'x'} | d | 2026 | c | — |`);
    fc.assert(fc.property(fc.array(dataRow, { minLength: 1, maxLength: 8 }), fc.nat(1000), fc.option(fc.nat(50), { nil: null }), (moved, q, cutoff) => {
      const sections = [{ section: QUICK, count: moved.length, lines: moved, head: [HEADER, DELIM] }];
      const plan = stateLib.planStateArchiveAppend(null, sections, { date: DAY, cutoff, keepRecent: cutoff === null ? null : 3, keepRecentQuick: q });
      const parsed = stateLib.parseLastArchiveBlock(stateLib.renderStateArchiveAppend(plan));
      assert.deepStrictEqual(parsed, {
        cutoff, keepRecent: cutoff === null ? null : 3, keepRecentQuick: q, sections: [{ section: QUICK, head: [HEADER, DELIM], lines: moved }],
      });
    }), { seed: 6389 });
  });

  // ── extending the pending block in place (one interrupted run = one block) ─

  describe('planStateArchiveExtend', () => {
    const meta = { date: DAY, cutoff: null, keepRecent: null, keepRecentQuick: 20 };
    // The block keeps the date it was first written on (2026-01-01), not the run's (DAY).
    const NEW_HEADING = '## Pruned 2026-01-01 (quick: kept recent 20)';
    const added = (lines) => [{ section: QUICK, count: lines.length, lines }];

    for (const [label, eol, last] of [
      ['LF', '\n', '\n'],
      ['CRLF', '\r\n', '\r\n'],
      ['mixed (CRLF rows, LF last row)', '\r\n', '\n'],
      ['unterminated last row', '\n', ''],
    ]) {
      test(`${label}: the rows go right after the section's last row and the heading line is replaced`, () => {
        const oldHeading = '## Pruned 2026-01-01 (quick: kept recent 20)';
        const prefix = `# STATE Archive\n\n## Pruned 2025-12-01 (quick: kept recent 5)\n\n### ${QUICK}\n\n${HEADER}\n${DELIM}\n${row(90)}\n\n`;
        const block = `${oldHeading}\n\n### ${QUICK}${eol}${eol}${HEADER}${eol}${DELIM}${eol}${row(1)}${eol}${row(2)}${last}`;
        const text = prefix + block;
        const plan = stateLib.planStateArchiveExtend(text, added([row(3), `${row(4)}\r`]), meta);
        const headingStart = prefix.length;
        const lastRowEnd = text.lastIndexOf(row(2)) + row(2).length + (last === '\r\n' ? 1 : 0); // after the row's own CR
        assert.deepStrictEqual(plan, {
          base: text,
          date: '2026-01-01',
          heading: { start: headingStart, end: headingStart + oldHeading.length, text: NEW_HEADING },
          insertions: [{ offset: lastRowEnd, text: `\n${row(3)}\n${row(4)}\r` }],
          tail: '',
        });
        const rendered = stateLib.renderStateArchiveExtend(plan);
        assert.strictEqual(Buffer.byteLength(rendered),
          Buffer.byteLength(text) - Buffer.byteLength(oldHeading) + Buffer.byteLength(NEW_HEADING) + Buffer.byteLength(`\n${row(3)}\n${row(4)}\r`));
        assert.strictEqual(rendered.slice(0, headingStart), prefix, 'earlier blocks are byte-identical');
      });
    }

    test('a section the block does not have yet is added at the block\'s end, after a blank line', () => {
      for (const ending of ['\n\n', '\n', '']) {
        const text = `# STATE Archive\n\n## Pruned 2026-01-01 (phases none, kept recent 3; quick: kept recent 20)\n\n### ${QUICK}\n\n${HEADER}\n${DELIM}\n${row(1)}${ending}`;
        const plan = stateLib.planStateArchiveExtend(text, [{ section: 'Decisions', count: 1, lines: [D1] }],
          { date: DAY, cutoff: 1, keepRecent: 3, keepRecentQuick: 20 });
        assert.deepStrictEqual(plan.insertions, []);
        assert.strictEqual(plan.tail, `${'\n\n'.slice(ending.length)}### Decisions\n\n${D1}\n\n`);
        assert.strictEqual(plan.heading.text, '## Pruned 2026-01-01 (phases 1-1, kept recent 3; quick: kept recent 20)',
          'the block\'s own date, and the cutoff it now covers');
      }
    });

    test('a heading with no date before its options (hand-written) takes the run\'s date', () => {
      for (const heading of ['## Pruned (quick: kept recent 20)', '## Pruned  (quick: kept recent 20)', '## Pruned 2026-01-01(quick: kept recent 20)']) {
        const text = `# STATE Archive\n\n${heading}\n\n### ${QUICK}\n\n${HEADER}\n${DELIM}\n${row(1)}\n`;
        const plan = stateLib.planStateArchiveExtend(text, added([row(2)]), meta);
        assert.strictEqual(plan.date, DAY, heading);
        assert.strictEqual(plan.heading.text, `## Pruned ${DAY} (quick: kept recent 20)`, heading);
      }
    });

    test('a new quick section carries its table head', () => {
      const text = `# STATE Archive\n\n## Pruned 2026-01-01 (phases 1-5, kept recent 3; quick: kept recent 20)\n\n### Decisions\n\n${D1}\n`;
      const plan = stateLib.planStateArchiveExtend(text, [{ section: QUICK, count: 1, lines: [row(1)], head: [HEADER, DELIM] }],
        { date: DAY, cutoff: 5, keepRecent: 3, keepRecentQuick: 20 });
      assert.strictEqual(plan.tail, `\n### ${QUICK}\n\n${HEADER}\n${DELIM}\n${row(1)}\n\n`);
    });
  });

  // ── the extension path under failure ───────────────────────────────────

  test('a failed archive write while extending the pending block leaves both files byte-identical', () => {
    write(stateDoc({ phase: null, table: rows(1, 30) }));
    killedAfterArchive({ keepRecentQuick: 20 });
    write(stateDoc({ phase: null, table: rows(1, 31) }));
    const stateBefore = fs.readFileSync(statePath);
    const archiveBefore = fs.readFileSync(archivePath);
    failWritesTo(archivePath, 'EIO');
    assert.throws(() => run({ keepRecentQuick: 20 }), (err) => err.code === 'EIO');
    endFaults();
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore);
    assert.deepStrictEqual(fs.readFileSync(archivePath), archiveBefore);
    assert.ok(!fs.existsSync(statePath + '.lock'));
  });

  test('a failed STATE.md write after an extension restores the original pending block, and the retry extends it once', () => {
    write(stateDoc({ table: rows(1, 30) }));
    killedAfterArchive({ keepRecent: '3', keepRecentQuick: 20 }); // phase 8, cutoff 5
    write(stateDoc({ phase: 11, table: rows(1, 30) })); // the retry adds D7 (cutoff 8): a section the block already has
    const archiveBefore = fs.readFileSync(archivePath);
    const stateBefore = fs.readFileSync(statePath);
    failWritesTo(statePath, 'ENOSPC');
    assert.throws(() => run({ keepRecent: '3', keepRecentQuick: 20 }), (err) => err.code === 'ENOSPC');
    endFaults();
    assert.deepStrictEqual(fs.readFileSync(archivePath), archiveBefore, 'the pending block and its heading are back');
    assert.deepStrictEqual(fs.readFileSync(statePath), stateBefore);
    published.pop(); // the rolled-back extension

    run({ keepRecent: '3', keepRecentQuick: 20 });
    assertLastArchiveWrite({ cutoff: 8, keepRecent: 3, keepRecentQuick: 20 }, [ds([D7])], archivePath, 'extend');
    for (const line of [D1, D4, D7, ...rows(1, 10)]) assert.strictEqual(archiveCount(line), 1, `${line} once`);
    assert.strictEqual(blockCount(), 1);
  });

  test('when the archive restore after an extension also fails, both causes surface and the extended archive is kept', () => {
    write(stateDoc({ phase: null, table: rows(1, 30) }));
    killedAfterArchive({ keepRecentQuick: 20 });
    write(stateDoc({ phase: null, table: rows(1, 31) }));
    failWritesTo(statePath, 'ENOSPC');
    mock.method(scp, 'platformRestoreFileSync', () => { const e = new Error('EROFS: simulated'); e.code = 'EROFS'; throw e; });
    let thrown = null;
    try { run({ keepRecentQuick: 20 }); } catch (err) { thrown = err; }
    endFaults();
    assert.ok(thrown instanceof AggregateError);
    assert.deepStrictEqual(thrown.errors.map((e) => e.code), ['ENOSPC', 'EROFS']);
    const extended = archiveWrites[archiveWrites.length - 1];
    assert.strictEqual(fs.readFileSync(archivePath, 'utf-8').length > 0, true);
    assert.strictEqual(Buffer.byteLength(fs.readFileSync(archivePath, 'utf-8')) >= Buffer.byteLength(extended.prior), true,
      'the archive keeps the extension (it may hold the only copy of row 11)');
    const writes = captureArchiveWrites();
    run({ keepRecentQuick: 20 }); // the retry finds row 11 in the pending block
    assert.strictEqual(writes.length, 0);
    assert.deepStrictEqual(tableIds(), ids(12, 31));
  });

  test('subtractPendingBlock never matches the table head and carries it onto the remainder', () => {
    const sub = stateLib.subtractPendingBlock;
    const pruned = [{ section: QUICK, count: 2, lines: [row(1), row(2)], head: [HEADER, DELIM] }];
    assert.deepStrictEqual(sub([{ section: QUICK, head: [HEADER, DELIM], lines: [row(1)] }], pruned),
      { pending: true, remainder: [{ section: QUICK, count: 1, lines: [row(2)], head: [HEADER, DELIM] }] });
    assert.strictEqual(sub([{ section: QUICK, lines: [HEADER] }], pruned).pending, false, 'a header line is not an archived row');
  });

  // ── argument validation ────────────────────────────────────────────────

  const INVALID = [
    ['a missing value', ['--keep-recent-quick']],
    ['a flag-shaped value', ['--keep-recent-quick', '--dry-run']],
    ['an empty value', ['--keep-recent-quick', '']],
    ['a whitespace value', ['--keep-recent-quick', ' ']],
    ['a tab', ['--keep-recent-quick', '\t']],
    ['a negative value', ['--keep-recent-quick', '-1']],
    ['a fraction', ['--keep-recent-quick', '1.5']],
    ['an exponent', ['--keep-recent-quick', '1e2']],
    ['hex', ['--keep-recent-quick', '0x10']],
    ['a plus sign', ['--keep-recent-quick', '+3']],
    ['a leading space', ['--keep-recent-quick', ' 3']],
    ['a trailing space', ['--keep-recent-quick', '3 ']],
    ['a trailing LF', ['--keep-recent-quick', '3\n']],
    ['a trailing CR', ['--keep-recent-quick', '3\r']],
    ['a trailing CRLF', ['--keep-recent-quick', '3\r\n']],
    ['a trailing U+2028', ['--keep-recent-quick', '3\u2028']],
    ['a trailing NBSP', ['--keep-recent-quick', '3\u00a0']],
    ['Unicode digits', ['--keep-recent-quick', '\u0663']],
    ['fullwidth digits', ['--keep-recent-quick', '\uff13']],
    ['an unsafe integer', ['--keep-recent-quick', '99999999999999999999']],
    ['a very long value', ['--keep-recent-quick', '9'.repeat(5000)]],
    ['a word', ['--keep-recent-quick', 'all']],
    ['a repeated flag', ['--keep-recent-quick', '3', '--keep-recent-quick', '4']],
    ['a repeated flag with the same value', ['--keep-recent-quick', '3', '--keep-recent-quick', '3']],
    ['the = form', ['--keep-recent-quick=3']],
    ['command substitution', ['--keep-recent-quick', '$(touch pwned)']],
    ['backticks', ['--keep-recent-quick', '`touch pwned`']],
    ['a command separator', ['--keep-recent-quick', '1; touch pwned']],
    ['an and-list', ['--keep-recent-quick', '1 && touch pwned']],
    ['quotes', ['--keep-recent-quick', '"1"']],
  ];
  for (const [label, args] of INVALID) {
    test(`--keep-recent-quick with ${label} is refused before anything is read or written`, () => {
      write(stateDoc({ phase: null }));
      const before = fs.readFileSync(statePath);
      const result = runGsdTools(['--json-errors', 'state', 'prune', ...args], tmpDir);
      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(JSON.parse(result.error).reason, 'usage');
      assert.strictEqual(result.output, '', 'no result on stdout');
      assert.ok(!/\n\s+at /.test(result.error), 'no stack trace');
      assert.deepStrictEqual(fs.readFileSync(statePath), before, 'STATE.md byte-identical');
      assert.strictEqual(archiveText(), null, 'no archive');
      assert.ok(!fs.existsSync(path.join(tmpDir, 'pwned')), 'nothing was executed');
    });
  }

  for (const value of ['0', '00', '007', '9007199254740991']) {
    test(`--keep-recent-quick ${value} is a whole number and is accepted`, () => {
      write(stateDoc({ phase: null }));
      const result = cli('--keep-recent-quick', value, '--dry-run');
      assert.strictEqual(result.exitCode, 0, result.error);
      assert.strictEqual(JSON.parse(result.output).keep_recent_quick, Number(value));
    });
  }

  for (const bad of [-1, 1.5, NaN, '3', Number.MAX_SAFE_INTEGER + 1]) {
    test(`cmdStatePrune refuses a programmatic keepRecentQuick of ${String(bad)}`, () => {
      write(stateDoc({ phase: null }));
      const before = fs.readFileSync(statePath);
      assert.throws(() => run({ keepRecentQuick: bad }), TypeError);
      assert.deepStrictEqual(fs.readFileSync(statePath), before);
    });
  }

  // ── an unfinished quick batch blocks the quick prune ───────────────────

  function batchWith(statuses) {
    const created = createBatch(tmpDir, statuses.map((_, i) => ({ description: `item ${i}` })));
    assert.strictEqual(created.ok, true, created.reason);
    const manifestPath = path.join(tmpDir, '.planning', 'quick-batches', created.value.batchId, 'BATCH.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.items.forEach((it, i) => { it.status = statuses[i]; });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return { batchId: created.value.batchId, manifestPath };
  }

  for (const status of ['pending', 'failed', 'blocked']) {
    test(`a batch with a ${status} item: --keep-recent-quick is refused (real and dry-run), nothing written`, () => {
      write(stateDoc());
      batchWith(['complete', status]);
      const before = fs.readFileSync(statePath);
      for (const args of [['--keep-recent-quick', '1'], ['--keep-recent-quick', '1', '--dry-run'], ['--keep-recent', '3', '--keep-recent-quick', '1']]) {
        const result = runGsdTools(['--json-errors', 'state', 'prune', ...args], tmpDir);
        assert.strictEqual(result.exitCode, 1);
        assert.strictEqual(JSON.parse(result.error).reason, 'quick_batch_unfinished');
        assert.deepStrictEqual(fs.readFileSync(statePath), before);
        assert.strictEqual(archiveText(), null);
      }
    });
  }

  test('an unfinished batch does not block a phase-only prune', () => {
    write(stateDoc());
    batchWith(['pending']);
    const out = JSON.parse(cli('--keep-recent', '3').output);
    assert.strictEqual(out.total_archived, 2);
  });

  test('a corrupt BATCH.json blocks the quick prune (it cannot be shown to be finished)', () => {
    write(stateDoc());
    const { manifestPath } = batchWith(['complete']);
    fs.writeFileSync(manifestPath, '{ not json');
    const result = runGsdTools(['--json-errors', 'state', 'prune', '--keep-recent-quick', '1'], tmpDir);
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(JSON.parse(result.error).reason, 'quick_batch_unfinished');
  });

  test('finished batches, a batch directory without BATCH.json, and no batch directory at all do not block it', () => {
    write(stateDoc({ phase: null }));
    assert.strictEqual(cli('--keep-recent-quick', '4').exitCode, 0, 'no quick-batches directory');
    write(stateDoc({ phase: null }));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'quick-batches', 'not-a-batch'), { recursive: true });
    batchWith(['complete', 'complete']);
    const result = cli('--keep-recent-quick', '4');
    assert.strictEqual(result.exitCode, 0, result.error);
    assert.strictEqual(JSON.parse(result.output).total_archived, 1);
  });

  test('a batch item completed again after its row was pruned is not appended a second time', () => {
    write(stateDoc({ phase: null, table: [] }));
    const created = createBatch(tmpDir, [{ description: 'a' }, { description: 'b' }]);
    const [a, b] = created.value.manifest.items;
    for (const it of [a, b]) {
      const done = completeQuickItem(tmpDir, created.value.batchId, it.quick_id, { description: it.description, date: '2026-11-08', commit: 'c' });
      assert.strictEqual(done.ok, true, done.reason);
    }
    run({ keepRecentQuick: 0 });
    assert.deepStrictEqual(tableIds(), []);
    const again = completeQuickItem(tmpDir, created.value.batchId, a.quick_id, { description: a.description, date: '2026-11-08', commit: 'c' });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.value.appended, false);
    assert.deepStrictEqual(tableIds(), [], 'the pruned row is not written back');
  });
});
