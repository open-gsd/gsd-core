'use strict';

/**
 * Tests for verification-status module (issue #651).
 *
 * Covers:
 *  1. status: passed → routing
 *  2. status: gaps_found with phase token extraction
 *  3. status: human_needed → routing
 *  4. No *-VERIFICATION.md → 'missing'
 *  5. Frontmatter status present but unknown value → 'unknown'
 *  6. BROAD-GREP REGRESSION: body `status:` lines ignored, frontmatter wins
 *  7. PARITY: VERIFIER_STATUSES covered by routing table; gsd-verifier.md emitted statuses covered
 *  8. CRLF line endings in frontmatter
 *  9. Body-only file (no frontmatter block) → missing
 * 10. Nonexistent phase directory → missing
 * 11. Multiple *-VERIFICATION.md files → first by sort
 * 12. ship.md PHASE_VERIFICATION_INCOMPLETE sentinel (contract anchor for #651 consolidation)
 *
 * PORTABILITY: pure JS — no shell-outs, no bash fences.
 * Cross-platform (passes on Windows). Ref: DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup } = require('./helpers.cjs');

const {
  VERIFIER_STATUSES,
  VERIFICATION_ROUTING_TABLE,
  defaultPhaseCleanCommitTimesMs,
  readVerificationStatus,
} = require('../gsd-core/bin/lib/verification.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a temporary phase directory under os.tmpdir().
 * Returns the absolute path; caller must clean up.
 */
function mkPhaseDir(suffix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gsd-651-${suffix}-`));
}

/**
 * Write a *-VERIFICATION.md file with the given frontmatter status and
 * optional body content.
 *
 * @param {string} dir          - Phase directory path
 * @param {string} filename     - e.g. '01-review-VERIFICATION.md'
 * @param {string} status       - Frontmatter status value
 * @param {string} [body]       - Content after the closing `---`
 */
function writeVerificationMd(dir, filename, status, body = '') {
  const frontmatter = `---\nstatus: ${status}\n---\n`;
  fs.writeFileSync(path.join(dir, filename), frontmatter + body);
}

function setMtime(filePath, iso) {
  const time = new Date(iso);
  fs.utimesSync(filePath, time, time);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('verification-status', () => {

  // ── Case 1: passed ────────────────────────────────────────────────────────
  test('status: passed → next_command is empty, status is passed', () => {
    const dir = mkPhaseDir('passed');
    try {
      writeVerificationMd(dir, '01-foo-VERIFICATION.md', 'passed');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'passed', 'status must be passed');
      assert.equal(result.next_command, '', 'next_command must be empty for passed');
      assert.ok(result.next_action.length > 0, 'next_action must be non-empty');
    } finally {
      cleanup(dir);
    }
  });

  // ── Case 2: gaps_found with phase token extraction ────────────────────────
  test('status: gaps_found in "03-foo" dir → next_command includes phase token 03', () => {
    // Phase dir basename starts with "03" — extractPhaseToken('03-foo') → '03'
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-651-parent-'));
    const phaseDir = path.join(baseDir, '03-foo');
    fs.mkdirSync(phaseDir);
    try {
      writeVerificationMd(phaseDir, '03-foo-VERIFICATION.md', 'gaps_found');
      const result = readVerificationStatus(phaseDir);
      assert.equal(result.status, 'gaps_found', 'status must be gaps_found');
      assert.ok(
        result.next_command.includes('03'),
        `next_command should include phase token '03'; got: ${result.next_command}`,
      );
      assert.ok(
        result.next_command.includes('--gaps'),
        `next_command should include --gaps; got: ${result.next_command}`,
      );
      assert.equal(result.next_command, '/gsd:plan-phase 03 --gaps');
    } finally {
      cleanup(baseDir);
    }
  });

  // ── Case 3: human_needed ──────────────────────────────────────────────────
  test('status: human_needed → status human_needed, next_command is empty', () => {
    const dir = mkPhaseDir('human-needed');
    try {
      writeVerificationMd(dir, '01-hn-VERIFICATION.md', 'human_needed');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'human_needed');
      assert.equal(result.next_command, '');
      assert.ok(result.next_action.length > 0);
    } finally {
      cleanup(dir);
    }
  });

  // ── Case 4: no *-VERIFICATION.md → missing ────────────────────────────────
  test('no *-VERIFICATION.md file → status missing, next_command execute-phase', () => {
    const dir = mkPhaseDir('missing');
    try {
      // write a non-matching file to confirm it is ignored
      fs.writeFileSync(path.join(dir, 'README.md'), '# phase');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'missing');
      assert.equal(result.next_command, '/gsd:execute-phase');
      assert.ok(result.next_action.includes('verify step never completed'));
    } finally {
      cleanup(dir);
    }
  });

  // ── Case 5: unknown frontmatter status value ──────────────────────────────
  test("frontmatter status 'bogus' → status unknown, next_command execute-phase", () => {
    const dir = mkPhaseDir('unknown');
    try {
      writeVerificationMd(dir, '01-u-VERIFICATION.md', 'bogus');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'unknown');
      assert.equal(result.next_command, '/gsd:execute-phase');
      assert.ok(
        result.next_action.includes('bogus'),
        `next_action should mention the raw value; got: ${result.next_action}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // ── Case 6: BROAD-GREP REGRESSION (critical) ──────────────────────────────
  //
  // Frontmatter: `status: passed`
  // Body: a fenced code block containing `status: gaps_found` AND `status: human_needed`
  // Result MUST be 'passed' — proving body lines are NOT matched.
  // This is the exact failure mode that issue #586 / PR #650 hit.
  //
  test('BROAD-GREP REGRESSION: body status lines ignored, frontmatter status wins', () => {
    const dir = mkPhaseDir('broad-grep');
    try {
      const bodyWithEmbeddedStatuses = [
        '',
        '## Section',
        '',
        'Some prose about the results.',
        '',
        '```yaml',
        'status: gaps_found',
        'gaps:',
        '  - fix the thing',
        '```',
        '',
        'Another block:',
        '',
        '```',
        'status: human_needed',
        '```',
        '',
        'End of document.',
      ].join('\n');

      writeVerificationMd(dir, '01-bg-VERIFICATION.md', 'passed', bodyWithEmbeddedStatuses);

      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'passed',
        `Expected status 'passed' (frontmatter wins); got '${result.status}'. ` +
          'Body status: lines must NOT be matched.',
      );
      assert.equal(result.next_command, '', 'next_command must be empty for passed');
    } finally {
      cleanup(dir);
    }
  });

  // ── Case 7: PARITY ASSERTION ──────────────────────────────────────────────
  //
  // (a) Every value in VERIFIER_STATUSES has a corresponding key in VERIFICATION_ROUTING_TABLE.
  // (b) Parse agents/gsd-verifier.md for emitted statuses via /→ \*\*status:\s*([a-z_]+)\*\*/g,
  //     collect the set, and assert every emitted status is a routing key.
  //
  test('PARITY: VERIFIER_STATUSES covered by routing table', () => {
    for (const s of VERIFIER_STATUSES) {
      assert.ok(
        s in VERIFICATION_ROUTING_TABLE,
        `VERIFIER_STATUS '${s}' has no entry in VERIFICATION_ROUTING_TABLE`,
      );
    }
  });

  test('PARITY: gsd-verifier.md emitted statuses all have routing table entries', () => {
    const verifierPath = path.join(__dirname, '..', 'agents', 'gsd-verifier.md');
    const content = fs.readFileSync(verifierPath, 'utf-8');

    const emittedStatuses = new Set();

    // Source (a): decision-tree arrow lines — `→ **status: <value>**`
    // These are the per-branch emission points in Step 9 (the decision tree).
    const reArrow = /→ \*\*status:\s*([a-z_]+)\*\*/g;
    let m;
    while ((m = reArrow.exec(content)) !== null) {
      emittedStatuses.add(m[1]);
    }

    // Source (b): output-template line — `status: A | B | C` (pipe-delimited list
    // of permitted values inside the frontmatter template block in the <output> section).
    // Anchored to lines that start with `status:` and contain `|` to avoid false
    // matches on prose sentences that happen to mention "status:".
    const reTemplate = /^status:\s+([a-z_]+(?:\s*\|\s*[a-z_]+)+)\s*$/gm;
    while ((m = reTemplate.exec(content)) !== null) {
      for (const token of m[1].split('|')) {
        const t = token.trim();
        if (t) emittedStatuses.add(t);
      }
    }

    assert.ok(
      emittedStatuses.size > 0,
      'No emitted statuses found in gsd-verifier.md — regex or file path may be wrong. ' +
        'Checked: (a) → **status: X** arrow lines, (b) status: A | B | C template lines.',
    );

    for (const s of emittedStatuses) {
      assert.ok(
        s in VERIFICATION_ROUTING_TABLE,
        `gsd-verifier.md emits status '${s}' but VERIFICATION_ROUTING_TABLE has no entry for it. ` +
          'Add a route or remove/rename the status in gsd-verifier.md.',
      );
    }
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  // CRLF line endings in frontmatter
  test('CRLF line endings in frontmatter → correct status parsed', () => {
    const dir = mkPhaseDir('crlf');
    try {
      // Construct a file with CRLF line endings throughout
      const content = '---\r\nstatus: passed\r\nphase: 01-demo\r\n---\r\n\r\n# Body\r\n';
      fs.writeFileSync(path.join(dir, '01-crlf-VERIFICATION.md'), content);
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'passed', 'CRLF frontmatter must parse to passed');
      assert.equal(result.next_command, '');
    } finally {
      cleanup(dir);
    }
  });

  // File with NO frontmatter block — body-only `status:` line must NOT be matched
  test('body-only file with no frontmatter block (status: in body) → missing', () => {
    const dir = mkPhaseDir('no-fm');
    try {
      // No opening `---` — this is a plain markdown file with a status: line in the body
      const content = '# Phase Verification\n\nstatus: passed\n\nSome notes.\n';
      fs.writeFileSync(path.join(dir, '01-nofm-VERIFICATION.md'), content);
      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'missing',
        "A body-only status: line must NOT be read — result should be 'missing'",
      );
    } finally {
      cleanup(dir);
    }
  });

  // Missing / nonexistent phase directory → missing
  test('nonexistent phase directory → missing', () => {
    const nonexistent = path.join(os.tmpdir(), 'gsd-651-nonexistent-' + Date.now());
    const result = readVerificationStatus(nonexistent);
    assert.equal(result.status, 'missing', 'unreadable/nonexistent dir must return missing');
    assert.equal(result.next_command, '/gsd:execute-phase');
  });

  // Multiple *-VERIFICATION.md files → deterministic pick (first by sort)
  test('multiple *-VERIFICATION.md files in dir → first by sort order wins', () => {
    const dir = mkPhaseDir('multi');
    try {
      // Write two files: alphabetically "01-a" comes before "02-b"
      // "01-a" has passed; "02-b" has gaps_found — first by sort must win
      const fm = (status) => `---\nstatus: ${status}\n---\n`;
      fs.writeFileSync(path.join(dir, '01-a-VERIFICATION.md'), fm('passed'));
      fs.writeFileSync(path.join(dir, '02-b-VERIFICATION.md'), fm('gaps_found'));
      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'passed',
        'When multiple *-VERIFICATION.md files exist, the first by lexicographic sort must be used',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('passed verification older than a summary returns stale', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-651-parent-'));
    const dir = path.join(baseDir, '01-stale-passed');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '01-VERIFICATION.md');
      const summaryPath = path.join(dir, '01-01-SUMMARY.md');
      writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
      fs.writeFileSync(summaryPath, '# Summary');
      setMtime(verificationPath, '2026-01-01T00:00:00.000Z');
      setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

      // git times unavailable → mtime-fallback path (#2348). Injected so the
      // test stays hermetic (no git spawn) regardless of tmpdir repo state.
      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(result.status, 'stale');
      assert.match(result.next_action, /stale/i);
      assert.equal(result.next_command, '/gsd:verify-work 01');
    } finally {
      cleanup(baseDir);
    }
  });

  test('gaps_found verification older than a summary still returns gaps_found (not stale)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-651-parent-'));
    const dir = path.join(baseDir, '01-stale-gaps');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '01-VERIFICATION.md');
      const summaryPath = path.join(dir, '01-01-SUMMARY.md');
      writeVerificationMd(dir, '01-VERIFICATION.md', 'gaps_found');
      fs.writeFileSync(summaryPath, '# Summary');
      setMtime(verificationPath, '2026-01-01T00:00:00.000Z');
      setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'gaps_found');
      assert.equal(result.next_command, '/gsd:plan-phase 01 --gaps');
    } finally {
      cleanup(baseDir);
    }
  });

  test('human_needed verification older than nested plans/SUMMARY-NN.md returns stale', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-651-parent-'));
    const dir = path.join(baseDir, '01-stale-human-nested');
    fs.mkdirSync(dir);
    try {
      const plansDir = path.join(dir, 'plans');
      fs.mkdirSync(plansDir);
      const verificationPath = path.join(dir, '01-VERIFICATION.md');
      const summaryPath = path.join(plansDir, 'SUMMARY-01-manual.md');
      writeVerificationMd(dir, '01-VERIFICATION.md', 'human_needed');
      fs.writeFileSync(summaryPath, '# Summary');
      setMtime(verificationPath, '2026-01-01T00:00:00.000Z');
      setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

      // git times unavailable → mtime-fallback path (#2348).
      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(result.status, 'stale');
      assert.equal(result.next_command, '/gsd:verify-work 01');
    } finally {
      cleanup(baseDir);
    }
  });

  // ── #2348: staleness derived from git commit time, not filesystem mtime ────
  //
  // The verification staleness gate must survive a fresh `git clone` / `cp -R`
  // and an unrelated `touch`. It compares git commit times (content-tied) and
  // only falls back to mtime when a file has no commit time (uncommitted / no
  // repo), always reading both sides of a comparison from the same clock.

  // Injectable per-phase git-commit-time resolver: given the phase-relative file
  // names, returns Map<file, epoch-ms>. A file whose basename is absent from
  // `byBase` resolves to "no git time" (uncommitted / not in git) → mtime clock.
  const phaseCleanTimes = (byBase) => (_phaseDir, files) => {
    const m = new Map();
    for (const file of files) {
      const base = file.split(/[\\/]/).pop();
      if (Object.prototype.hasOwnProperty.call(byBase, base)) m.set(file, byBase[base]);
    }
    return m;
  };

  // git availability for the real-subprocess integration test below.
  const GIT_AVAILABLE = (() => {
    try {
      require('node:child_process').execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  test('committed passed verification is NOT stale from mtime skew alone when the summary was not committed later (#2348)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-parent-'));
    const dir = path.join(baseDir, '02-clone-skew');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '02-VERIFICATION.md');
      const summaryPath = path.join(dir, '02-02-SUMMARY.md');
      writeVerificationMd(dir, '02-VERIFICATION.md', 'passed');
      fs.writeFileSync(summaryPath, '# Summary');
      // Filesystem mtimes reproduce the reported 49s checkout skew (summary newer).
      setMtime(verificationPath, '2026-07-16T22:53:49.000Z');
      setMtime(summaryPath, '2026-07-16T22:54:38.000Z');
      // But in git both were committed together — the summary is not newer.
      const phaseCleanCommitTimesMs = phaseCleanTimes({
        '02-VERIFICATION.md': Date.parse('2026-07-16T22:50:00.000Z'),
        '02-02-SUMMARY.md': Date.parse('2026-07-16T22:50:00.000Z'),
      });

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(
        result.status,
        'passed',
        'mtime skew alone must not override a committed passing verification',
      );
      assert.equal(result.next_command, '');
    } finally {
      cleanup(baseDir);
    }
  });

  test('committed verification IS stale when the summary was committed later, even if its mtime is older — git clock wins (#2348)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-parent-'));
    const dir = path.join(baseDir, '02-git-stale');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '02-VERIFICATION.md');
      const summaryPath = path.join(dir, '02-02-SUMMARY.md');
      writeVerificationMd(dir, '02-VERIFICATION.md', 'passed');
      fs.writeFileSync(summaryPath, '# Summary');
      // mtimes point the OTHER way (verification newer) to prove git is authoritative.
      setMtime(verificationPath, '2026-07-16T23:00:00.000Z');
      setMtime(summaryPath, '2026-07-16T22:00:00.000Z');
      const phaseCleanCommitTimesMs = phaseCleanTimes({
        '02-VERIFICATION.md': Date.parse('2026-07-16T22:50:00.000Z'),
        '02-02-SUMMARY.md': Date.parse('2026-07-16T22:55:00.000Z'), // committed later
      });

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(result.status, 'stale');
      assert.equal(result.next_command, '/gsd:verify-work 02');
    } finally {
      cleanup(baseDir);
    }
  });

  test('git-clock staleness boundary: summary committed at V-1 / V / V+1 relative to verification (#2348)', () => {
    const V = Date.parse('2026-07-16T22:50:00.000Z');
    for (const { deltaMs, expected } of [
      { deltaMs: -1, expected: 'passed' },
      { deltaMs: 0, expected: 'passed' },
      { deltaMs: 1, expected: 'stale' },
    ]) {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-boundary-'));
      const dir = path.join(baseDir, '03-boundary');
      fs.mkdirSync(dir);
      try {
        const verificationPath = path.join(dir, '03-VERIFICATION.md');
        const summaryPath = path.join(dir, '03-03-SUMMARY.md');
        writeVerificationMd(dir, '03-VERIFICATION.md', 'passed');
        fs.writeFileSync(summaryPath, '# Summary');
        setMtime(verificationPath, '2026-07-16T22:50:00.000Z');
        setMtime(summaryPath, '2026-07-16T22:50:00.000Z');
        const phaseCleanCommitTimesMs = phaseCleanTimes({
          '03-VERIFICATION.md': V,
          '03-03-SUMMARY.md': V + deltaMs,
        });

        const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
        assert.equal(
          result.status,
          expected,
          `summary committed at V${deltaMs >= 0 ? '+' : ''}${deltaMs}ms should be ${expected}`,
        );
      } finally {
        cleanup(baseDir);
      }
    }
  });

  test('a committed-clean verification is stale when a summary is edited afterward (dirty) — the edit is not shadowed by the summary commit time (#2348 dirty regression)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-dirty-'));
    const dir = path.join(baseDir, '02-dirty-summary');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '02-VERIFICATION.md');
      const summaryPath = path.join(dir, '02-02-SUMMARY.md');
      writeVerificationMd(dir, '02-VERIFICATION.md', 'passed');
      fs.writeFileSync(summaryPath, '# Summary');
      // Verification is committed & clean at 22:50. The summary is DIRTY (edited
      // on disk after its commit) so it is absent from the clean-commit map and
      // must be timed by its mtime — a later edit at 22:54.
      setMtime(verificationPath, '2026-07-16T22:50:00.000Z'); // unused (clean → commit time)
      setMtime(summaryPath, '2026-07-16T22:54:00.000Z');
      const phaseCleanCommitTimesMs = phaseCleanTimes({
        '02-VERIFICATION.md': Date.parse('2026-07-16T22:50:00.000Z'),
        // '02-02-SUMMARY.md' intentionally omitted → treated as dirty → mtime.
      });

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(
        result.status,
        'stale',
        'a dirty summary edited after the verification must stale it via mtime, not be shadowed by an equal/earlier commit time',
      );
      assert.equal(result.next_command, '/gsd:verify-work 02');
    } finally {
      cleanup(baseDir);
    }
  });

  test('both files uncommitted (no clean-commit time) fall back to mtime ordering (#2348)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-uncommitted-'));
    const dir = path.join(baseDir, '02-uncommitted');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '02-VERIFICATION.md');
      const summaryPath = path.join(dir, '02-02-SUMMARY.md');
      writeVerificationMd(dir, '02-VERIFICATION.md', 'passed');
      fs.writeFileSync(summaryPath, '# Summary');
      // Neither file is committed → empty clean map → pure mtime comparison.
      setMtime(verificationPath, '2026-07-16T23:00:00.000Z');
      setMtime(summaryPath, '2026-07-16T22:00:00.000Z'); // summary older → not stale
      const phaseCleanCommitTimesMs = phaseCleanTimes({});

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(result.status, 'passed', 'summary older on the mtime clock → not stale');
    } finally {
      cleanup(baseDir);
    }
  });

  test('the git-commit-time resolver is invoked at most once per phase, regardless of summary count (#2348 no per-file fan-out)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-fanout-'));
    const dir = path.join(baseDir, '01-fanout');
    fs.mkdirSync(dir);
    try {
      writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
      for (const n of ['01', '02', '03']) {
        fs.writeFileSync(path.join(dir, `01-${n}-SUMMARY.md`), '# Summary');
      }
      let calls = 0;
      let filesSeen = 0;
      const phaseCleanCommitTimesMs = (_phaseDir, files) => {
        calls += 1;
        filesSeen = files.length;
        return new Map();
      };

      readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(calls, 1, 'exactly one git walk for the whole phase, not one per summary file');
      assert.equal(filesSeen, 4, 'the single walk receives the verification file + all 3 summaries');
    } finally {
      cleanup(baseDir);
    }
  });

  test('a phase with no summary files performs zero git walks and is never stale (#2348)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-nosummary-'));
    const dir = path.join(baseDir, '01-no-summary');
    fs.mkdirSync(dir);
    try {
      writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
      let calls = 0;
      const phaseCleanCommitTimesMs = () => {
        calls += 1;
        return new Map();
      };

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(result.status, 'passed');
      assert.equal(calls, 0, 'no summaries → nothing can be newer → skip the git subprocess entirely');
    } finally {
      cleanup(baseDir);
    }
  });

  test(
    'real git: a summary committed after the verification reads stale via the real git clock, even for a dash-named file (#2348 end-to-end + `--` argv guard)',
    { skip: GIT_AVAILABLE ? false : 'git binary not available' },
    () => {
      const { execFileSync } = require('node:child_process');
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-realgit-'));
      const runGit = (args, extraEnv) =>
        execFileSync('git', args, {
          cwd: repo,
          stdio: 'pipe',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(extraEnv || {}) },
        });
      const commitEnvAt = (iso) => ({ GIT_AUTHOR_DATE: iso + '+00:00', GIT_COMMITTER_DATE: iso + '+00:00' });
      try {
        runGit(['init', '-q']);
        runGit(['config', 'user.email', 'test@example.com']);
        runGit(['config', 'user.name', 'Test']);
        runGit(['config', 'commit.gpgsign', 'false']);

        const dir = path.join(repo, '.planning', 'phases', '01-real');
        fs.mkdirSync(dir, { recursive: true });
        const verificationPath = path.join(dir, '01-VERIFICATION.md');
        // A leading-dash filename exercises the `--` pathspec guard in the real
        // `git log` argv: if `--` were dropped git would read it as a flag.
        const summaryName = '-danger-SUMMARY.md';
        const summaryPath = path.join(dir, summaryName);

        fs.writeFileSync(verificationPath, '---\nstatus: passed\n---\n');
        runGit(['add', '--', verificationPath]);
        runGit(['commit', '-q', '-m', 'add verification'], commitEnvAt('2026-07-16T22:50:00'));

        fs.writeFileSync(summaryPath, '# Summary');
        runGit(['add', '--', summaryPath]);
        runGit(['commit', '-q', '-m', 'add summary later'], commitEnvAt('2026-07-16T22:55:00'));

        // Make mtimes claim the OPPOSITE order so only the git clock can stale it.
        setMtime(summaryPath, '2000-01-01T00:00:00.000Z');
        setMtime(verificationPath, '2030-01-01T00:00:00.000Z');

        // No seam injected → the real defaultPhaseCleanCommitTimesMs / execGit path.
        const result = readVerificationStatus(dir);
        assert.equal(
          result.status,
          'stale',
          'summary committed after the verification must read stale on the real git clock, and the dash-named file must resolve through the `--` pathspec guard',
        );
        assert.equal(result.next_command, '/gsd:verify-work 01');
      } finally {
        cleanup(repo);
      }
    },
  );

  test(
    'real git: a committed summary edited on disk (dirty) reads stale via mtime, not shadowed by its commit time (#2348 dirty regression, end-to-end)',
    { skip: GIT_AVAILABLE ? false : 'git binary not available' },
    () => {
      const { execFileSync } = require('node:child_process');
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-realgit-dirty-'));
      const runGit = (args, extraEnv) =>
        execFileSync('git', args, {
          cwd: repo,
          stdio: 'pipe',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(extraEnv || {}) },
        });
      const commitEnvAt = (iso) => ({ GIT_AUTHOR_DATE: iso + '+00:00', GIT_COMMITTER_DATE: iso + '+00:00' });
      try {
        runGit(['init', '-q']);
        runGit(['config', 'user.email', 'test@example.com']);
        runGit(['config', 'user.name', 'Test']);
        runGit(['config', 'commit.gpgsign', 'false']);

        const dir = path.join(repo, '.planning', 'phases', '01-real');
        fs.mkdirSync(dir, { recursive: true });
        const verificationPath = path.join(dir, '01-VERIFICATION.md');
        const summaryPath = path.join(dir, '01-01-SUMMARY.md');

        fs.writeFileSync(verificationPath, '---\nstatus: passed\n---\n');
        fs.writeFileSync(summaryPath, '# Summary');
        // Commit BOTH together — identical commit time, so commit time alone
        // would read "not stale".
        runGit(['add', '--', verificationPath, summaryPath]);
        runGit(['commit', '-q', '-m', 'add phase'], commitEnvAt('2026-07-16T22:50:00'));

        // Edit the summary again WITHOUT committing → working tree diverges from HEAD.
        fs.writeFileSync(summaryPath, '# Summary edited');
        setMtime(verificationPath, '2026-07-16T22:50:00.000Z'); // clean → commit time used
        setMtime(summaryPath, '2026-07-16T22:54:00.000Z'); // dirty → this later mtime is used

        const result = readVerificationStatus(dir);
        assert.equal(
          result.status,
          'stale',
          'a committed-then-edited (dirty) summary must read stale via mtime, not be shadowed by its now-stale commit time',
        );
        assert.equal(result.next_command, '/gsd:verify-work 01');
      } finally {
        cleanup(repo);
      }
    },
  );

  // ── #2348: default resolver two-call error handling (hermetic, injected execGit) ──

  const okResult = (stdout) => ({ exitCode: 0, stdout, stderr: '', signal: null, error: null });
  const errResult = () => ({
    exitCode: 127,
    stdout: '',
    stderr: 'git: not found',
    signal: null,
    error: new Error('ENOENT'),
  });
  const nonzeroResult = () => ({ exitCode: 128, stdout: '', stderr: 'fatal', signal: null, error: null });
  // Fake execGit dispatching on the git subcommand (args[0]).
  const fakeExecGit = ({ log, diff }) => (args) => {
    if (args[0] === 'log') return log;
    if (args[0] === 'diff') return diff;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  // Reverse-chronological `git log --name-only` fixture: summary newer than verification.
  const LOG_OUT = [
    '2000',
    '',
    '.planning/phases/01-x/01-01-SUMMARY.md',
    '',
    '1000',
    '',
    '.planning/phases/01-x/01-VERIFICATION.md',
  ].join('\n');
  const FILES = ['01-VERIFICATION.md', '01-01-SUMMARY.md'];

  test('resolver: parses commit times and drops a file the dirty-check reports (#2348)', () => {
    const map = defaultPhaseCleanCommitTimesMs(
      '/repo/.planning/phases/01-x',
      FILES,
      fakeExecGit({ log: okResult(LOG_OUT), diff: okResult('.planning/phases/01-x/01-01-SUMMARY.md') }),
    );
    assert.equal(map.get('01-VERIFICATION.md'), 1000 * 1000, 'verification commit time (seconds→ms)');
    assert.equal(map.has('01-01-SUMMARY.md'), false, 'dirty summary dropped → will use mtime');
  });

  test('resolver: clean tree (dirty-check reports nothing) keeps all commit times (#2348)', () => {
    const map = defaultPhaseCleanCommitTimesMs(
      '/repo/.planning/phases/01-x',
      FILES,
      fakeExecGit({ log: okResult(LOG_OUT), diff: okResult('') }),
    );
    assert.equal(map.get('01-VERIFICATION.md'), 1000 * 1000);
    assert.equal(map.get('01-01-SUMMARY.md'), 2000 * 1000);
  });

  test('resolver: FAILS SAFE (empty map) when the dirty-check errors after git log succeeds (#2348)', () => {
    const map = defaultPhaseCleanCommitTimesMs(
      '/repo/.planning/phases/01-x',
      FILES,
      fakeExecGit({ log: okResult(LOG_OUT), diff: errResult() }),
    );
    assert.equal(
      map.size,
      0,
      'an inconclusive dirty-check must discard commit times so every file falls back to mtime',
    );
  });

  test('resolver: FAILS SAFE (empty map) when the dirty-check exits non-zero (#2348)', () => {
    const map = defaultPhaseCleanCommitTimesMs(
      '/repo/.planning/phases/01-x',
      FILES,
      fakeExecGit({ log: okResult(LOG_OUT), diff: nonzeroResult() }),
    );
    assert.equal(map.size, 0);
  });

  test('resolver: empty map (mtime fallback) when git log itself fails (#2348)', () => {
    const map = defaultPhaseCleanCommitTimesMs(
      '/repo/.planning/phases/01-x',
      FILES,
      // diff would throw if consulted — proves log-failure short-circuits before it.
      fakeExecGit({ log: errResult(), diff: undefined }),
    );
    assert.equal(map.size, 0);
  });

  // ── Task 2 (B1): ship.md gate sentinel contract anchor ────────────────────
  //
  // The deleted tests/ship-586-verification-routing.test.cjs was the only
  // thing asserting that ship.md emits the PHASE_VERIFICATION_INCOMPLETE block
  // sentinel (its user-visible gate error key). This test re-anchors that contract.
  //
  test('ship.md still emits the PHASE_VERIFICATION_INCOMPLETE gate sentinel (contract anchor for #651 consolidation)', () => {
    const shipMdPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md');
    const content = fs.readFileSync(shipMdPath, 'utf-8');
    assert.ok(
      content.includes('PHASE_VERIFICATION_INCOMPLETE'),
      'ship.md must contain the literal PHASE_VERIFICATION_INCOMPLETE gate sentinel. ' +
        'If you renamed or removed it, update the verification routing and this contract test.',
    );
  });

});
