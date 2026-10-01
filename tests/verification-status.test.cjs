'use strict';

// docs-guard-exempt: #5095 fixtures use 'docs/VERIFICATION.md' (a fixture
// basename proving the report-shaped filter matches on basename, not path)
// and 'docs/planning/...' (an in-repo `.planning -> docs/planning` symlink
// alias fixture) — both are tmpdir fixture paths this file WRITES, never a
// read of real shipped docs/ content.

/**
 * Tests for verification-status module (issue #651).
 *
 * Covers:
 *  1. status: passed → routing
 *  2. status: gaps_found with phase token extraction
 *  3. status: human_needed → routing
 *  4. No *-VERIFICATION.md → 'missing'
 *  5. Frontmatter status present but out of the closed set → VerificationStatusError (#5118)
 *  6. BROAD-GREP REGRESSION: body `status:` lines ignored, frontmatter wins
 *  7. PARITY: VERIFIER_STATUSES covered by routing table; gsd-verifier.md emitted statuses covered
 *  8. CRLF line endings in frontmatter
 *  9. Body-only file (no frontmatter block) → missing
 * 10. Nonexistent phase directory → phase_dir_not_found (#5118)
 * 11. Multiple *-VERIFICATION.md files, none matching the phase's own token →
 *     alphabetically-first FALLBACK wins (the phase-pinned rule's #2 tier —
 *     see #3492 below for the primary, phase-pinned tier)
 * 12. ship.md PHASE_VERIFICATION_INCOMPLETE sentinel (contract anchor for #651 consolidation)
 * 13. #3357/#3492: `<phase-token>-VERIFICATION.md` resolution — resolveVerificationFile
 *     unit coverage plus behavioral tests through readVerificationStatus and
 *     findStaleVerificationSummary. THE CONTRACT (#3492): a candidate whose
 *     name exactly matches THIS phase's own token always wins, even over a
 *     different phase's canonically-shaped file; alphabetical-first among all
 *     dashed candidates is only the fallback when no exact match exists. The
 *     resolveVerificationFile unit tests are the reliable anchors for this —
 *     the readVerificationStatus/findStaleVerificationSummary behavioral tests
 *     are illustrative (their outcome also depends on directory-basename
 *     token derivation, not exercised in isolation there).
 *
 * PORTABILITY: pure JS — no shell-outs, no bash fences.
 * Cross-platform (passes on Windows). Ref: DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup, createTempGitProject } = require('./helpers.cjs');
const { runGit: seamRunGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const {
  VERIFIER_STATUSES,
  VERIFICATION_ROUTES,
  defaultPhaseCleanCommitTimesMs,
  resolveVerificationFile,
  resolveUatFile,
  readVerificationStatus,
  findStaleVerificationSummary,
  isPhaseComplete,
  computeCoveredDigest,
  sharedPlanningRoots,
  isSharedPlanningDoc,
  parseFingerprintVersion,
  parseFingerprintFileArgs,
} = require('../gsd-core/bin/lib/verification.cjs');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a temporary phase directory named like a real one (`NN-slug`),
 * inside a throwaway parent. #3511: a phase directory's own name determines
 * which files count as ITS artifacts, so a fixture whose basename does not
 * name the same phase as the files written into it is not a valid phase dir.
 * @param {string} suffix       - test-distinguishing suffix for the parent
 * @param {string} phaseDirName - basename of the phase dir (default '01-foo')
 */
function mkPhaseDir(suffix, phaseDirName = '01-foo') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-651-${suffix}-`));
  const phaseDir = path.join(parent, phaseDirName);
  fs.mkdirSync(phaseDir);
  return phaseDir;
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
      cleanup(path.dirname(dir));
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
      assert.equal(result.next_command, '/gsd-plan-phase 03 --gaps');
    } finally {
      cleanup(baseDir);
    }
  });

  // ── Case 3: human_needed ──────────────────────────────────────────────────
  test('status: human_needed → status human_needed, next_command is empty', () => {
    // Deliberately non-numeric dir basename ("human-needed" has no digits at
    // all) — extractPhaseToken has no derivable token, so (a) isPhaseArtifact's
    // fail-safe still includes 01-hn-VERIFICATION.md as this "phase"'s own
    // report, and (b) the next_command number-append check (which requires a
    // PURELY numeric token) never fires. This is what this test is actually
    // pinning — see the comment below — so the dir name must stay non-numeric,
    // not the realistic 'NN-slug' default.
    const dir = mkPhaseDir('human-needed', 'human-needed');
    try {
      writeVerificationMd(dir, '01-hn-VERIFICATION.md', 'human_needed');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'human_needed');
      // #2617: human_needed now names the command the next_action describes.
      // This fixture's dir is not phase-shaped, so no number is appended.
      assert.equal(result.next_command, '/gsd-verify-work');
      assert.ok(result.next_action.length > 0);
    } finally {
      cleanup(path.dirname(dir));
    }
  });

  // ── Case 4: no *-VERIFICATION.md → missing ────────────────────────────────
  test('no *-VERIFICATION.md file → status missing, next_command execute-phase', () => {
    // Non-numeric dir basename: next_command asserts no phase-number argument
    // is appended, which requires extractPhaseToken(dirName) to not be purely
    // numeric — see the human_needed test above for the same rationale.
    const dir = mkPhaseDir('missing', 'missing');
    try {
      // write a non-matching file to confirm it is ignored
      fs.writeFileSync(path.join(dir, 'README.md'), '# phase');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'missing');
      assert.equal(result.next_command, '/gsd-execute-phase');
      assert.ok(result.next_action.includes('verify step never completed'));
      assert.ok(
        result.next_action.includes('does not re-run plans that already have a SUMMARY.md'),
        `next_action must reassure the user execute-phase will not redo work (#1762); got: ${result.next_action}`,
      );
    } finally {
      cleanup(path.dirname(dir));
    }
  });

  // ── Case 5: out-of-set frontmatter status value (#5118) ───────────────────
  // Was: routed as 'unknown' → execute-phase. VerificationStatus is closed now:
  // a value outside the writer set is a hard error where it is read.
  test("frontmatter status 'bogus' is out of the closed set → VerificationStatusError (#5118)", (t) => {
    const dir = mkPhaseDir('unknown', 'unknown');
    t.after(() => cleanup(path.dirname(dir)));
    writeVerificationMd(dir, '01-u-VERIFICATION.md', 'bogus');
    const { VerificationStatusError } = require('../gsd-core/bin/lib/verification.cjs');
    assert.equal(typeof VerificationStatusError, 'function', 'VerificationStatusError must be exported');
    assert.throws(() => readVerificationStatus(dir), VerificationStatusError);
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
      cleanup(path.dirname(dir));
    }
  });

  // ── Case 7: PARITY ASSERTION ──────────────────────────────────────────────
  //
  // (a) Every value in VERIFIER_STATUSES has a corresponding key in VERIFICATION_ROUTES (#5118: the one table).
  // (b) Parse agents/gsd-verifier.md for emitted statuses via /→ \*\*status:\s*([a-z_]+)\*\*/g,
  //     collect the set, and assert every emitted status is a routing key.
  //
  test('PARITY: VERIFIER_STATUSES covered by routing table', () => {
    for (const s of VERIFIER_STATUSES) {
      assert.ok(
        s in VERIFICATION_ROUTES,
        `VERIFIER_STATUS '${s}' has no entry in VERIFICATION_ROUTES`,
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
        s in VERIFICATION_ROUTES,
        `gsd-verifier.md emits status '${s}' but VERIFICATION_ROUTES has no entry for it. ` +
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
      cleanup(path.dirname(dir));
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
      cleanup(path.dirname(dir));
    }
  });

  // Nonexistent phase directory → phase_dir_not_found (#5118, ADR-5057 amendment 2).
  // Was 'missing' → /gsd-execute-phase: there was nothing to look in, which is a
  // usage error, not a verify step that never ran (#4987).
  test('nonexistent phase directory → phase_dir_not_found, never execute-phase', (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-651-nonexistent-'));
    t.after(() => cleanup(parent));
    const result = readVerificationStatus(path.join(parent, 'gone'));
    assert.equal(result.status, 'phase_dir_not_found', 'a nonexistent dir is a usage error, not a missing report');
    assert.equal(result.next_command, '');
  });

  // Multiple *-VERIFICATION.md files, NEITHER matching the phase dir's own
  // token → deterministic FALLBACK pick (first by sort). This is the #2 tier
  // of the #3492 phase-pinned rule, not the contract itself — see the
  // `#3357/#3492` describe block below for the primary, phase-pinned tier
  // (resolveVerificationFile unit tests are the reliable anchors there).
  // The dir basename ('multi', no digits) has no derivable phase token, so
  // scopeToPhase's isPhaseArtifact fail-safe passes BOTH candidates through
  // unfiltered (#3511: scopeToPhase is a plain filter with no other
  // fallback — a derivable token that matched neither file would empty the
  // set and this test would read 'missing', not exercise the alphabetical
  // tiebreak at all).
  test('multiple *-VERIFICATION.md files, none matching the phase token → alphabetically-first FALLBACK wins', () => {
    const dir = mkPhaseDir('multi', 'multi');
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
        'With no exact phase-token match, the first by lexicographic sort must be used',
      );
    } finally {
      cleanup(path.dirname(dir));
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
      // #4682: stale means covered source changed after the verifier ran — the
      // only remedy is re-running the verifier. execute-phase resumes at the
      // verification gates and re-runs it (its resume tree routes a stale
      // report to re-verification); /gsd-verify-work never rewrote the report,
      // so routing there was an advice loop.
      assert.equal(result.next_command, '/gsd-execute-phase 01');
      assert.doesNotMatch(result.next_command, /verify-work/);
      assert.match(result.next_action, /verifier/i,
        'the stale action must name the verifier re-run as the remedy');
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
      assert.equal(result.next_command, '/gsd-plan-phase 01 --gaps');
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
      assert.equal(result.next_command, '/gsd-execute-phase 01');
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
    // Soft probe — a missing/broken git binary must resolve to `false`, not
    // throw, so seamRunGit is used directly rather than gitOrThrow.
    const r = seamRunGit(['--version'], { timeoutMs: GIT_TIMEOUT_MS });
    return r.outcome === OUTCOME.EXITED && r.exitCode === 0;
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
      assert.equal(result.next_command, '/gsd-execute-phase 02');
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
      assert.equal(result.next_command, '/gsd-execute-phase 02');
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
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-realgit-'));
      const runGit = (args, extraEnv) =>
        gitOrThrow(args, {
          cwd: repo,
          timeoutMs: GIT_TIMEOUT_MS,
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
        assert.equal(result.next_command, '/gsd-execute-phase 01');
      } finally {
        cleanup(repo);
      }
    },
  );

  test(
    'real git: a committed summary edited on disk (dirty) reads stale via mtime, not shadowed by its commit time (#2348 dirty regression, end-to-end)',
    { skip: GIT_AVAILABLE ? false : 'git binary not available' },
    () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-realgit-dirty-'));
      const runGit = (args, extraEnv) =>
        gitOrThrow(args, {
          cwd: repo,
          timeoutMs: GIT_TIMEOUT_MS,
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
        assert.equal(result.next_command, '/gsd-execute-phase 01');
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

// ─── #3357/#3492: phase-pinned *-VERIFICATION.md resolution ──────────────────
//
// A phase dir can legitimately hold more than one `*-VERIFICATION.md` — the
// real per-phase report (`03-VERIFICATION.md`) alongside an ad-hoc plan
// worksheet (`03-CORRECTION-VERIFICATION.md`). The original "alphabetically
// first" pick chose the worksheet ('C' < 'V'), and a worksheet with no
// frontmatter `status:` made the whole phase read `missing` even though a
// passing report sat right next to it (#3357).
//
// #3492 REGRESSION this block anchors: the #3357 fix's first cut preferred
// ANY canonically-shaped `<token>-VERIFICATION.md`, regardless of WHOSE token
// it carried — so a stray cross-phase or sentinel-numbered canonical file
// (`999-VERIFICATION.md`) could outrank the querying phase's own (possibly
// non-canonical) report. THE CONTRACT (verified against the built lib):
//   ['12-review-VERIFICATION.md', '999-VERIFICATION.md'] resolves to
//     '12-review-VERIFICATION.md' for phase token '12' (was '999-…').
//   ['03-CORRECTION-VERIFICATION.md', '04-VERIFICATION.md'] resolves to
//     '04-VERIFICATION.md' for phase token '04' (was '03-CORRECTION-…').
// resolveVerificationFile is the single resolver findStaleVerificationSummary,
// readVerificationStatus, the Phase Status Module's `phaseStatus()` (#5060,
// consumed by commands.cts's cmdProgressRender/cmdStats), and both
// init.cts verification_path projectors all call, every one pinned to its own
// phaseDir's token (#3473 F2 / #3492).
//
// These resolveVerificationFile unit tests are the RELIABLE ANCHORS for the
// phase-pinned rule (a real `phaseToken` string, no filesystem/readdir order
// involved). The readVerificationStatus/findStaleVerificationSummary
// behavioral tests further down are illustrative only — their outcome
// additionally depends on the temp directory's basename tokenizing the way
// the test expects.
describe('#3357/#3492: phase-pinned *-VERIFICATION.md resolution when multiple candidates exist', () => {

  test('#3492 regression counterexample 1: a sentinel-numbered stray file does not outrank this phase\'s own non-canonical report', () => {
    assert.equal(
      resolveVerificationFile(
        ['12-review-VERIFICATION.md', '999-VERIFICATION.md'],
        { phaseToken: '12-review' },
      ),
      '12-review-VERIFICATION.md',
      'this phase (token "12-review") owns 12-review-VERIFICATION.md; 999-VERIFICATION.md is a different phase and must not win',
    );
  });

  test('#3492 regression counterexample 2: a cross-phase CORRECTION worksheet does not outrank this phase\'s own canonical report', () => {
    assert.equal(
      resolveVerificationFile(
        ['03-CORRECTION-VERIFICATION.md', '04-VERIFICATION.md'],
        { phaseToken: '04' },
      ),
      '04-VERIFICATION.md',
      'this phase (token "04") owns 04-VERIFICATION.md; the 03-CORRECTION worksheet belongs to a different phase',
    );
  });

  test('exact phase-token match wins over an ad-hoc -CORRECTION- worksheet for the SAME phase', () => {
    assert.equal(
      resolveVerificationFile(
        ['03-CORRECTION-VERIFICATION.md', '03-VERIFICATION.md'],
        { phaseToken: '03' },
      ),
      '03-VERIFICATION.md',
      'the phase\'s own 03-VERIFICATION.md must win over its CORRECTION worksheet, not lose alphabetically',
    );
  });

  test('order-independence: same candidates reversed → same answer', () => {
    assert.equal(
      resolveVerificationFile(
        ['03-VERIFICATION.md', '03-CORRECTION-VERIFICATION.md'],
        { phaseToken: '03' },
      ),
      '03-VERIFICATION.md',
      'input order must not change which file is selected',
    );
  });

  test('decimal phase token: 35.1-VERIFICATION.md wins over a -CORRECTION- sibling', () => {
    assert.equal(
      resolveVerificationFile(
        ['35.1-CORRECTION-VERIFICATION.md', '35.1-VERIFICATION.md'],
        { phaseToken: '35.1' },
      ),
      '35.1-VERIFICATION.md',
    );
  });

  test('letter-suffixed phase token: 03A-VERIFICATION.md wins over a -CORRECTION- sibling', () => {
    assert.equal(
      resolveVerificationFile(
        ['03A-CORRECTION-VERIFICATION.md', '03A-VERIFICATION.md'],
        { phaseToken: '03A' },
      ),
      '03A-VERIFICATION.md',
    );
  });

  test('multi-canonical tiebreak: no exact phase-token match among several canonically-shaped candidates → alphabetically first', () => {
    // Neither candidate's token is "50" — this is the (b) fallback tier, and
    // it must stay a plain alphabetical pick (not a second, separate
    // "canonical-shaped" preference — that concept no longer exists; #3492
    // removed it because it was exactly the regression mechanism above).
    assert.equal(
      resolveVerificationFile(
        ['12-VERIFICATION.md', '999-VERIFICATION.md'],
        { phaseToken: '50' },
      ),
      '12-VERIFICATION.md',
      '"12-VERIFICATION.md" sorts before "999-VERIFICATION.md" and neither matches phase token "50"',
    );
  });

  test('fallback: only a non-canonical file present → that file is still returned', () => {
    // Load-bearing: a phase whose only report is non-canonically named must
    // keep resolving to it, not to null — even when the phase token is known
    // and does not exactly match.
    assert.equal(
      resolveVerificationFile(['01-review-VERIFICATION.md'], { phaseToken: '01' }),
      '01-review-VERIFICATION.md',
    );
  });

  test('fallback determinism: several non-canonical files, no phase token given → alphabetically first (unchanged)', () => {
    assert.equal(
      resolveVerificationFile(['02-b-VERIFICATION.md', '01-a-VERIFICATION.md']),
      '01-a-VERIFICATION.md',
    );
  });

  test('no phaseToken and no exact match → falls back to alphabetically-first, never null, when candidates exist', () => {
    // #3492: an undeliverable/absent phase token must degrade to the original
    // pre-#3357 behavior (alphabetically-first), not to null.
    assert.equal(
      resolveVerificationFile(['999-VERIFICATION.md', '03-CORRECTION-VERIFICATION.md']),
      '03-CORRECTION-VERIFICATION.md',
      'with no phaseToken, plain alphabetical order decides — "03-…" sorts before "999-…"',
    );
  });

  test('no matches → null', () => {
    assert.equal(resolveVerificationFile(['03-PLAN.md', '03-SUMMARY.md'], { phaseToken: '03' }), null);
  });

  test('unrelated files are not miscounted as candidates', () => {
    // 03-PLAN.md / 03-SUMMARY.md never end in "-VERIFICATION.md". A bare
    // "VERIFICATION.md" (no leading phase-token dash) is also never a
    // candidate — it fails the very `.endsWith('-VERIFICATION.md')` filter
    // that builds the candidate list in the first place (the string is one
    // character too short to end with a leading-dash suffix).
    assert.equal(
      resolveVerificationFile(['03-PLAN.md', '03-SUMMARY.md', 'VERIFICATION.md'], { phaseToken: '03' }),
      null,
      'a bare VERIFICATION.md is never a dashed candidate',
    );
  });

  // #3511 reconciliation: resolveVerificationFile's fallback now scopes to
  // isPhaseArtifact(fileName, phaseDirName), so a stray cross-phase file can
  // no longer win the alphabetical-first fallback tier either — closing the
  // gap isPhaseArtifact's own docblock (src/phase-id.cts) used to flag as
  // open. The two pure cases below are the reliable anchors; the behavioral
  // test after them pins the same contract through the real CLI-facing
  // readVerificationStatus call path.
  test('#3511: a cross-phase stray is excluded from the fallback → null, not the stray', () => {
    assert.equal(
      resolveVerificationFile(['04-VERIFICATION.md'], { phaseDirName: '03-foo' }),
      null,
      '04-VERIFICATION.md belongs to phase 04, not the "03-foo" directory\'s phase 03 — must not be returned',
    );
  });

  test('#3511: a non-canonically-named report OF THIS phase still wins the fallback (the #3357 guarantee survives)', () => {
    // The more important of the two #3511 cases: isPhaseArtifact scopes by
    // phase-number membership, not by canonical shape, so this file still
    // passes and the #3357 "non-canonical report still resolves" guarantee
    // is not disturbed by the #3511 scoping.
    assert.equal(
      resolveVerificationFile(['03-CORRECTION-VERIFICATION.md'], { phaseDirName: '03-foo' }),
      '03-CORRECTION-VERIFICATION.md',
      '03-CORRECTION-VERIFICATION.md names phase 03, same as directory "03-foo" — must still resolve',
    );
  });

  test('#3511: cross-phase stray alongside this phase\'s own non-canonical report → own report wins, stray excluded (not merely outsorted)', () => {
    // Distinguishes "excluded from the fallback" from "just happens to sort
    // after" — candidates are sorted at verification.cts's own call site
    // before reaching resolveVerificationFile, and '01-VERIFICATION.md'
    // sorts BEFORE '03-CORRECTION-VERIFICATION.md' alphabetically, so an
    // UNSCOPED (alphabetical-first) fallback would wrongly pick the stray
    // here. Scoping must actively exclude it for '03-CORRECTION-…' to win.
    assert.equal(
      resolveVerificationFile(
        ['01-VERIFICATION.md', '03-CORRECTION-VERIFICATION.md'],
        { phaseDirName: '03-foo' },
      ),
      '03-CORRECTION-VERIFICATION.md',
    );
  });

  // WARNING-2/5/INFO-2 note (#3511 review): the only fallback test above uses
  // a token-LESS dir ("03-foo" isn't token-less — this refers to the earlier
  // `multiple *-VERIFICATION.md files, none matching the phase token` test,
  // which passes no derivable-token distinguishing fixture and so passes
  // identically pre-#3511-fix). This test uses a dir WITH a derivable token
  // (`03-foo` → token "03") and TWO candidates that BOTH belong to that same
  // phase (`03-a-…`/`03-b-…`, no exact `03-VERIFICATION.md`), so scoping
  // excludes nothing and the alphabetical-first tie-break still decides —
  // pinning that scoping does not disturb the ordinary same-phase-multi-file
  // case.
  test('#3511: alphabetical fallback when BOTH candidates are this phase\'s own (derivable token, no exact match)', () => {
    assert.equal(
      resolveVerificationFile(['03-a-VERIFICATION.md', '03-b-VERIFICATION.md'], { phaseDirName: '03-foo' }),
      '03-a-VERIFICATION.md',
      'both candidates belong to phase 03 (same as dir "03-foo"); alphabetically-first must still win',
    );
  });

  test('behavioral (readVerificationStatus): a phase dir holding only a cross-phase stray reports missing, not the stray\'s status (#3511)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3511-stray-only-'));
    const dir = path.join(baseDir, '03-foo');
    fs.mkdirSync(dir);
    try {
      // Only a stray belonging to phase 04 sits in phase 03's directory. Give
      // it a status that would NOT read as missing if it were (wrongly) picked,
      // so a regression here is loud rather than accidentally matching.
      writeVerificationMd(dir, '04-VERIFICATION.md', 'passed');

      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'missing',
        'a phase dir holding only another phase\'s report must report missing, not passed',
      );
    } finally {
      cleanup(baseDir);
    }
  });

  test('behavioral (readVerificationStatus): a phase dir holding only its own non-canonically-named report still resolves it (#3357 guarantee survives #3511 scoping)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3511-own-noncanon-'));
    const dir = path.join(baseDir, '03-foo');
    fs.mkdirSync(dir);
    try {
      writeVerificationMd(dir, '03-CORRECTION-VERIFICATION.md', 'passed');

      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'passed',
        'the phase\'s own non-canonically-named report must still resolve, not read as missing',
      );
    } finally {
      cleanup(baseDir);
    }
  });

  test('behavioral (readVerificationStatus): a phase with both its own report and a cross-phase stray reports the OWN report\'s status, not the stray\'s', () => {
    // The directory basename is "03-canonical-test" so extractPhaseToken
    // derives token "03" — the exact same derivation readVerificationStatus
    // performs internally, so this exercises the real production call path
    // (not just the pure resolver), pinned to counterexample 2's shape.
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3492-parent-'));
    const dir = path.join(baseDir, '03-canonical-test');
    fs.mkdirSync(dir);
    try {
      // A stray cross-phase canonical file with a DIFFERENT status — must not
      // be picked for THIS (token "03") phase.
      writeVerificationMd(dir, '99-VERIFICATION.md', 'gaps_found');
      // This phase's own (non-canonical, ad-hoc) report — must win.
      writeVerificationMd(dir, '03-CORRECTION-VERIFICATION.md', 'passed');

      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'passed',
        'the phase must report its OWN report\'s status, not a cross-phase stray\'s',
      );
    } finally {
      cleanup(baseDir);
    }
  });

  test('behavioral (readVerificationStatus): a phase with both its own canonical report and an ad-hoc worksheet reports the canonical report\'s status, not missing (#3357 original regression)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3357-parent-'));
    const dir = path.join(baseDir, '03-canonical-test');
    fs.mkdirSync(dir);
    try {
      // The ad-hoc worksheet has no frontmatter `status:` at all — this is
      // the exact original #3357 failure mode: 'C' < 'V' picked this file
      // first and the phase read 'missing' despite the passing report sitting
      // right next to it.
      fs.writeFileSync(
        path.join(dir, '03-CORRECTION-VERIFICATION.md'),
        '# Ad-hoc correction worksheet\n\nNo frontmatter status here.\n',
      );
      writeVerificationMd(dir, '03-VERIFICATION.md', 'passed');

      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'passed',
        'the phase must report the canonical report\'s status, not missing',
      );
    } finally {
      cleanup(baseDir);
    }
  });

  test('behavioral (findStaleVerificationSummary): staleness is checked against THIS phase\'s own report, not a cross-phase stray', () => {
    // A stray cross-phase file ("99-VERIFICATION.md") is alphabetically AFTER
    // this phase's own "03-VERIFICATION.md", so this also demonstrates the
    // pin is not merely riding on alphabetical luck.
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3492-stale-parent-'));
    const dir = path.join(baseDir, '03-stale-pin-test');
    fs.mkdirSync(dir);
    try {
      writeVerificationMd(dir, '03-VERIFICATION.md', 'passed');
      writeVerificationMd(dir, '99-VERIFICATION.md', 'passed');
      setMtime(path.join(dir, '03-VERIFICATION.md'), '2020-01-01T00:00:00Z');
      setMtime(path.join(dir, '99-VERIFICATION.md'), '2020-01-01T00:00:00Z');

      // Root-style summary placement (mirrors the #2348 fixtures above) —
      // scanPhasePlans's nested-layout matcher requires `SUMMARY-<NN>...md`
      // inside a `plans/` subdir; a root-named `03-01-SUMMARY.md` dropped into
      // `plans/` matches neither isRootSummaryFile (wrong directory) nor
      // isNestedSummaryFile (wrong filename shape), so summaryFiles reads
      // empty and the phase is never stale — not what this test means to
      // exercise.
      const summaryPath = path.join(dir, '03-01-SUMMARY.md');
      fs.writeFileSync(summaryPath, '# summary\n');
      setMtime(summaryPath, '2021-01-01T00:00:00Z');

      // Force the mtime path (no git clock) by injecting an empty resolver —
      // mirrors the existing #2348 test pattern elsewhere in this file.
      const result = findStaleVerificationSummary(dir, fs, () => new Map());
      assert.equal(result.determined, true);
      assert.equal(result.stale, true, 'the phase\'s own 03-VERIFICATION.md is older than its summary');
      assert.equal(
        result.verificationFile,
        '03-VERIFICATION.md',
        'staleness must be computed against the phase\'s own report, not the cross-phase 99-VERIFICATION.md stray',
      );
    } finally {
      cleanup(baseDir);
    }
  });

});

// ─── #3473 F2: resolveVerificationFile allowBare option ──────────────────────
//
// the Phase Status Module's `phaseStatus()` (#5060, commands.cts's phase-status
// surface) and two verification_path projectors in
// init.cts each hand-rolled a fourth variant of this same selection: they
// additionally accept a BARE `VERIFICATION.md`, which this module's own two
// callers (findStaleVerificationSummary, readVerificationStatus) originally
// did not. `allowBare` threads that one behavioral difference through the
// single resolver instead of leaving a fourth hand-rolled implementation
// behind (#3473 F2). A bare match is ranked BELOW any dashed candidate —
// canonical or not — because a dashed file names its phase and a bare one
// does not. Since #4187 the two module-internal call sites pass `allowBare:
// true` as well (see the #4187 describe below), so every reader of the report
// set now agrees; the option's default remains `false` for callers that have
// not opted in.
describe('#3473 F2: resolveVerificationFile allowBare option', () => {

  test('allowBare defaults to false — a bare-only list returns null without the option', () => {
    assert.equal(resolveVerificationFile(['VERIFICATION.md']), null);
  });

  test('allowBare:true, bare-only candidate → bare file returned', () => {
    assert.equal(
      resolveVerificationFile(['VERIFICATION.md'], { allowBare: true }),
      'VERIFICATION.md',
    );
  });

  test('allowBare:true, bare + non-canonical dashed → the dashed fallback wins', () => {
    assert.equal(
      resolveVerificationFile(
        ['VERIFICATION.md', '01-review-VERIFICATION.md'],
        { allowBare: true },
      ),
      '01-review-VERIFICATION.md',
      'a dashed non-canonical file names its phase and must win over a bare match',
    );
  });

  test('allowBare:true, bare + canonical → the canonical file wins', () => {
    assert.equal(
      resolveVerificationFile(
        ['VERIFICATION.md', '03-VERIFICATION.md'],
        { allowBare: true },
      ),
      '03-VERIFICATION.md',
    );
  });

  // #3511: allowBare must still fall through to the bare match when the ONLY
  // dashed candidate is excluded by phaseDirName scoping (a cross-phase
  // stray) — the fallback tier finding nothing phase-owned is the same
  // "no dashed candidate at all" case allowBare was always reached from.
  test('#3511: allowBare:true, bare + a cross-phase dashed stray scoped out by phaseDirName → the bare file wins', () => {
    assert.equal(
      resolveVerificationFile(
        ['VERIFICATION.md', '04-VERIFICATION.md'],
        { allowBare: true, phaseDirName: '03-foo' },
      ),
      'VERIFICATION.md',
      '04-VERIFICATION.md belongs to a different phase and is excluded, so bare VERIFICATION.md is the only remaining candidate',
    );
  });

});

// ─── #4187: a bare VERIFICATION.md is a first-class report on the status surface ──
//
// `query verification.resolve-file` (cmdVerificationResolveFile), the phase-status
// surface (the Phase Status Module's `phaseStatus()`, #5060) and both init verification_path
// projectors all resolve a BARE `VERIFICATION.md` — but readVerificationStatus
// (the reader behind `query verification.status`, isPhaseComplete, and the state/
// roadmap completion projections) called the same shared resolver WITHOUT
// `allowBare`, so a phase whose only report was bare read as `missing` and was
// told to re-run execute-phase even when the report said `status: passed`.
// Two read-only verbs disagreed about the same directory at the same instant
// (#4187). The fix opts the status reader — and findStaleVerificationSummary,
// its internal legacy staleness check, whose only production caller is
// readVerificationStatus — into the same `allowBare: true` the other four call
// sites already pass. Tier order is unchanged: a dashed candidate (canonical or
// not) still outranks the bare name, so only bare-ONLY directories change
// behavior, from `missing` to the report's actual frontmatter status.
describe('#4187: status surface recognizes a bare VERIFICATION.md', () => {

  test('#4187 regression: bare VERIFICATION.md with status: passed reads as passed, not missing', (t) => {
    const dir = mkPhaseDir('bare-passed', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'passed', 'a bare report is a report — the phase is verified');
    assert.equal(result.next_command, '', 'passed must route to no next command');
    assert.equal(result.staleCheckIndeterminate, undefined, 'the staleness check must run to completion');
  });

  test('#4187: bare report with status: human_needed routes to verify-work', (t) => {
    const dir = mkPhaseDir('bare-human', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'human_needed');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'human_needed');
    assert.equal(result.next_command, '/gsd-verify-work 99');
  });

  test('#4187: bare report with status: gaps_found routes to plan-phase --gaps', (t) => {
    const dir = mkPhaseDir('bare-gaps', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'gaps_found');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'gaps_found');
    assert.equal(result.next_command, '/gsd-plan-phase 99 --gaps');
  });

  test('#4187 negative space: no verification file at all still reads missing with the execute-phase recommendation', (t) => {
    const dir = mkPhaseDir('bare-none', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    const result = readVerificationStatus(dir);
    assert.equal(result.status, 'missing', 'a genuinely absent report must stay missing');
    assert.equal(result.next_command, '/gsd-execute-phase 99', 'the missing recommendation is correct here and must not change');
  });

  test('#4187 parity: bare + canonical dashed report — the dashed file wins on the status surface too', (t) => {
    const dir = mkPhaseDir('bare-vs-dashed', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'gaps_found');
    writeVerificationMd(dir, '99-VERIFICATION.md', 'passed');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'passed', 'a dashed file names its phase and must outrank the bare match');
  });

  test('#4187 parity: bare + cross-phase dashed stray — #3511 scoping falls through to the bare report', (t) => {
    const dir = mkPhaseDir('bare-vs-stray', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    writeVerificationMd(dir, '04-VERIFICATION.md', 'gaps_found');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'passed', 'the stray belongs to phase 04; the bare file is this phase\'s only own report');
  });

  test('#4187 parity: same-dir non-canonical dashed report only — unchanged behavior', (t) => {
    const dir = mkPhaseDir('dashed-noncanon', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, '99-CORRECTION-VERIFICATION.md', 'passed');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'passed');
  });

  test('#4187: directory scoping — a bare report in a DIFFERENT directory does not leak into the queried one', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4187-otherdir-'));
    t.after(() => cleanup(baseDir));
    const queried = path.join(baseDir, '99-probe');
    const neighbor = path.join(baseDir, '98-other');
    fs.mkdirSync(queried);
    fs.mkdirSync(neighbor);
    writeVerificationMd(neighbor, 'VERIFICATION.md', 'passed');

    const result = readVerificationStatus(queried);
    assert.equal(result.status, 'missing', 'the neighbor directory\'s report must not answer for the queried one');
  });

  test('#4187: bare report with no frontmatter block resolves but reads missing', (t) => {
    const dir = mkPhaseDir('bare-no-fm', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    fs.writeFileSync(path.join(dir, 'VERIFICATION.md'), '# Verification\n');
    const result = readVerificationStatus(dir);
    assert.equal(result.status, 'missing', 'a resolved file with no frontmatter status is the pre-existing missing path');
  });

  test('#4187 staleness: a bare report older than its summary reads stale (legacy mtime path)', (t) => {
    const dir = mkPhaseDir('bare-stale', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    setMtime(path.join(dir, 'VERIFICATION.md'), '2020-01-01T00:00:00Z');
    // Root-style summary placement — mirrors the #3492 fixture above.
    const summaryPath = path.join(dir, '99-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, '# summary\n');
    setMtime(summaryPath, '2021-01-01T00:00:00Z');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'stale', 'a bare report must be staleness-checked like a dashed one');
    assert.equal(result.next_command, '/gsd-execute-phase 99');
  });

  test('#4187 unit (findStaleVerificationSummary): staleness is computed against the bare report', (t) => {
    const dir = mkPhaseDir('bare-stale-unit', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    setMtime(path.join(dir, 'VERIFICATION.md'), '2020-01-01T00:00:00Z');
    const summaryPath = path.join(dir, '99-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, '# summary\n');
    setMtime(summaryPath, '2021-01-01T00:00:00Z');

    const result = findStaleVerificationSummary(dir, fs, () => new Map());
    assert.equal(result.determined, true);
    assert.equal(result.stale, true);
    assert.equal(result.verificationFile, 'VERIFICATION.md', 'the staleness seam must see the bare report');
  });
});

// ─── #4142: bracket convention reaches the legacy staleness seam ────────────
//
// readVerificationStatus resolves the report once to read its frontmatter and
// findStaleVerificationSummary resolves it again for the legacy mtime check.
// Both resolutions must receive the same convention or a bracket directory can
// read status from its own report, then compute staleness from a cross-phase
// stray in that same directory.
describe('#4142: opts.convention threads through findStaleVerificationSummary', () => {
  test('a bracket phase checks staleness against its own report, not a newer cross-phase stray', (t) => {
    const dir = mkPhaseDir('bracket-stale-thread', 'GSD.02-03-three');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, '03-VERIFICATION.md', 'passed');
    writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
    setMtime(path.join(dir, '03-VERIFICATION.md'), '2020-01-01T00:00:00Z');
    setMtime(path.join(dir, '01-VERIFICATION.md'), '2022-01-01T00:00:00Z');
    const summaryPath = path.join(dir, '03-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, '# summary\n');
    setMtime(summaryPath, '2021-01-01T00:00:00Z');

    const result = readVerificationStatus(dir, {
      convention: 'bracket',
      phaseCleanCommitTimesMs: () => new Map(),
    });

    assert.equal(
      result.status,
      'stale',
      'opts.convention must reach the legacy staleness seam so phase 03 is compared to 03-VERIFICATION.md',
    );
    assert.equal(result.next_command, '/gsd-execute-phase');
  });
});

// ─── #4142: phase complete must use the convention-aware verdict ───────────
//
// cmdPhaseComplete has an advisory VERIFICATION pre-scan and a separate
// readVerificationStatus completion gate. Exercise the real CLI verdict so a
// cross-phase report cannot satisfy the gate merely by sitting in the bracket
// phase's directory.
describe('#4142: phase complete verdict scopes bracket verification reports', () => {
  const { runGsdTools } = require('./helpers.cjs');

  test('a passed cross-phase stray cannot complete a bracket phase', (t) => {
    const projectDir = createTempGitProject('gsd-4142-phase-complete-');
    t.after(() => cleanup(projectDir));

    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ phase_id_convention: 'bracket' }, null, 2),
    );
    const phaseDirName = 'GSD.02-03-three';
    const phaseDir = path.join(projectDir, '.planning', 'phases', phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    writeVerificationMd(phaseDir, '01-VERIFICATION.md', 'passed');

    const result = runGsdTools(
      ['--json-errors', 'phase', 'complete', phaseDirName],
      projectDir,
    );

    assert.equal(
      result.success,
      false,
      'phase complete must reject another phase\'s passed verification report',
    );
    const errorPayload = JSON.parse(result.error);
    assert.equal(errorPayload.reason, 'phase_verification_incomplete');
  });
});

// ─── #4187 CLI parity: the two query verbs must agree on the same directory ───
//
// The issue's repro shape: run `query verification.resolve-file` and
// `query verification.status` back to back against ONE fixture directory and
// assert they never disagree about whether a report exists (and, when one does,
// about WHICH file is the report — enforced by giving the candidates distinct
// frontmatter statuses and asserting the routed status matches the expected
// winner).
describe('#4187 CLI parity: verification.resolve-file and verification.status agree', () => {
  const { runGsdTools } = require('./helpers.cjs');

  function runBothVerbs(dir) {
    const resolveRes = runGsdTools(['query', 'verification.resolve-file', dir, '--raw'], dir);
    const statusRes = runGsdTools(['query', 'verification.status', dir, '--raw'], dir);
    assert.equal(resolveRes.success, true, `resolve-file failed: ${resolveRes.error}`);
    assert.equal(statusRes.success, true, `status failed: ${statusRes.error}`);
    return { resolvedPath: resolveRes.output.trimEnd(), status: JSON.parse(statusRes.output).status, nextCommand: JSON.parse(statusRes.output).next_command };
  }

  test('bare report: resolve-file finds it and status reads passed (the #4187 repro)', (t) => {
    const dir = mkPhaseDir('cli-bare', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    const { resolvedPath, status, nextCommand } = runBothVerbs(dir);
    assert.equal(resolvedPath, path.join(dir, 'VERIFICATION.md'));
    assert.equal(status, 'passed', 'status must not report missing for a file resolve-file resolves');
    assert.equal(nextCommand, '');
  });

  test('no report: resolve-file is empty and status is missing (agreement in the other direction)', (t) => {
    const dir = mkPhaseDir('cli-none', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    const { resolvedPath, status } = runBothVerbs(dir);
    assert.equal(resolvedPath, '', 'resolve-file must report no file');
    assert.equal(status, 'missing');
  });

  test('bare + canonical dashed: both verbs pick the dashed file', (t) => {
    const dir = mkPhaseDir('cli-both', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'gaps_found');
    writeVerificationMd(dir, '99-VERIFICATION.md', 'passed');
    const { resolvedPath, status } = runBothVerbs(dir);
    assert.equal(resolvedPath, path.join(dir, '99-VERIFICATION.md'));
    assert.equal(status, 'passed', 'status must read the same winner resolve-file picked');
  });

  test('bare + cross-phase stray: both verbs pick the bare file', (t) => {
    const dir = mkPhaseDir('cli-stray', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    writeVerificationMd(dir, '04-VERIFICATION.md', 'gaps_found');
    const { resolvedPath, status } = runBothVerbs(dir);
    assert.equal(resolvedPath, path.join(dir, 'VERIFICATION.md'));
    assert.equal(status, 'passed', 'status must read the same winner resolve-file picked');
  });
});

// ─── #3518: resolveUatFile — phase-pinned, deterministic *-UAT.md pick ───────
//
// Both uat_path projectors in src/init.cts picked the phase's UAT artifact
// with a bare `.find((f) => f.endsWith('-UAT.md') || f === 'UAT.md')` over an
// unsorted readdir listing: no phase-membership check, no ordering. A stray
// cross-phase 04-UAT.md in phase 03's directory could become phase 03's
// uat_path, and WHICH file won was filesystem-dependent (creation order on
// APFS, hash order on ext4/XFS) — two machines on the same commit could emit
// different uat_path values for the same phase (#3518).
//
// resolveUatFile is the UAT counterpart of resolveVerificationFile, sharing
// the identical selection rule via the resolvePhaseArtifactFile core: the
// phase's own <token>-UAT.md always wins; otherwise alphabetically-first
// dashed candidate (deterministic on every filesystem); a bare UAT.md only
// when allowBare is set and no dashed candidate exists at all.
//
// These unit tests are the RELIABLE ANCHORS for the rule (a real phaseToken
// string, no readdir order involved). The end-to-end red/green repro for the
// two init.cts projector call sites lives in tests/init.test.cjs (#3518).
describe('#3518: resolveUatFile — phase-pinned *-UAT.md resolution', () => {

  test('#3518 regression: a stray cross-phase -UAT.md does not outrank this phase\'s own UAT file', () => {
    assert.equal(
      resolveUatFile(
        ['04-UAT.md', '03-UAT.md'],
        { phaseToken: '03' },
      ),
      '03-UAT.md',
      'this phase (token "03") owns 03-UAT.md; the stray 04-UAT.md belongs to a different phase',
    );
  });

  test('order-independence: same candidates reversed → same answer', () => {
    assert.equal(
      resolveUatFile(
        ['03-UAT.md', '04-UAT.md'],
        { phaseToken: '03' },
      ),
      '03-UAT.md',
      'input order must not change which file is selected',
    );
  });

  test('fallback: only a stray cross-phase file present → still returned, never null', () => {
    // Load-bearing: a phase whose only UAT artifact is not its own
    // canonically-named file must keep resolving to SOMETHING, not to null —
    // deterministically (alphabetically-first) rather than by readdir order.
    assert.equal(
      resolveUatFile(['04-UAT.md', '02-UAT.md'], { phaseToken: '03' }),
      '02-UAT.md',
      '"02-UAT.md" sorts before "04-UAT.md" — deterministic even when the phase\'s own file is absent',
    );
  });

  test('fallback determinism: several candidates, no phase token given → alphabetically first', () => {
    assert.equal(resolveUatFile(['02-UAT.md', '01-a-UAT.md']), '01-a-UAT.md');
  });

  test('allowBare defaults to false — a bare-only list returns null without the option', () => {
    assert.equal(resolveUatFile(['UAT.md']), null);
  });

  test('allowBare:true, bare + dashed → the dashed candidate wins', () => {
    assert.equal(
      resolveUatFile(['UAT.md', '03-UAT.md'], { allowBare: true, phaseToken: '03' }),
      '03-UAT.md',
      'a dashed file names its phase and must win over a bare match',
    );
  });

  test('allowBare:true, bare-only candidate → bare file returned', () => {
    assert.equal(resolveUatFile(['UAT.md'], { allowBare: true }), 'UAT.md');
  });

  test('no matches → null', () => {
    assert.equal(resolveUatFile(['03-PLAN.md', '03-SUMMARY.md'], { phaseToken: '03' }), null);
  });
});

// ─── #3518: call-site guard — no hand-rolled *-UAT.md single-pick survives ────
//
// The "Partial Fix Across Call Sites" regression class: a future contributor
// adding a NEW uat_path-style projection (or reverting one of the two fixed
// init.cts sites) would hand-roll `.find((f) => f.endsWith('-UAT.md') ||
// f === 'UAT.md')` again — reintroducing the readdir-order,
// no-phase-check pick #3518 closed. This scans src/ for that literal shape
// and fails on any site outside src/verification.cts, whose
// resolvePhaseArtifactFile core is the single owner of the pattern.
// (src/commands.cts's scaffold WRITER builds `${padded}-UAT.md` directly —
// a canonical-name construction, not a discovery pick — and does not match.)
describe('#3518: call-site guard — every *-UAT.md single-pick routes through resolveUatFile', () => {

  test('no hand-rolled -UAT.md discovery pick exists outside src/verification.cts', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const owner = path.join(srcDir, 'verification.cts');
    // The two shapes the pre-#3518 bug appeared as: an endsWith('-UAT.md')
    // predicate, or a bare `=== 'UAT.md'` equality, anywhere in src/.
    const HAND_ROLLED_RE = /endsWith\(['"`]-UAT\.md['"`]\)|===\s*['"`]UAT\.md['"`]/;
    const offenders = [];
    for (const file of fs.readdirSync(srcDir)) {
      if (!file.endsWith('.cts')) continue;
      const fullPath = path.join(srcDir, file);
      if (fullPath === owner) continue;
      // CRLF-tolerant split (local/no-crlf-fragile-split): Windows
      // git-autocrlf checkouts yield \r\n line endings.
      const lines = fs.readFileSync(fullPath, 'utf-8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (HAND_ROLLED_RE.test(line)) offenders.push(`src/${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'hand-rolled *-UAT.md single-pick(s) — route through resolveUatFile '
        + '(src/verification.cts, issue #3518):\n'
        + offenders.join('\n'),
    );
  });
});

// ─── #3057 B3: findStaleVerificationSummary — indeterminate vs not-stale ─────
//
// The pre-fix catch-all returned `null` on ANY fs / scanPhasePlans / clock
// failure — identical to a completed check that genuinely found nothing
// stale. `opts.fs` had never been exercised by any test. These two tests
// confirm (a) the `opts.fs` injection seam actually works, and (b) the two
// outcomes are now distinguishable via `staleCheckIndeterminate` on the
// `readVerificationStatus` result.

describe('#3057 B3: staleness check — indeterminate is distinguishable from not-stale', () => {
  test('an fs failure inside the staleness check yields staleCheckIndeterminate:true, not a silent "not stale"', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3057-b3-fault-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-stale-check-fault');
    fs.mkdirSync(dir);

    const verificationPath = path.join(dir, '01-VERIFICATION.md');
    const summaryPath = path.join(dir, '01-01-SUMMARY.md');
    writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
    fs.writeFileSync(summaryPath, '# Summary');
    // The summary IS newer — if the check ran to completion it would find
    // 'stale'. The point of this test is that it never gets to find out.
    setMtime(verificationPath, '2026-01-01T00:00:00.000Z');
    setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

    // Confirms opts.fs is actually threaded through: readdirSync/readFileSync
    // delegate to the real fs (so "find the VERIFICATION.md" / "read its
    // frontmatter" upstream of the staleness check still succeed normally),
    // and ONLY statSync is faulted — driving findStaleVerificationSummary's
    // catch branch specifically, via the injected seam, not a global monkeypatch.
    const fsLike = {
      readdirSync: (d) => fs.readdirSync(d),
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      statSync: () => { throw new Error('injected stat failure (#3057 B3)'); },
    };

    const result = readVerificationStatus(dir, {
      fs: fsLike,
      phaseCleanCommitTimesMs: () => new Map(),
    });

    // Pre-existing no-throw fail-open contract is UNCHANGED: routing still
    // proceeds as if nothing were stale (status stays 'passed', not 'stale' —
    // a genuinely-stale summary sits right there and would have tripped the
    // 'stale' route had the check run to completion).
    assert.equal(result.status, 'passed');
    // But the cause is no longer silently identical to a completed "nothing
    // is stale" check — this MUST be flagged as indeterminate.
    assert.strictEqual(result.staleCheckIndeterminate, true);
  });

  test('a completed staleness check that finds nothing stale never reports indeterminate', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3057-b3-ok-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-stale-check-ok');
    fs.mkdirSync(dir);

    const verificationPath = path.join(dir, '01-VERIFICATION.md');
    const summaryPath = path.join(dir, '01-01-SUMMARY.md');
    writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
    fs.writeFileSync(summaryPath, '# Summary');
    // Verification NEWER than the summary → the check runs to completion
    // (no fault injected) and genuinely finds nothing stale.
    setMtime(summaryPath, '2026-01-01T00:00:00.000Z');
    setMtime(verificationPath, '2026-01-01T00:01:00.000Z');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });

    assert.equal(result.status, 'passed');
    assert.strictEqual(
      result.staleCheckIndeterminate,
      undefined,
      'a completed check that found nothing stale must not be flagged indeterminate',
    );
  });
});

// ─── #4155: covered-input fingerprint ─────────────────────────────────────────
//
// A VERIFICATION.md that declares `covered_files` + `covered_digest` in its
// frontmatter is checked by RECOMPUTING that digest over current file content
// — this REPLACES the legacy SUMMARY-mtime check for that report (not merely
// supplements it). A report with no fingerprint metadata keeps the exact
// legacy mtime behavior (already covered above).

describe('#4155: computeCoveredDigest — direct unit coverage', () => {
  test('same covered set, different array order → identical digest (order-independent)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-order-'));
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, 'a.txt'), 'A');
    fs.writeFileSync(path.join(root, 'b.txt'), 'B');

    const d1 = computeCoveredDigest(root, ['a.txt', 'b.txt']);
    const d2 = computeCoveredDigest(root, ['b.txt', 'a.txt']);
    assert.equal(d1, d2);
    // The version prefix is pinned by the #4623 block below; this test is about order-independence.
    assert.match(d1, /^v\d+:sha256:[0-9a-f]{64}$/);
  });

  test('a "./"-prefixed path and its bare equivalent → identical digest (canonicalized, not double-counted)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-dotslash-'));
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, 'impl.txt'), 'content');

    const bare = computeCoveredDigest(root, ['impl.txt']);
    const dotSlash = computeCoveredDigest(root, ['./impl.txt']);
    assert.equal(dotSlash, bare, '"./impl.txt" must canonicalize to the same key as "impl.txt"');

    // Both spellings together must not double-hash the same file into the digest.
    const combined = computeCoveredDigest(root, ['impl.txt', './impl.txt']);
    assert.equal(combined, bare);
  });

  test('an internal ".." segment disguising an escape (not just a leading one) → null (fail closed)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-internal-dotdot-'));
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'a'));
    fs.writeFileSync(path.join(path.dirname(root), 'outside.txt'), 'secret');
    // 'a/../../outside.txt' does not start with '../' as written, but
    // normalizes to '../outside.txt' — an escape a purely-prefix check misses.
    assert.equal(computeCoveredDigest(root, ['a/../../outside.txt']), null);
  });

  test('a covered file whose content changes → digest changes', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-changed-'));
    t.after(() => cleanup(root));
    const target = path.join(root, 'impl.txt');
    fs.writeFileSync(target, 'before');
    const before = computeCoveredDigest(root, ['impl.txt']);
    fs.writeFileSync(target, 'after');
    const after = computeCoveredDigest(root, ['impl.txt']);
    assert.notEqual(before, after);
  });

  test('a covered file that is missing → null (fail closed)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-missing-'));
    t.after(() => cleanup(root));
    assert.equal(computeCoveredDigest(root, ['does-not-exist.txt']), null);
  });

  test('a covered file that is unreadable (directory, not a regular file) → null (fail closed)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-unreadable-'));
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'a-directory'));
    assert.equal(computeCoveredDigest(root, ['a-directory']), null);
  });

  test('a covered path that escapes the project root via ".." → null (fail closed)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-escape-'));
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(path.dirname(root), 'outside.txt'), 'secret');
    assert.equal(computeCoveredDigest(root, ['../outside.txt']), null);
  });

  test('an absolute covered path → null (fail closed)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-absolute-'));
    t.after(() => cleanup(root));
    const absolute = path.join(root, 'impl.txt');
    fs.writeFileSync(absolute, 'x');
    assert.equal(computeCoveredDigest(root, [absolute]), null);
  });

  test('an empty covered-files array → null', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-empty-'));
    t.after(() => cleanup(root));
    assert.equal(computeCoveredDigest(root, []), null);
  });

  test('an in-root symlink whose TARGET escapes the project root → null (fail closed, not the target\'s content)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-symlink-'));
    t.after(() => cleanup(root));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-symlink-outside-'));
    t.after(() => cleanup(outside));
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'not covered by this project');
    const linkPath = path.join(root, 'impl.txt');
    fs.symlinkSync(outsideFile, linkPath);

    assert.equal(computeCoveredDigest(root, ['impl.txt']), null);
  });

});

describe('#4155: readVerificationStatus — fingerprint supersedes legacy mtime staleness', () => {
  test('a covered implementation file OUTSIDE .planning/, read through a .planning/-confined opts.fs (src/planning-inspect.cts\'s exact seam) → status stays passed, not stale', () => {
    // #4155 review finding (blocking): src/planning-inspect.cts:1253 injects
    // containmentEnforcingVerificationFs(paths.planning) — confined to
    // `.planning/` — as `opts.fs`. Before the fix, computeCoveredDigest routed
    // every per-file read through that SAME injected fsImpl, so any covered
    // implementation file (which the issue mandates live under `src/`, outside
    // `.planning/`) made the confinement wrapper throw, which computeCoveredDigest
    // caught and turned into `null`, which readVerificationStatus routed to
    // `stale` — permanently, regardless of whether anything actually changed.
    // This reproduces that exact call shape with a real nested .planning/
    // project (findProjectRoot must resolve past the phase dir to the real
    // root) and a confinement fs scoped ONLY to .planning/, mirroring
    // planning-inspect.cts's containmentEnforcingVerificationFs byte-for-byte.
    const projectDir = createTempGitProject();
    try {
      const planningRoot = path.join(projectDir, '.planning');
      const phaseDir = path.join(planningRoot, 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      const implPath = path.join(projectDir, 'src', 'impl.ts');
      fs.mkdirSync(path.dirname(implPath), { recursive: true });
      fs.writeFileSync(implPath, 'export const x = 1;\n');

      const digest = computeCoveredDigest(projectDir, ['src/impl.ts']);
      fs.writeFileSync(
        path.join(phaseDir, '01-VERIFICATION.md'),
        `---\nstatus: passed\ncovered_files:\n  - src/impl.ts\ncovered_digest: "${digest}"\n---\n`,
      );

      // A naive lexical-prefix check (no realpath resolution) is a stricter
      // stand-in for src/planning-inspect.cts's real containmentEnforcingVerificationFs
      // here: it throws on strictly MORE paths than the real one (it can't
      // tell a legitimate in-root path from a symlink, so it rejects both),
      // which makes this test fail harder, not weaker, if the fix regresses.
      function assertContained(target) {
        if (!path.resolve(target).startsWith(planningRoot + path.sep)) {
          throw new Error(`planning-inspect: path escapes planning root: ${target}`);
        }
      }
      const containmentEnforcingVerificationFs = {
        readdirSync: (dir) => {
          assertContained(dir);
          return fs.readdirSync(dir);
        },
        readFileSync: (filePath, encoding) => {
          assertContained(filePath);
          return fs.readFileSync(filePath, encoding);
        },
        statSync: (filePath) => {
          assertContained(filePath);
          return fs.statSync(filePath);
        },
      };

      const result = readVerificationStatus(phaseDir, {
        fs: containmentEnforcingVerificationFs,
        phaseCleanCommitTimesMs: () => new Map(),
      });
      assert.equal(result.status, 'passed');
    } finally {
      cleanup(projectDir);
    }
  });

  test('unchanged covered inputs → status stays passed even though a SUMMARY is newer (legacy mtime check bypassed)', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-unchanged-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-foo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'implementation content');
    const summaryPath = path.join(dir, '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, '# Summary');
    // The SUMMARY is a covered artifact too — isolates this test to the mtime
    // vs. content-digest distinction, not the #4155 completeness check below.
    const digest = computeCoveredDigest(dir, ['impl.txt', '01-01-SUMMARY.md']);

    fs.writeFileSync(
      path.join(dir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n  - impl.txt\n  - 01-01-SUMMARY.md\ncovered_digest: "${digest}"\n---\n`,
    );
    // SUMMARY newer than VERIFICATION — the LEGACY check would call this
    // stale. The fingerprint check must be the one that actually runs.
    setMtime(path.join(dir, '01-VERIFICATION.md'), '2026-01-01T00:00:00.000Z');
    setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'passed');
  });

  test('a plan or summary added to the phase dir after verification, never declared in covered_files → stale (#4155 completeness check)', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-uncovered-artifact-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-foo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'content');
    const digest = computeCoveredDigest(dir, ['impl.txt']);
    fs.writeFileSync(
      path.join(dir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n  - impl.txt\ncovered_digest: "${digest}"\n---\n`,
    );
    // A SUMMARY appears after verification — never declared, so the recomputed
    // digest over the ORIGINAL covered set still matches. Only the live
    // directory re-scan can catch this.
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '# Summary\n');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'stale');
  });

  test('an unreadable nested plans/ dir fails CLOSED to stale, not open to passed (#4155 review finding: allCurrentArtifactsCovered must branch on scanPhasePlans scope, not a try/catch it never throws into)', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-scan-unreadable-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-foo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'content');
    const digest = computeCoveredDigest(dir, ['impl.txt']);
    fs.writeFileSync(
      path.join(dir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n  - impl.txt\ncovered_digest: "${digest}"\n---\n`,
    );
    const nestedDir = path.join(dir, 'plans');
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(path.join(nestedDir, '01-02-PLAN.md'), '# Nested plan, never declared\n');

    // fs.chmodSync(nestedDir, 0o000) is NOT used: this suite may run as root
    // (CI/Docker), where mode bits are bypassed entirely, making the test
    // pass with zero real coverage. A monkeypatch is CONTRIBUTING.md's
    // documented fault-injection convention for exactly this reason (mirrors
    // tests/broken-windows.test.cjs's writeLedgerAtomic pre-image test). The
    // compiled src/plan-scan.cjs calls `node_fs_1.readdirSync(nestedDir)` — a
    // property read on the SAME node:fs module object `fs` here resolves to
    // (module caching), so patching that property is visible to it.
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = (target, ...rest) => {
      if (path.resolve(target) === path.resolve(nestedDir)) {
        throw Object.assign(new Error('EACCES: permission denied (simulated)'), { code: 'EACCES' });
      }
      return originalReaddirSync(target, ...rest);
    };
    try {
      // Guard: the digest alone must NOT already be stale — isolates this
      // test to the scan-failure branch, not a digest mismatch.
      const unpatchedScan = originalReaddirSync(dir);
      assert.ok(unpatchedScan.includes('plans'), 'guard: nested plans/ dir must exist on disk');

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(
        result.status,
        'stale',
        'an unreadable plans/ dir must fail CLOSED — its invisible contents (an undeclared plan) can never be proven covered',
      );
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
  });

  test('a covered file that changed after verification → status is stale', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-stale-changed-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-foo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'original content');
    const digest = computeCoveredDigest(dir, ['impl.txt']);
    fs.writeFileSync(
      path.join(dir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n  - impl.txt\ncovered_digest: "${digest}"\n---\n`,
    );
    // Evidence drifts after verification — no SUMMARY touched at all, so the
    // legacy mtime check would see nothing stale.
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'drifted content');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'stale');
    assert.equal(result.next_command, '/gsd-execute-phase 01');
  });

  // Ponytail #4155 review finding: "disappeared" and "escapes confinement"
  // integration tests previously here re-proved computeCoveredDigest → null
  // through the identical `recomputed !== coveredDigestVal` stale branch the
  // "changed" test above already wires — the null-producing mechanisms
  // themselves are unit-tested directly in the computeCoveredDigest describe
  // block ("a covered file that is missing", "a covered path that escapes
  // the project root via ..").

  // Ponytail #4155 review finding: these three were near-identical
  // fixture-copies of the same `hasWellFormedFingerprint === false` branch —
  // an incomplete/malformed `covered_files`+`covered_digest` pair fails
  // closed to `stale` rather than silently downgrading to the legacy check.
  for (const [name, frontmatter] of [
    [
      'covered_files present but covered_digest missing (incomplete pair)',
      '---\nstatus: passed\ncovered_files:\n  - impl.txt\n---\n',
    ],
    [
      'covered_digest present but covered_files missing (incomplete pair)',
      '---\nstatus: passed\ncovered_digest: "v1:sha256:deadbeef"\n---\n',
    ],
    [
      'an empty covered_files array with covered_digest present',
      '---\nstatus: passed\ncovered_files: []\ncovered_digest: "v1:sha256:deadbeef"\n---\n',
    ],
  ]) {
    test(`${name} → stale (fail closed, not a silent legacy downgrade)`, (t) => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-malformed-fingerprint-'));
      t.after(() => cleanup(baseDir));
      const dir = path.join(baseDir, '01-foo');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), frontmatter);

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(result.status, 'stale');
    });
  }

  test('a legacy report with no fingerprint metadata still uses the mtime check', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-legacy-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-foo');
    fs.mkdirSync(dir);
    const verificationPath = path.join(dir, '01-VERIFICATION.md');
    const summaryPath = path.join(dir, '01-01-SUMMARY.md');
    writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
    fs.writeFileSync(summaryPath, '# Summary');
    setMtime(verificationPath, '2026-01-01T00:00:00.000Z');
    setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'stale', 'unchanged: legacy mtime staleness must still fire with no covered_digest');
  });
});

describe('#4155: verification.fingerprint CLI', () => {
  const { runGsdTools, createTempGitProject } = require('./helpers.cjs');

  test('emits a covered_digest matching the direct computeCoveredDigest call, sorted covered_files', () => {
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

      const res = runGsdTools(
        [
          'verification',
          'fingerprint',
          phaseDir,
          '.planning/phases/01-example/01-01-SUMMARY.md',
          '.planning/phases/01-example/01-01-PLAN.md',
        ],
        projectDir,
      );
      assert.equal(res.success, true, `expected success, got: ${res.output}${res.error}`);
      const parsed = JSON.parse(res.output);
      assert.deepEqual(parsed.covered_files, [
        '.planning/phases/01-example/01-01-PLAN.md',
        '.planning/phases/01-example/01-01-SUMMARY.md',
      ]);
      const expected = computeCoveredDigest(projectDir, [
        '.planning/phases/01-example/01-01-PLAN.md',
        '.planning/phases/01-example/01-01-SUMMARY.md',
      ]);
      assert.equal(parsed.covered_digest, expected);
    } finally {
      cleanup(projectDir);
    }
  });

  test('a missing covered file fails the whole command (fail closed, no partial fingerprint)', () => {
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });

      const res = runGsdTools(
        ['verification', 'fingerprint', phaseDir, 'does-not-exist.md'],
        projectDir,
      );
      assert.equal(res.success, false);
    } finally {
      cleanup(projectDir);
    }
  });

  test('end-to-end through a real nested .planning/ project: a project-root-relative src/ file is covered, resolved, and hashed correctly', () => {
    // #4155 review finding: unit fixtures elsewhere in this file put phaseDir
    // directly under an ownerless tmpdir, so findProjectRoot(phaseDir) falls
    // back to phaseDir itself and never exercises real multi-level
    // resolution. This test uses a genuine `.planning/phases/NN-x/` tree
    // under a real project root, and covers an implementation file OUTSIDE
    // `.planning/` entirely — the exact shape a live verifier agent produces.
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
      fs.mkdirSync(path.join(projectDir, 'src'));
      fs.writeFileSync(path.join(projectDir, 'src', 'thing.cts'), 'export const x = 1;\n');

      const coveredFiles = [
        '.planning/phases/01-example/01-01-PLAN.md',
        '.planning/phases/01-example/01-01-SUMMARY.md',
        'src/thing.cts',
      ];
      const fpRes = runGsdTools(['verification', 'fingerprint', phaseDir, ...coveredFiles], projectDir);
      assert.equal(fpRes.success, true, `expected success, got: ${fpRes.output}${fpRes.error}`);
      const { covered_files: sortedCovered, covered_digest: digest } = JSON.parse(fpRes.output);

      fs.writeFileSync(
        path.join(phaseDir, '01-VERIFICATION.md'),
        `---\nstatus: passed\ncovered_files:\n${sortedCovered.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${digest}"\n---\n`,
      );

      const passing = readVerificationStatus(phaseDir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(passing.status, 'passed');

      // Now edit the implementation file OUTSIDE .planning/ — must go stale.
      fs.writeFileSync(path.join(projectDir, 'src', 'thing.cts'), 'export const x = 2;\n');
      const afterEdit = readVerificationStatus(phaseDir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(afterEdit.status, 'stale');
    } finally {
      cleanup(projectDir);
    }
  });
});

// ─── #4623: shared planning documents + fingerprint argv ─────────────────────
//
// Two defects, one issue. (1) `computeCoveredDigest` hashed the whole bytes of
// repo-wide planning documents (`.planning/ROADMAP.md`, `REQUIREMENTS.md`, …)
// into a phase's digest, so any phase's ordinary bookkeeping — including the
// closing phase's OWN checkbox flip — read as drift for every phase that had
// declared them. Fingerprint v2 excludes those documents by construction, and
// a stored v1 digest keeps v1 semantics so an upgrade does not stale every
// already-verified phase. (2) `verification.fingerprint` took a raw positional
// slice: every `--files` form failed closed as "a covered file is missing",
// and an omitted phase dir silently hashed the wrong set at exit 0.

const NO_GIT_TIMES = { phaseCleanCommitTimesMs: () => new Map() };

function makePhase4623(projectDir, name) {
  const phaseDir = path.join(projectDir, '.planning', 'phases', name);
  fs.mkdirSync(phaseDir, { recursive: true });
  const num = name.split('-')[0];
  fs.writeFileSync(path.join(phaseDir, `${num}-01-PLAN.md`), `# Plan ${name}\n`);
  fs.writeFileSync(path.join(phaseDir, `${num}-01-SUMMARY.md`), `# Summary ${name}\n`);
  return {
    phaseDir,
    num,
    ownFiles: [
      `.planning/phases/${name}/${num}-01-PLAN.md`,
      `.planning/phases/${name}/${num}-01-SUMMARY.md`,
    ],
  };
}

function writeReport4623(phase, coveredFiles, digest) {
  const sorted = [...new Set(coveredFiles)].sort();
  fs.writeFileSync(
    path.join(phase.phaseDir, `${phase.num}-VERIFICATION.md`),
    `---\nstatus: passed\ncovered_files:\n${sorted.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${digest}"\n---\n`,
  );
}

function writeSharedDocs4623(projectDir, { roadmapDone = false, reqDone = false } = {}) {
  fs.writeFileSync(
    path.join(projectDir, '.planning', 'ROADMAP.md'),
    `# Roadmap\n\n- [${roadmapDone ? 'x' : ' '}] **Phase 1: Alpha**\n- [ ] **Phase 2: Beta**\n`,
  );
  fs.writeFileSync(
    path.join(projectDir, '.planning', 'REQUIREMENTS.md'),
    `# Requirements\n\n- [${reqDone ? 'x' : ' '}] **REQ-01**: The thing works\n\n| REQ-01 | Phase 1 | ${reqDone ? 'Complete' : 'Pending'} |\n`,
  );
}

const SHARED_DOCS_4623 = ['.planning/ROADMAP.md', '.planning/REQUIREMENTS.md'];

describe('#4623: isSharedPlanningDoc — a repo-wide planning document is a DIRECT child of .planning/', () => {
  test('top-level planning documents are shared, whatever their name', () => {
    for (const rel of [
      '.planning/ROADMAP.md',
      '.planning/REQUIREMENTS.md',
      '.planning/STATE.md',
      '.planning/PROJECT.md',
      '.planning/MILESTONES.md',
      '.planning/config.json',
    ]) {
      assert.equal(isSharedPlanningDoc(rel), true, rel);
    }
  });

  test('phase artifacts, nested planning files, implementation files, and a same-named root file are not', () => {
    for (const rel of [
      '.planning/phases/01-example/01-01-PLAN.md',
      '.planning/phases/01-example/01-VERIFICATION.md',
      '.planning/research/notes.md',
      '.planning/milestones/v1.0-ROADMAP.md',
      'src/thing.cts',
      'ROADMAP.md',
      '.planning',
      '.planning/ROADMAP.md/',
      '',
    ]) {
      assert.equal(isSharedPlanningDoc(rel), false, JSON.stringify(rel));
    }
  });

  test('extra planning roots make their direct children shared; sharedPlanningRoots derives them from the phase dir', (t) => {
    const roots = ['.planning', '.planning/workstreams/w'];
    assert.equal(isSharedPlanningDoc('.planning/workstreams/w/ROADMAP.md', roots), true);
    assert.equal(isSharedPlanningDoc('.planning/workstreams/w/phases/01-a/01-01-PLAN.md', roots), false);
    assert.equal(isSharedPlanningDoc('.planning/workstreams/w/ROADMAP.md'), false, 'unknown root without the phase dir');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4623-roots-'));
    t.after(() => cleanup(root));
    assert.deepEqual(sharedPlanningRoots(root), ['.planning']);
    assert.deepEqual(sharedPlanningRoots(root, path.join(root, '.planning', 'phases', '01-a')), ['.planning']);
    assert.deepEqual(sharedPlanningRoots(root, path.join(root, '.planning', 'proj', 'phases', '01-a')), ['.planning', '.planning/proj']);
    assert.deepEqual(sharedPlanningRoots(root, path.join(root, '.planning', 'proj', 'workstreams', 'w', 'phases', '01-a')), ['.planning', '.planning/proj/workstreams/w']);
    // A phase dir outside the project root contributes nothing.
    assert.deepEqual(sharedPlanningRoots(root, path.join(os.tmpdir(), 'elsewhere', 'phases', '01-a')), ['.planning']);
    assert.deepEqual(sharedPlanningRoots(root, root), ['.planning']);
    // Structural: the parent must be `phases/` and the root must sit inside .planning/ — an
    // arbitrary accepted directory must never nominate its grandparent as a planning root.
    assert.deepEqual(sharedPlanningRoots(root, path.join(root, 'src', 'phases', '01-fake')), ['.planning']);
    assert.deepEqual(sharedPlanningRoots(root, path.join(root, '.planning', 'proj', 'notphases', '01-a')), ['.planning']);
    assert.deepEqual(sharedPlanningRoots(root, path.join(root, '.planning', 'phases')), ['.planning']);
    assert.deepEqual(sharedPlanningRoots(root, path.join(root, '.planning')), ['.planning']);
  });
});

describe('#4623: parseFingerprintVersion', () => {
  test('reads the version prefix of a well-formed digest', () => {
    assert.equal(parseFingerprintVersion('v1:sha256:' + 'a'.repeat(64)), 1);
    assert.equal(parseFingerprintVersion('v2:sha256:' + 'a'.repeat(64)), 2);
  });

  test('an unknown, malformed, or absent version → null (fail closed)', () => {
    assert.equal(parseFingerprintVersion('v9:sha256:' + 'a'.repeat(64)), null);
    assert.equal(parseFingerprintVersion('sha256:' + 'a'.repeat(64)), null);
    assert.equal(parseFingerprintVersion('v2:md5:' + 'a'.repeat(32)), null);
    assert.equal(parseFingerprintVersion(''), null);
  });
});

describe('#4623: parseFingerprintFileArgs — every --files form the issue tried, plus the documented bare form', () => {
  test('bare positionals pass through unchanged, commas included (AC4)', () => {
    assert.deepEqual(parseFingerprintFileArgs(['a.rb', 'b.rb']), { files: ['a.rb', 'b.rb'] });
    // Only a --files VALUE is comma-split: the documented form keeps its bytes.
    assert.deepEqual(parseFingerprintFileArgs(['a,b']), { files: ['a,b'] });
    assert.deepEqual(parseFingerprintFileArgs([]), { files: [] });
  });

  test('--files <a> (AC2)', () => {
    assert.deepEqual(parseFingerprintFileArgs(['--files', 'fastlane/Fastfile']), { files: ['fastlane/Fastfile'] });
  });

  test('--files "a,b" and --files=a,b split on commas, trimming and dropping empties (AC3)', () => {
    assert.deepEqual(parseFingerprintFileArgs(['--files', 'a.rb,b.rb']), { files: ['a.rb', 'b.rb'] });
    assert.deepEqual(parseFingerprintFileArgs(['--files', ' a.rb , b.rb ,']), { files: ['a.rb', 'b.rb'] });
    assert.deepEqual(parseFingerprintFileArgs(['--files=a.rb,b.rb']), { files: ['a.rb', 'b.rb'] });
  });

  test('--files a --files b collects every occurrence (AC3)', () => {
    assert.deepEqual(parseFingerprintFileArgs(['--files', 'a.rb', '--files', 'b.rb']), { files: ['a.rb', 'b.rb'] });
  });

  test('forms mix freely, in order', () => {
    assert.deepEqual(parseFingerprintFileArgs(['x', '--files', 'a,b', 'y', '--files=c']), {
      files: ['x', 'a', 'b', 'y', 'c'],
    });
  });

  test('an empty --files value (--files=, --files ",", --files "") is a usage error, never a silent no-op', () => {
    for (const tokens of [['--files='], ['--files', ','], ['--files', ''], ['--files', ' , ']]) {
      const parsed = parseFingerprintFileArgs(tokens);
      assert.ok('error' in parsed, JSON.stringify(tokens));
      assert.match(parsed.error, /--files requires at least one path/);
    }
  });

  test('--files with no value, or followed by another flag, is a usage error', () => {
    for (const tokens of [['--files'], ['a', '--files'], ['--files', '--files', 'a']]) {
      const parsed = parseFingerprintFileArgs(tokens);
      assert.ok('error' in parsed, JSON.stringify(tokens));
      assert.match(parsed.error, /--files requires a value/);
    }
  });

  test('any other --flag is an explicit usage error naming the flag, never a covered path', () => {
    const parsed = parseFingerprintFileArgs(['a.rb', '--file', 'b.rb']);
    assert.ok('error' in parsed);
    assert.match(parsed.error, /unknown flag --file\b/);
    assert.doesNotMatch(parsed.error, /missing, unreadable/);
  });
});

describe('#4623: computeCoveredDigest v2 — shared planning documents do not enter the digest', () => {
  test('defaults to v3 and names the version in the digest', (t) => {
    // #5095: the default fingerprint version bumped v2 -> v3 (ADR-5057 Phase 2).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4623-version-'));
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, 'impl.txt'), 'x');
    assert.match(computeCoveredDigest(root, ['impl.txt']), /^v3:sha256:[0-9a-f]{64}$/);
    assert.match(computeCoveredDigest(root, ['impl.txt'], 1), /^v1:sha256:[0-9a-f]{64}$/);
    assert.notEqual(computeCoveredDigest(root, ['impl.txt']), computeCoveredDigest(root, ['impl.txt'], 1));
  });

  test('an unknown version → null (fail closed, never a digest under guessed semantics)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4623-unknown-version-'));
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, 'impl.txt'), 'x');
    assert.equal(computeCoveredDigest(root, ['impl.txt'], 9), null);
    assert.equal(computeCoveredDigest(root, ['impl.txt'], 0), null);
  });

  test('a byte change to .planning/ROADMAP.md or REQUIREMENTS.md leaves the v2 digest unchanged; a phase artifact or implementation change still moves it', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4623-shared-'));
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'));
    writeSharedDocs4623(root);
    fs.writeFileSync(path.join(root, '.planning', 'phases', '01-a', '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(root, 'src', 'thing.cts'), 'export const x = 1;\n');
    const covered = [...SHARED_DOCS_4623, '.planning/phases/01-a/01-01-PLAN.md', 'src/thing.cts'];

    const before = computeCoveredDigest(root, covered);
    writeSharedDocs4623(root, { roadmapDone: true, reqDone: true });
    assert.equal(computeCoveredDigest(root, covered), before, 'shared-doc bookkeeping must not move a v2 digest');

    fs.writeFileSync(path.join(root, '.planning', 'phases', '01-a', '01-01-PLAN.md'), '# Plan (edited)\n');
    const afterPlan = computeCoveredDigest(root, covered);
    assert.notEqual(afterPlan, before, 'a phase artifact change must still move it');

    fs.writeFileSync(path.join(root, 'src', 'thing.cts'), 'export const x = 2;\n');
    assert.notEqual(computeCoveredDigest(root, covered), afterPlan, 'an implementation change must still move it');
  });

  test('a nested planning file (.planning/research/…) is NOT shared and still moves the digest', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4623-nested-'));
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, '.planning', 'research'), { recursive: true });
    const note = path.join(root, '.planning', 'research', 'notes.md');
    fs.writeFileSync(note, 'v1');
    const before = computeCoveredDigest(root, ['.planning/research/notes.md']);
    fs.writeFileSync(note, 'v2');
    assert.notEqual(computeCoveredDigest(root, ['.planning/research/notes.md']), before);
  });

  test('a declared shared document is validated like any other path — present: inert; missing, a directory, or an escaping symlink: null (fail closed, as v1)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4623-shared-validated-'));
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(path.join(root, 'impl.txt'), 'x');
    const withoutDecl = computeCoveredDigest(root, ['impl.txt']);
    // Missing → null, exactly as v1.
    assert.equal(computeCoveredDigest(root, ['impl.txt', '.planning/ROADMAP.md']), null);
    fs.writeFileSync(path.join(root, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    // Present → contributes nothing: same digest as if undeclared.
    assert.equal(computeCoveredDigest(root, ['impl.txt', '.planning/ROADMAP.md']), withoutDecl);
    // A directory directly under the root is not a document → null, as v1.
    assert.equal(computeCoveredDigest(root, ['impl.txt', '.planning/phases']), null);
    // An in-root symlink whose target escapes → null, as v1 (nothing is read either way,
    // but the declaration is still an escape and still invalidates the set).
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4623-shared-outside-'));
    t.after(() => cleanup(outside));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not this project');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, '.planning', 'ESCAPE.md'));
    assert.equal(computeCoveredDigest(root, ['impl.txt', '.planning/ESCAPE.md']), null);
  });

  test('a declaration made only of shared planning documents hashes nothing → null (fail closed, like an empty one)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4623-all-shared-'));
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, '.planning'));
    writeSharedDocs4623(root);
    assert.equal(computeCoveredDigest(root, SHARED_DOCS_4623), null);
    // v1 still hashes them.
    assert.match(computeCoveredDigest(root, SHARED_DOCS_4623, 1), /^v1:/);
  });

  test('the phase\'s own planning root is shared too: a workstream-scoped ROADMAP.md is inert, a research note beside it is not', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4623-workstream-'));
    t.after(() => cleanup(root));
    const wsRoot = path.join(root, '.planning', 'workstreams', 'payments');
    const phaseDir = path.join(wsRoot, 'phases', '01-a');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.planning', 'research'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'ROADMAP.md'), '- [ ] Phase 1\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(root, '.planning', 'research', 'notes.md'), 'v1');
    const covered = [
      '.planning/workstreams/payments/ROADMAP.md',
      '.planning/workstreams/payments/phases/01-a/01-01-PLAN.md',
      '.planning/research/notes.md',
    ];
    assert.deepEqual(sharedPlanningRoots(root, phaseDir), ['.planning', '.planning/workstreams/payments']);
    const before = computeCoveredDigest(root, covered, 2, { phaseDir });
    fs.writeFileSync(path.join(wsRoot, 'ROADMAP.md'), '- [x] Phase 1\n');
    assert.equal(computeCoveredDigest(root, covered, 2, { phaseDir }), before, 'the workstream roadmap is this phase\'s shared doc');
    // Without the phase dir the same path is NOT recognised (lexically it could be .planning/<project>/…).
    assert.notEqual(computeCoveredDigest(root, covered, 2), before);
    fs.writeFileSync(path.join(root, '.planning', 'research', 'notes.md'), 'v2');
    assert.notEqual(computeCoveredDigest(root, covered, 2, { phaseDir }), before, 'a nested research note is evidence');
  });

  test('a shared-looking path that escapes the root still fails the whole set', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4623-escape-'));
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, 'impl.txt'), 'x');
    assert.equal(computeCoveredDigest(root, ['impl.txt', '../.planning/ROADMAP.md']), null);
  });

  test('v1 semantics are preserved on request: a shared-doc change still moves a v1 digest', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4623-v1-'));
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, '.planning'));
    fs.writeFileSync(path.join(root, 'impl.txt'), 'x');
    writeSharedDocs4623(root);
    const before = computeCoveredDigest(root, ['impl.txt', ...SHARED_DOCS_4623], 1);
    writeSharedDocs4623(root, { roadmapDone: true });
    assert.notEqual(computeCoveredDigest(root, ['impl.txt', ...SHARED_DOCS_4623], 1), before);
  });
});

describe('#4623: readVerificationStatus — shared planning documents no longer stale a phase', () => {
  const { runGsdTools } = require('./helpers.cjs');

  function fingerprintViaCli(projectDir, phase, coveredFiles) {
    const res = runGsdTools(['verification', 'fingerprint', phase.phaseDir, ...coveredFiles], projectDir);
    assert.equal(res.success, true, `expected success, got: ${res.output}${res.error}`);
    return JSON.parse(res.output).covered_digest;
  }

  test('AC1 cross-phase: completing phase A (roadmap + requirement bookkeeping) leaves phase B passed; B\'s own artifact change still stales B alone', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    writeSharedDocs4623(projectDir);
    const a = makePhase4623(projectDir, '01-alpha');
    const b = makePhase4623(projectDir, '02-beta');
    const aCovered = [...a.ownFiles, ...SHARED_DOCS_4623];
    const bCovered = [...b.ownFiles, ...SHARED_DOCS_4623];
    writeReport4623(a, aCovered, fingerprintViaCli(projectDir, a, aCovered));
    writeReport4623(b, bCovered, fingerprintViaCli(projectDir, b, bCovered));
    assert.equal(readVerificationStatus(a.phaseDir, NO_GIT_TIMES).status, 'passed');
    assert.equal(readVerificationStatus(b.phaseDir, NO_GIT_TIMES).status, 'passed');

    // Phase A closes: its roadmap checkbox and its requirement flip.
    writeSharedDocs4623(projectDir, { roadmapDone: true, reqDone: true });
    assert.equal(readVerificationStatus(a.phaseDir, NO_GIT_TIMES).status, 'passed', 'the closing phase itself');
    assert.equal(readVerificationStatus(b.phaseDir, NO_GIT_TIMES).status, 'passed', 'the untouched sibling phase');
    assert.equal(isPhaseComplete(b.phaseDir).value.complete, true);

    // Real drift in B is still caught, and only in B.
    fs.appendFileSync(path.join(b.phaseDir, '02-01-PLAN.md'), '\nchanged\n');
    assert.equal(readVerificationStatus(b.phaseDir, NO_GIT_TIMES).status, 'stale');
    assert.equal(readVerificationStatus(a.phaseDir, NO_GIT_TIMES).status, 'passed');
  });

  test('same-phase: the phase\'s own `requirements mark-complete` and `phase.complete` writes do not stale it', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    writeSharedDocs4623(projectDir);
    const a = makePhase4623(projectDir, '01-alpha');
    const covered = [...a.ownFiles, ...SHARED_DOCS_4623];
    writeReport4623(a, covered, fingerprintViaCli(projectDir, a, covered));
    assert.equal(readVerificationStatus(a.phaseDir, NO_GIT_TIMES).status, 'passed');

    // requirements mark-complete: checkbox + traceability cell.
    writeSharedDocs4623(projectDir, { reqDone: true });
    assert.equal(readVerificationStatus(a.phaseDir, NO_GIT_TIMES).status, 'passed');
    // phase.complete: the phase's own roadmap status cell.
    writeSharedDocs4623(projectDir, { reqDone: true, roadmapDone: true });
    assert.equal(readVerificationStatus(a.phaseDir, NO_GIT_TIMES).status, 'passed');
  });

  test('a legacy v1 report keeps v1 semantics: passed while untouched, stale on a shared-doc edit, and the CLI re-fingerprint is the remedy', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    writeSharedDocs4623(projectDir);
    const a = makePhase4623(projectDir, '01-alpha');
    const covered = [...a.ownFiles, ...SHARED_DOCS_4623];
    const v1 = computeCoveredDigest(projectDir, covered, 1);
    writeReport4623(a, covered, v1);
    // The upgrade alone must not stale an intact v1 report.
    assert.equal(readVerificationStatus(a.phaseDir, NO_GIT_TIMES).status, 'passed');

    writeSharedDocs4623(projectDir, { roadmapDone: true });
    assert.equal(readVerificationStatus(a.phaseDir, NO_GIT_TIMES).status, 'stale', 'v1 hashed the shared docs; honour that');

    // The documented remedy: recompute through the CLI, paste the result.
    // #5095: the CLI's default fingerprint version bumped v2 -> v3.
    const v3 = fingerprintViaCli(projectDir, a, covered);
    assert.match(v3, /^v3:/);
    writeReport4623(a, covered, v3);
    assert.equal(readVerificationStatus(a.phaseDir, NO_GIT_TIMES).status, 'passed');
    writeSharedDocs4623(projectDir, { roadmapDone: true, reqDone: true });
    assert.equal(readVerificationStatus(a.phaseDir, NO_GIT_TIMES).status, 'passed', 'and it lasts');
  });

  test('workstream scope through the READ path: the workstream\'s own ROADMAP.md flip leaves its phase passed; its PLAN edit stales it', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const wsRoot = path.join(projectDir, '.planning', 'workstreams', 'payments');
    const phaseDir = path.join(wsRoot, 'phases', '01-alpha');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'ROADMAP.md'), '- [ ] **Phase 1: Alpha**\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    const phase = { phaseDir, num: '01' };
    const covered = [
      '.planning/workstreams/payments/ROADMAP.md',
      '.planning/workstreams/payments/phases/01-alpha/01-01-PLAN.md',
      '.planning/workstreams/payments/phases/01-alpha/01-01-SUMMARY.md',
    ];
    writeReport4623(phase, covered, fingerprintViaCli(projectDir, phase, covered));
    assert.equal(readVerificationStatus(phaseDir, NO_GIT_TIMES).status, 'passed');
    fs.writeFileSync(path.join(wsRoot, 'ROADMAP.md'), '- [x] **Phase 1: Alpha**\n');
    assert.equal(readVerificationStatus(phaseDir, NO_GIT_TIMES).status, 'passed', 'workstream roadmap bookkeeping');
    fs.appendFileSync(path.join(phaseDir, '01-01-PLAN.md'), 'changed\n');
    assert.equal(readVerificationStatus(phaseDir, NO_GIT_TIMES).status, 'stale');
  });

  test('a phase directory that is not <planning-root>/phases/<phase> nominates no extra root: implementation evidence beside it stays hashed', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const fakePhase = path.join(projectDir, 'src', 'phases', '01-fake');
    fs.mkdirSync(fakePhase, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'evidence.cts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(fakePhase, '01-01-PLAN.md'), '# Plan\n');
    const covered = ['src/evidence.cts', 'src/phases/01-fake/01-01-PLAN.md'];
    const digest = computeCoveredDigest(projectDir, covered, 2, { phaseDir: fakePhase });
    fs.writeFileSync(
      path.join(fakePhase, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n${covered.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${digest}"\n---\n`,
    );
    assert.equal(readVerificationStatus(fakePhase, NO_GIT_TIMES).status, 'passed');
    fs.writeFileSync(path.join(projectDir, 'src', 'evidence.cts'), 'export const x = 2;\n');
    assert.equal(readVerificationStatus(fakePhase, NO_GIT_TIMES).status, 'stale', 'src/ must never be treated as a planning root');
  });

  test('a digest under an unknown fingerprint version is stale (fail closed)', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const a = makePhase4623(projectDir, '01-alpha');
    writeReport4623(a, a.ownFiles, 'v9:sha256:' + 'a'.repeat(64));
    assert.equal(readVerificationStatus(a.phaseDir, NO_GIT_TIMES).status, 'stale');
  });
});

describe('#4623: verification.fingerprint CLI — --files forms and the phase-dir guard', () => {
  const { runGsdTools } = require('./helpers.cjs');

  function setup() {
    const projectDir = createTempGitProject();
    const a = makePhase4623(projectDir, '01-alpha');
    fs.mkdirSync(path.join(projectDir, 'fastlane'));
    fs.writeFileSync(path.join(projectDir, 'fastlane', 'Fastfile'), 'lane :x do end\n');
    fs.writeFileSync(path.join(projectDir, 'a.rb'), 'a\n');
    fs.writeFileSync(path.join(projectDir, 'b.rb'), 'b\n');
    return { projectDir, a };
  }

  function run(projectDir, phaseDir, ...tokens) {
    return runGsdTools(['verification', 'fingerprint', phaseDir, ...tokens], projectDir);
  }

  function expectJson(res) {
    assert.equal(res.success, true, `expected success, got: ${res.output}${res.error}`);
    return JSON.parse(res.output);
  }

  test('AC2: --files a produces the same covered_files/covered_digest as the bare positional form', (t) => {
    const { projectDir, a } = setup();
    t.after(() => cleanup(projectDir));
    const positional = expectJson(run(projectDir, a.phaseDir, 'fastlane/Fastfile'));
    const flagged = expectJson(run(projectDir, a.phaseDir, '--files', 'fastlane/Fastfile'));
    assert.deepEqual(flagged, positional);
    // #5095: under v3 (ADR-5057 Phase 2 R1) covered_files is the declared set
    // UNIONED with the phase's own PLAN/SUMMARY artifacts, not the declared
    // list alone — the pin here is that both invocation forms agree.
    assert.deepEqual(positional.covered_files, [...a.ownFiles, 'fastlane/Fastfile'].sort());
  });

  test('AC3: --files "a,b" and --files a --files b both resolve to covered_files [a, b], canonicalized like the bare form (AC4)', (t) => {
    const { projectDir, a } = setup();
    t.after(() => cleanup(projectDir));
    const positional = expectJson(run(projectDir, a.phaseDir, 'b.rb', 'a.rb'));
    // #5095: covered_files is the declared set unioned with the phase's own
    // PLAN/SUMMARY artifacts under v3 (ADR-5057 Phase 2 R1) — the pin is that
    // every equivalent invocation form produces the identical, canonical set.
    assert.deepEqual(positional.covered_files, [...a.ownFiles, 'a.rb', 'b.rb'].sort());
    assert.deepEqual(expectJson(run(projectDir, a.phaseDir, '--files', 'a.rb,b.rb')), positional);
    assert.deepEqual(expectJson(run(projectDir, a.phaseDir, '--files', 'a.rb', '--files', 'b.rb')), positional);
    assert.deepEqual(expectJson(run(projectDir, a.phaseDir, '--files=b.rb,a.rb')), positional);
    assert.deepEqual(expectJson(run(projectDir, a.phaseDir, 'a.rb', '--files', 'b.rb')), positional);
    // #5095: the digest must cover the SAME unioned set the CLI reports, not
    // the declared list alone — pass phaseDir so the direct call matches.
    assert.equal(
      positional.covered_digest,
      computeCoveredDigest(projectDir, ['a.rb', 'b.rb'], undefined, { phaseDir: a.phaseDir }),
    );
  });

  test('--raw with --files prints just the digest', (t) => {
    const { projectDir, a } = setup();
    t.after(() => cleanup(projectDir));
    // #5095: --raw must print exactly the `covered_digest` the SAME command
    // would emit as JSON (which, under v3, is the declared+artifact union) —
    // not a digest recomputed over the declared list alone.
    const json = expectJson(run(projectDir, a.phaseDir, '--files', 'a.rb,b.rb'));
    const res = run(projectDir, a.phaseDir, '--files', 'a.rb,b.rb', '--raw');
    assert.equal(res.success, true, `expected success, got: ${res.output}${res.error}`);
    assert.equal(res.output.trim(), json.covered_digest);
  });

  test('AC5: a phase directory with zero covered files still fails closed with the existing error', (t) => {
    const { projectDir, a } = setup();
    t.after(() => cleanup(projectDir));
    const res = run(projectDir, a.phaseDir);
    assert.equal(res.success, false);
    assert.match(`${res.output}${res.error}`, /at least one covered file required/);
  });

  test('an unrecognized flag is a usage error naming the flag — not "a covered file is missing"', (t) => {
    const { projectDir, a } = setup();
    t.after(() => cleanup(projectDir));
    const res = run(projectDir, a.phaseDir, '--file', 'a.rb');
    assert.equal(res.success, false);
    assert.match(`${res.output}${res.error}`, /unknown flag --file\b/);
    assert.doesNotMatch(`${res.output}${res.error}`, /missing, unreadable/);
  });

  test('an omitted phase dir (first argument is a covered file) is an error, not a plausible digest over the wrong set at exit 0', (t) => {
    const { projectDir } = setup();
    t.after(() => cleanup(projectDir));
    const res = runGsdTools(['verification', 'fingerprint', 'a.rb', 'b.rb', '--raw'], projectDir);
    assert.equal(res.success, false);
    assert.match(`${res.output}${res.error}`, /phase directory not found/);
    assert.doesNotMatch(res.output, /^v\d+:sha256:/);
  });

  // #5095 (R5): a phase WITH plans has its own artifacts unioned in by the
  // emitter, so an all-shared DECLARED set is no longer empty evidence — it
  // succeeds, hashing the phase's own plan/summary. The named all-shared
  // error is reachable only when the phase has no plans/summaries at all
  // (see the following test).
  test('R5: an all-shared declared set on a phase WITH plans succeeds — the emitter unions in the phase artifacts', (t) => {
    const { projectDir, a } = setup();
    t.after(() => cleanup(projectDir));
    writeSharedDocs4623(projectDir);
    const res = run(projectDir, a.phaseDir, '--files', SHARED_DOCS_4623.join(','));
    assert.equal(res.success, true, `expected success: ${res.output}${res.error}`);
    const parsed = JSON.parse(res.output);
    for (const own of a.ownFiles) {
      assert.ok(parsed.covered_files.includes(own), `expected ${own} in ${JSON.stringify(parsed.covered_files)}`);
    }
  });

  test('a declaration made only of shared planning documents, on a phase with NO plans, is a named error, not "file missing"', (t) => {
    const { projectDir } = setup();
    t.after(() => cleanup(projectDir));
    writeSharedDocs4623(projectDir);
    const emptyPhaseDir = path.join(projectDir, '.planning', 'phases', '02-empty');
    fs.mkdirSync(emptyPhaseDir, { recursive: true });
    const res = run(projectDir, emptyPhaseDir, '--files', SHARED_DOCS_4623.join(','));
    assert.equal(res.success, false);
    assert.match(`${res.output}${res.error}`, /every covered file is a repo-wide planning document/);
    assert.doesNotMatch(`${res.output}${res.error}`, /missing, unreadable/);
  });

  test('an all-shared declaration with a missing or directory member is a bad path first (generic error), not the named all-shared error', (t) => {
    const { projectDir, a } = setup();
    t.after(() => cleanup(projectDir));
    writeSharedDocs4623(projectDir);
    const res = run(projectDir, a.phaseDir, '.planning/ROADMAP.md', '.planning/MISSING.md');
    assert.equal(res.success, false);
    assert.match(`${res.output}${res.error}`, /missing, unreadable/);
    assert.doesNotMatch(`${res.output}${res.error}`, /every covered file is a repo-wide planning document/);
    const dir = run(projectDir, a.phaseDir, '.planning/ROADMAP.md', '.planning/phases');
    assert.equal(dir.success, false);
    assert.match(`${dir.output}${dir.error}`, /missing, unreadable/);
  });

  test('a declared shared document stays listed in covered_files, and the emitted v3 digest survives its rewrite', (t) => {
    // #5095: default fingerprint version bumped v2 -> v3; `covered` here
    // already equals the phase's own artifact set (a.ownFiles), so the v3
    // union contributes nothing new and the digest is byte-identical to a
    // direct computeCoveredDigest call over the same declared list.
    const { projectDir, a } = setup();
    t.after(() => cleanup(projectDir));
    writeSharedDocs4623(projectDir);
    const covered = [...a.ownFiles, ...SHARED_DOCS_4623];
    const first = expectJson(run(projectDir, a.phaseDir, '--files', covered.join(',')));
    assert.deepEqual(first.covered_files, [...covered].sort());
    assert.match(first.covered_digest, /^v3:/);
    assert.equal(first.covered_digest, computeCoveredDigest(projectDir, covered));

    writeSharedDocs4623(projectDir, { roadmapDone: true, reqDone: true });
    const second = expectJson(run(projectDir, a.phaseDir, ...covered));
    assert.equal(second.covered_digest, first.covered_digest);
  });
});

// ─── #2617: next_command runtime projection ──────────────────────────────────
//
// Regression tests for #2617 — verification-status `next_command` bypassed the
// runtime command-surface projection.
//
// `src/verification.cts` stored and synthesized hard-coded `/gsd:…` strings with
// no runtime context, and `phase complete` relayed that raw field straight into
// its verification-blocked error. On a Codex project the suggested next step was
// `/gsd:execute-phase`, which Codex does not install — the surface there is
// `$gsd-execute-phase`. The colon form is doubly wrong: `runtime-slash.cts`
// documents that "the colon form is never emitted", so every runtime was getting
// a deprecated shape. (The 11 `/gsd-…` assertions above were `/gsd:…` before this
// fix — they are the failing-first record.)
//
// The fix keeps ONE routing seam and makes its emitted command runtime-aware:
// the table stores bare command names and every return path projects through
// `formatGsdSlash`, with callers passing `resolveRuntime(cwd)`.
//
// Coverage is the matrix the issue asked for — missing, unknown, gaps_found and
// stale, against Codex (`$gsd-…`) and a slash-hyphen runtime (`/gsd-…`) — plus
// the `phase complete` error path, not merely the router's return object.

/** Codex installs `$gsd-<cmd>`; every other shipped runtime installs `/gsd-<cmd>`. */
const RUNTIMES = [
  { id: 'codex', prefix: '$gsd-' },
  { id: 'cursor', prefix: '/gsd-' },
];

// NOTE: deliberately NOT file-scope beforeEach/afterEach. node:test applies
// module-scope hooks to EVERY test in the file, so hooks added here for the
// #2617 suites would also wrap the ~40 pre-existing tests above — making this
// block a single point of failure for suites it has nothing to do with. Each
// test allocates and releases its own phase dir instead.
let projBaseDir;
let projPhaseDir;

/**
 * Install the #2617 temp-phase-dir lifecycle INSIDE the calling describe.
 * node:test scopes hooks to their enclosing describe, so this keeps them off the
 * ~40 pre-existing tests in this file.
 */
function useProjectionPhaseDir() {
  beforeEach(() => {
    projBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2617-'));
    projPhaseDir = path.join(projBaseDir, '01-example');
    fs.mkdirSync(projPhaseDir, { recursive: true });
  });
  afterEach(() => cleanup(projBaseDir));
}

const verificationPath = () => path.join(projPhaseDir, '01-VERIFICATION.md');

function writeStatus(status) {
  fs.writeFileSync(verificationPath(), `---\nstatus: ${status}\n---\n\n# Verification\n`);
}

function removeVerification() {
  try { fs.unlinkSync(verificationPath()); } catch { /* already absent */ }
}

/** Make the verification file older than a summary → the stale branch. */
function makeStale() {
  const summaryPath = path.join(projPhaseDir, '01-01-SUMMARY.md');
  fs.writeFileSync(summaryPath, '# Summary\n');
  fs.utimesSync(verificationPath(), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  fs.utimesSync(summaryPath, new Date('2026-01-01T00:01:00Z'), new Date('2026-01-01T00:01:00Z'));
}

// git times unavailable → mtime-fallback path (#2348). Injected so the staleness
// clock stays hermetic regardless of the tmpdir's repo state.
const NO_GIT = { phaseCleanCommitTimesMs: () => new Map() };

function read(runtime, extra = {}) {
  return readVerificationStatus(projPhaseDir, { runtime, ...extra });
}

for (const { id, prefix } of RUNTIMES) {
  describe(`#2617: next_command uses the ${id} command surface`, () => {
    useProjectionPhaseDir();

    test('missing verification', () => {
      removeVerification();
      assert.equal(read(id).next_command, `${prefix}execute-phase 01`);
    });

    test('unparseable/absent frontmatter status is also "missing"', () => {
      fs.writeFileSync(verificationPath(), '# Verification\n\nNo frontmatter here.\n');
      assert.equal(read(id).next_command, `${prefix}execute-phase 01`);
    });

    test('an out-of-set status value is a hard error, not a routed command (#5118, was unknown)', () => {
      writeStatus('not-a-real-status');
      assert.throws(() => read(id), (err) => Boolean(err) && err.code === 'ERR_VERIFICATION_STATUS_OUT_OF_SET');
    });

    test('gaps_found carries the phase number and --gaps flag through the projection', () => {
      writeStatus('gaps_found');
      const result = read(id);
      assert.equal(result.status, 'gaps_found');
      assert.equal(result.next_command, `${prefix}plan-phase 01 --gaps`);
    });

    test('stale carries the phase number through the projection', () => {
      writeStatus('passed');
      makeStale();
      const result = read(id, NO_GIT);
      assert.equal(result.status, 'stale');
      assert.equal(result.next_command, `${prefix}execute-phase 01`);
    });

    test('passed has no next step and stays empty, not a bare prefix', () => {
      // Boundary: projecting an empty command must not emit `$gsd-` / `/gsd-`.
      writeStatus('passed');
      assert.equal(read(id).next_command, '',
        'passed has no next command and must project to the empty string');
    });

    test('human_needed names the verify-work command its next_action describes', () => {
      // #2617 unification: the table used to return '' here while init.cts's
      // parallel projector returned `verify-work <N>` for the same state — the
      // two surfaces disagreed on whether a next command existed at all.
      writeStatus('human_needed');
      assert.equal(read(id).next_command, `${prefix}verify-work 01`);
    });
  });
}

describe('#2617: no verification output suggests the deprecated colon form', () => {
  useProjectionPhaseDir();

  test('across every state and runtime, and for the default runtime', () => {
    const runtimeIds = [...RUNTIMES.map((r) => r.id), undefined];
    let checked = 0;

    for (const runtime of runtimeIds) {
      const opts = runtime === undefined ? { ...NO_GIT } : { runtime, ...NO_GIT };

      removeVerification();
      const cases = [readVerificationStatus(projPhaseDir, opts)];

      // #5118: an out-of-set status now throws (covered above), so it has no
      // next_command to inspect here.
      for (const status of ['gaps_found', 'passed', 'human_needed']) {
        writeStatus(status);
        cases.push(readVerificationStatus(projPhaseDir, opts));
      }
      writeStatus('passed');
      makeStale();
      cases.push(readVerificationStatus(projPhaseDir, opts));

      for (const result of cases) {
        assert.ok(
          !result.next_command.includes('/gsd:'),
          `deprecated colon form leaked for runtime=${String(runtime)}: ${result.next_command}`,
        );
        checked++;
      }
    }

    // Non-vacuity: 3 runtimes x 5 states.
    assert.equal(checked, 15, 'expected every runtime x state combination to be checked');
  });

  test('the default runtime yields the canonical hyphen form, not the colon form', () => {
    removeVerification();
    // No `runtime` option at all — the pre-fix default emitted `/gsd:execute-phase`.
    assert.equal(readVerificationStatus(projPhaseDir).next_command, '/gsd-execute-phase 01');
  });
});

describe('#2617: the phase-complete error path projects too', () => {
  // The issue is explicit that fixing only the router is insufficient: the
  // user-visible surface is `phase complete`, which relays next_command into its
  // blocked-completion error. Driven through the real CLI so the assertion is on
  // what a user actually sees.
  const { runGsdTools, createTempGitProject } = require('./helpers.cjs');

  for (const { id, prefix } of RUNTIMES) {
    test(`phase complete on ${id} suggests ${prefix}execute-phase`, () => {
      const projectDir = createTempGitProject();
      try {
        fs.writeFileSync(
          path.join(projectDir, '.planning', 'config.json'),
          JSON.stringify({ runtime: id }, null, 2),
        );
        const phase = path.join(projectDir, '.planning', 'phases', '01-example');
        fs.mkdirSync(phase, { recursive: true });
        // No *-VERIFICATION.md → the completion gate blocks with reason "missing".

        const res = runGsdTools(['phase', 'complete', '01'], projectDir);
        // The blocked-completion message goes to stderr, which runGsdTools
        // surfaces as `error` (NOT `stderr`) on a clean non-zero exit. Reading
        // the wrong field yields '' and makes every assertion below vacuous.
        const text = `${res.output || ''}${res.error || ''}`;

        assert.equal(res.success, false, 'completion must be blocked with no verification report');
        assert.match(
          text,
          /verification is incomplete/i,
          `expected the blocked-completion error, got: ${text}`,
        );
        // Unconditional — a conditional check here passes when the command is
        // absent entirely, which is exactly how this path stayed untested.
        assert.ok(
          text.includes(`${prefix}execute-phase`),
          `phase complete must suggest ${prefix}execute-phase on ${id}, got: ${text}`,
        );
        assert.ok(
          !text.includes('/gsd:'),
          `phase complete must not surface the deprecated colon form: ${text}`,
        );
      } finally {
        cleanup(projectDir);
      }
    });

    test(`phase complete on ${id} projects the gaps_found command too`, () => {
      // Finding from review: the live-CLI check previously exercised only the
      // `missing` state, so a regression in any other routed branch would show
      // up in the router's return object but not in what a user actually reads.
      const projectDir = createTempGitProject();
      try {
        fs.writeFileSync(
          path.join(projectDir, '.planning', 'config.json'),
          JSON.stringify({ runtime: id }, null, 2),
        );
        const phase = path.join(projectDir, '.planning', 'phases', '01-example');
        fs.mkdirSync(phase, { recursive: true });
        fs.writeFileSync(
          path.join(phase, '01-VERIFICATION.md'),
          '---\nstatus: gaps_found\n---\n\n# Verification\n',
        );

        const res = runGsdTools(['phase', 'complete', '01'], projectDir);
        const text = `${res.output || ''}${res.error || ''}`;

        assert.equal(res.success, false, 'gaps_found must block completion');
        assert.ok(
          text.includes(`${prefix}plan-phase 01 --gaps`),
          `phase complete must suggest ${prefix}plan-phase 01 --gaps on ${id}, got: ${text}`,
        );
        assert.ok(!text.includes('/gsd:'), `deprecated colon form leaked: ${text}`);
      } finally {
        cleanup(projectDir);
      }
    });
  }
});

// ─── #2868: stranded-phase detection via `verification status` ────────────────
//
// execute-phase's `discover_and_group_plans` step resumes at the phase gates
// when every plan is summarized but no *-VERIFICATION.md exists yet. That
// resume decision is driven by `gsd_run query verification status <phaseDir>
// --pick status` reading `missing`. These tests pin the CLI query's behavior
// on the exact fixture shapes the workflow branches on, via the real CLI
// (runGsdTools), not the in-process readVerificationStatus() helper used above.
describe('#2868: verification status CLI drives the execute-phase stranded-phase resume', () => {
  const { runGsdTools, createTempGitProject } = require('./helpers.cjs');

  test('D1: all plans summarized, no *-VERIFICATION.md → status is missing', () => {
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

      const res = runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir);
      assert.equal(res.success, true, `verification status should succeed: ${res.error}`);
      assert.equal(res.output, 'missing', 'no VERIFICATION.md at all → status must be missing');
    } finally {
      cleanup(projectDir);
    }
  });

  test('D2: same fixture plus a passed *-VERIFICATION.md → status is not missing', () => {
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
      fs.writeFileSync(
        path.join(phaseDir, '01-VERIFICATION.md'),
        '---\nstatus: passed\n---\n\n# Verification\n',
      );

      const res = runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir);
      assert.equal(res.success, true, `verification status should succeed: ${res.error}`);
      assert.notEqual(res.output, 'missing', 'a passed VERIFICATION.md must not read as missing');
      assert.equal(res.output, 'passed');
    } finally {
      cleanup(projectDir);
    }
  });

  test('D3: one plan lacking a SUMMARY and no verification → still missing (not conflated with "stranded")', () => {
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan 1\n');
      fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary 1\n');
      // 01-02 has a PLAN but no SUMMARY — plan work is still outstanding, which is
      // a different condition from the phase being "stranded" (all plans done,
      // verification never ran). The query must not conflate the two.
      fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan 2\n');

      const res = runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir);
      assert.equal(res.success, true, `verification status should succeed: ${res.error}`);
      assert.equal(
        res.output,
        'missing',
        'outstanding plan work must not change verification status away from missing',
      );
    } finally {
      cleanup(projectDir);
    }
  });
});

{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:fix-3174-quick-verification-status-read', () => {
  // allow-test-rule: source-text-is-the-product see #3174
  // Workflow .md / agent .md / command .md / reference .md files — their text
  // IS what the runtime loads. Testing text content tests the deployed contract.
  // Per CONTRIBUTING.md exception matrix.
  //
  // #3174: quick's verification step used to read the verifier's result with a
  // raw `grep "^status:" F | cut -d: -f2 | tr -d ' '` and route it through arms
  // passed / human_needed / gaps_found only. That read failed two ways, both
  // measured against the old pipeline: it matched NO arm on a missing report,
  // most off-schema values, a `status:` line in both frontmatter and prose, or
  // (on a CRLF checkout) a valid `passed` arriving as `passed\r`; and it
  // matched the SUCCESS arm when it should not have on a stale `passed`
  // report (staleness was never evaluated), a report whose only `status:` line
  // sits in its prose, or an off-schema value carrying a colon
  // (`passed:bogus`), which `cut -d: -f2` splits at that colon. The unanchored
  // match is the DEFECT.FRONTMATTER-SCALAR-BROAD-GREP class the code side
  // already fixed by name. These tests pin the five properties that keep the
  // replacement honest.
  describe('quick verification status read (#3174)', () => {
  const QUICK_VERIFICATION = path.join(
    __dirname, '..', 'gsd-core', 'workflows', 'quick', 'steps', 'quick-verification.md',
  );
  // The canonical launcher preamble. scripts/sync-runtime-launcher.cjs rewrites
  // every workflow's bootstrap from this file, so THIS is the authority — not
  // whichever sibling step file happens to carry a copy today.
  const LAUNCHER_SNIPPET = path.join(
    __dirname, '..', 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh',
  );

  const SHIM_ANCHOR = '_GSD_SHIM_NAME="gsd-tools.cjs"';

  test('status is read through the canonical query, not a raw frontmatter grep', () => {
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const queryIdx = content.indexOf('gsd_run query verification.status "${QUICK_DIR}"');

    assert.ok(queryIdx !== -1, 'quick-verification.md must read status via the verification.status query');
    assert.ok(
      !content.includes('grep "^status:"'),
      'the raw frontmatter-scalar grep must not return — it matches body lines too (DEFECT.FRONTMATTER-SCALAR-BROAD-GREP)',
    );
  });

  test('the query call is preceded by the runtime shim bootstrap in this step file', () => {
    // Step files are read and executed as their own units, so quick.md's
    // bootstrap does not reach here. Without this the call resolves to
    // nothing, 2>/dev/null swallows it, and the default arm is taken forever.
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const shimIdx = content.indexOf(SHIM_ANCHOR);
    const queryIdx = content.indexOf('gsd_run query verification.status');

    assert.ok(shimIdx !== -1, 'the step file must carry its own runtime shim bootstrap');
    assert.ok(queryIdx > shimIdx, 'the shim bootstrap must precede the gsd_run call');
  });

  test('the shim bootstrap is the canonical launcher preamble, not a fork of it', () => {
    // Anchored on _runtime-launcher.snippet.sh rather than on a sibling step
    // file: sync-runtime-launcher.cjs regenerates every workflow from the
    // snippet, so a synchronized launcher update keeps this green (correct),
    // and a sibling that legitimately stops calling gsd_run cannot fail us.
    const lineWithShim = (file) => fs.readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .find((line) => line.startsWith(SHIM_ANCHOR));

    const mine = lineWithShim(QUICK_VERIFICATION);
    const canonical = lineWithShim(LAUNCHER_SNIPPET);

    assert.ok(canonical, '_runtime-launcher.snippet.sh must carry the canonical preamble');
    assert.equal(mine, canonical, 'the bootstrap must match the canonical launcher snippet verbatim');
  });

  test('status extraction does not depend on jq', () => {
    // #2589: a `| jq -r '.field'` pipe yields an empty variable with no
    // diagnostic wherever jq is absent (the Windows/Git-Bash default), which
    // would route a passing verification into the recovery arm.
    //
    // Scoped to the executable fence on purpose: the surrounding prose cites
    // the jq form in order to explain why it is not used, and an assertion
    // over the whole file would fire on its own rationale.
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const contentLines = content.split(/\r?\n/);
    const fences = scanFencedBlocks(contentLines)
      .filter((b) => b.closeLineIdx !== -1 && (b.infoString || '').trim() === 'bash')
      .map((b) => contentLines.slice(b.openLineIdx, b.closeLineIdx + 1).join('\n'));
    const statusFence = fences.find((f) => f.includes('gsd_run query verification.status'));

    assert.ok(statusFence, 'the status read must live in a bash fence');
    assert.ok(
      statusFence.includes('--pick status'),
      'the bare status must be picked by the query itself',
    );
    assert.ok(!/\|\s*jq\b/.test(statusFence), 'the status-read fence must not pipe through jq');
  });

  test('the routing table carries a terminal arm for missing / stale / phase_dir_not_found — never unknown (#5118)', () => {
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const gapsIdx = content.indexOf('| `gaps_found` |');
    const fallbackIdx = content.indexOf('| anything else');

    assert.ok(gapsIdx !== -1, 'the three verifier-status arms must remain');
    assert.ok(fallbackIdx > gapsIdx, 'a terminal arm must follow the verifier-status arms');

    const fallbackRow = content.slice(fallbackIdx, content.indexOf('\n', fallbackIdx));
    for (const sentinel of ['missing', 'stale', 'phase_dir_not_found']) {
      assert.ok(
        fallbackRow.includes(sentinel),
        `the terminal arm must name the ${sentinel} sentinel the query can return`,
      );
    }
    assert.ok(!fallbackRow.includes('unknown'), 'unknown is no longer a status the query can return (#5118)');
    assert.ok(
      fallbackRow.includes('VERIFICATION_STATUS'),
      'the terminal arm must set the display string consumed by the quick index row and banner',
    );
  });
  });
  });
}

// ─── #4806: unparseable VERIFICATION.md frontmatter is a parse error, not "missing" ──

describe('#4806: unparseable VERIFICATION.md frontmatter reports a parse error, not missing', () => {
  test('a VERIFICATION.md whose frontmatter fails to parse reports status unparseable, not missing', () => {
    // The file EXISTS and verification ran — "missing" (and its next_command
    // re-running execute-phase) is a false statement about the phase. The
    // YAML syntax error is in the report, not in the phase's execution.
    const dir = mkPhaseDir('unparseable');
    fs.writeFileSync(path.join(dir, '01-foo-VERIFICATION.md'),
      '---\nstatus: "passed\n---\n\n# Verification Report\n');
    const result = readVerificationStatus(dir);
    assert.equal(result.status, 'unparseable', 'status must be unparseable');
    assert.ok(result.next_action.includes('not parseable YAML'),
      'next_action must name the YAML parse failure');
  });

  test('a well-formed control file still reports passed (unchanged)', () => {
    const dir = mkPhaseDir('control');
    writeVerificationMd(dir, '01-foo-VERIFICATION.md', 'passed');
    const result = readVerificationStatus(dir);
    assert.equal(result.status, 'passed');
  });
});

// ─── #4894: --project-dir reaches verification root resolution ───────────────
//
// `--project-dir` is validated and honored by the dispatcher, but verification
// derives its root from a PHASE DIRECTORY — `verification.fingerprint` and the
// staleness recompute behind `verification.status` / `phase.complete` — and
// never saw it. Fixture: a project with its own `.git`, `.planning` symlinked
// to a sibling externally git-managed store, and the phase directory addressed
// by its REAL store path (the phase-dir walk-up alone lands on the wrong root).
// Kept in this file, not a new one: lint-test-file-count caps verification.cjs
// at two test files.

const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';

function fingerprintDigest(result) {
  assert.ok(result.success, `fingerprint should succeed: ${result.error}`);
  return JSON.parse(result.output).covered_digest;
}

describe('#4894 --project-dir reaches verification root resolution', () => {
  const { runGsdTools } = require('./helpers.cjs');
  let base;
  let proj;
  let store;
  let realPhaseDir;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4894-')));
    proj = path.join(base, 'proj');
    store = path.join(base, 'store');
    realPhaseDir = path.join(store, 'phases', '01-x');
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.git'));
    fs.mkdirSync(realPhaseDir, { recursive: true });
    fs.mkdirSync(path.join(store, '.git'));
    fs.writeFileSync(path.join(store, 'config.json'), '{}');
    fs.writeFileSync(path.join(proj, 'src', 'a.txt'), 'hi\n');
    fs.writeFileSync(path.join(base, 'outside.txt'), 'not in the project\n');
    fs.symlinkSync(store, path.join(proj, '.planning'), symlinkType);
  });

  afterEach(() => {
    cleanup(base);
  });

  // The reference digest: the equivalent invocation from INSIDE the correct
  // root, no flag, phase dir addressed through the `.planning` symlink.
  function referenceDigest() {
    return fingerprintDigest(
      runGsdTools(['verification.fingerprint', '.planning/phases/01-x', 'src/a.txt'], proj),
    );
  }

  function writeReport(frontmatterBody) {
    fs.writeFileSync(path.join(realPhaseDir, '01-VERIFICATION.md'), `---\n${frontmatterBody}\n---\n`);
  }

  function status(args) {
    const res = runGsdTools(['query', 'verification.status', realPhaseDir, ...args, '--raw'], base);
    assert.ok(res.success, `verification.status should run: ${res.error}`);
    return JSON.parse(res.output).status;
  }

  test('criterion 1: fingerprint under --project-dir (unrelated cwd) matches the in-root, no-flag digest', () => {
    const digest = fingerprintDigest(
      runGsdTools(['verification.fingerprint', realPhaseDir, 'src/a.txt', '--project-dir', proj], base),
    );
    assert.equal(digest, referenceDigest());
  });

  test('criterion 2: a report carrying that digest reads passed under --project-dir', () => {
    const digest = referenceDigest();
    writeReport(`status: passed\ncovered_files:\n  - src/a.txt\ncovered_digest: "${digest}"`);
    assert.equal(status(['--project-dir', proj]), 'passed');
  });

  test('criterion 3: with no --project-dir, the same real-path invocations behave exactly as before', () => {
    const fp = runGsdTools(['verification.fingerprint', realPhaseDir, 'src/a.txt'], proj);
    assert.equal(fp.success, false, 'no flag: the phase-dir walk-up still lands on the wrong root');
    assert.match(fp.error, /could not compute fingerprint/);

    writeReport(`status: passed\ncovered_files:\n  - src/a.txt\ncovered_digest: "${referenceDigest()}"`);
    assert.equal(status([]), 'stale', 'no flag: the same well-formed report still reads stale');
  });

  test('criterion 4a: covered-file containment still rejects a path outside the explicit root', () => {
    const fp = runGsdTools(
      ['verification.fingerprint', realPhaseDir, '../outside.txt', '--project-dir', proj],
      base,
    );
    assert.equal(fp.success, false);
    assert.match(fp.error, /escapes the project root|could not compute fingerprint/);
  });

  test('criterion 4b: a malformed digest pair still fails closed to stale under --project-dir', () => {
    writeReport('status: passed\ncovered_files:\n  - src/a.txt');
    assert.equal(status(['--project-dir', proj]), 'stale', 'covered_files without covered_digest');

    writeReport(`status: passed\ncovered_files:\n  - src/a.txt\ncovered_digest: "v2:sha256:${'0'.repeat(64)}"`);
    assert.equal(status(['--project-dir', proj]), 'stale', 'a digest that does not match the files');
  });

  // The MCP server never calls setExplicitProjectRoot itself: `gsd_invoke_command`
  // reaches `dispatchGsdCommand`, which runs each command as a gsd-tools.cjs
  // SUBPROCESS, so the flag is honored by that child's main(). Pin it through
  // the real JSON-RPC surface so a future in-process dispatcher cannot silently
  // drop the flag on this path.
  test('criterion 5: --project-dir reaches verification through the MCP server (gsd_invoke_command)', () => {
    const { handleMessage } = require('../gsd-core/bin/lib/mcp-server.cjs');
    const invoke = (family, subcommand, args) => handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'gsd_invoke_command', arguments: { family, subcommand, args } } },
      { cwd: base },
    ).result;

    const reference = referenceDigest();
    const fp = invoke('verification', 'fingerprint', [realPhaseDir, 'src/a.txt', '--project-dir', proj]);
    assert.ok(!fp.isError, `MCP fingerprint should succeed: ${fp.content[0].text}`);
    assert.equal(fp.content[0].text.trim(), reference, 'MCP --raw digest == in-root CLI digest');
    assert.ok(invoke('verification', 'fingerprint', [realPhaseDir, 'src/a.txt']).isError,
      'no flag over MCP: still the wrong root, as before');

    writeReport(`status: passed\ncovered_files:\n  - src/a.txt\ncovered_digest: "${reference}"`);
    const mcpStatus = (args) => {
      const r = invoke('query', 'verification.status', [realPhaseDir, ...args]);
      assert.ok(!r.isError, `MCP verification.status should run: ${r.content[0].text}`);
      return JSON.parse(r.content[0].text).status;
    };
    assert.equal(mcpStatus(['--project-dir', proj]), 'passed');
    assert.equal(mcpStatus([]), 'stale', 'no flag over MCP: unchanged');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #5095 / ADR-5057 Phase 2: the fingerprint's input set is closed and
// idempotent. Rows below follow .gsd/phase/refactor-5095-fingerprint-input-set/
// 50-test-matrix.md's numbering (1-21). Targets the design's v3 API:
//   - FINGERPRINT_VERSION === 3, digest prefix v3:sha256: for fresh fingerprints
//   - computeCoveredDigest(projectRoot, coveredFiles, version, {phaseDir}):
//     unchanged signature; v3 filters report-shaped declared paths
//   - CLI `verification.fingerprint <phaseDir> <files...>` emits covered_files
//     as a superset of the declared list, including every live
//     *-PLAN.md/*-SUMMARY.md (root-relative posix), plus a v3 digest
//   - two containment roots: `.planning/...` paths confined to
//     realpath(<projectRoot>/.planning); other paths to realpath(projectRoot)
// Rows explicitly marked fail-first below are expected to fail against
// today's (v2, single-root, non-filtering, non-unioning) code.
// ═══════════════════════════════════════════════════════════════════════════
describe('fingerprint input set is closed and idempotent (#5095, ADR-5057 Phase 2)', () => {
  const { runGsdTools, createTempGitProject } = require('./helpers.cjs');

  function fpCli(projectDir, phaseDir, files) {
    return runGsdTools(['verification', 'fingerprint', phaseDir, ...files], projectDir);
  }

  function statusCli(projectDir, phaseDir) {
    const res = runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir);
    assert.ok(res.success, `verification status should run: ${res.error}`);
    return res.output;
  }

  function writeReportFrom(phaseDir, reportName, fpResult) {
    assert.equal(fpResult.success, true, `fingerprint should succeed: ${fpResult.output}${fpResult.error}`);
    const parsed = JSON.parse(fpResult.output);
    fs.writeFileSync(
      path.join(phaseDir, reportName),
      `---\nstatus: passed\ncovered_files:\n${parsed.covered_files.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${parsed.covered_digest}"\n---\n`,
    );
    return parsed;
  }

  // Amendment 1 fixture: a project whose `.planning` is a symlink to an
  // out-of-repo store, mirroring the documented "keep planning content out of
  // the tracked repo" layout. `dir`/`junction` per platform (#5095 brief).
  function mkSymlinkedPlanningProject(prefix) {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-proj-`));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-store-`));
    const gitOpts = { cwd: projectDir, timeoutMs: GIT_TIMEOUT_MS };
    gitOrThrow(['init', '-q'], gitOpts);
    gitOrThrow(['config', 'user.email', 'test@test.com'], gitOpts);
    gitOrThrow(['config', 'user.name', 'Test'], gitOpts);
    gitOrThrow(['config', 'commit.gpgsign', 'false'], gitOpts);
    gitOrThrow(['commit', '--allow-empty', '-q', '-m', 'init'], gitOpts);
    fs.mkdirSync(path.join(store, 'phases'), { recursive: true });
    fs.symlinkSync(store, path.join(projectDir, '.planning'), process.platform === 'win32' ? 'junction' : 'dir');
    return { projectDir, store };
  }

  // ── Row 1: happy path, v3 digest ──────────────────────────────────────────
  test('row 1: declared [plan, summary, impl], fresh → v3 digest; status passed', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'src', 'impl.ts'), 'export const x = 1;\n');

    const files = [
      '.planning/phases/01-foo/01-01-PLAN.md',
      '.planning/phases/01-foo/01-01-SUMMARY.md',
      'src/impl.ts',
    ];
    const digest = computeCoveredDigest(projectDir, files);
    assert.match(digest, /^v3:sha256:[0-9a-f]{64}$/, 'default fingerprint version must be v3 (#5095)');

    const fp = fpCli(projectDir, phaseDir, files);
    writeReportFrom(phaseDir, '01-VERIFICATION.md', fp);
    assert.equal(statusCli(projectDir, phaseDir), 'passed');
  });

  // ── Row 2 (CLI, fail-first #4857): a report is never an input to its own digest ──
  test('row 2: declared includes the report itself → digest unaffected; compute → write → recompute stable', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    const planRel = '.planning/phases/01-foo/01-01-PLAN.md';
    const summaryRel = '.planning/phases/01-foo/01-01-SUMMARY.md';
    const reportRel = '.planning/phases/01-foo/01-VERIFICATION.md'; // does not exist yet

    const fpWithout = fpCli(projectDir, phaseDir, [planRel, summaryRel]);
    assert.equal(fpWithout.success, true, `expected success: ${fpWithout.error}`);
    const fpWith = fpCli(projectDir, phaseDir, [planRel, summaryRel, reportRel]);
    assert.equal(
      fpWith.success, true,
      `declaring the not-yet-written report must not fail the fingerprint (filtered before the existence check): ${fpWith.error}`,
    );
    assert.equal(
      JSON.parse(fpWith.output).covered_digest,
      JSON.parse(fpWithout.output).covered_digest,
      'a report path in the declared set must not change the digest',
    );

    writeReportFrom(phaseDir, '01-VERIFICATION.md', fpWith);
    assert.equal(statusCli(projectDir, phaseDir), 'passed');
    assert.equal(statusCli(projectDir, phaseDir), 'passed', 'recompute must stay stable');
  });

  // ── Row 3 restated (R5): report-only declaration is evidence when the
  // phase HAS plans (digest over the plans/summaries), and fails closed only
  // when there is no other evidence to fall back on. ─────────────────────
  test('row 3a: report-only declared set on a phase WITH plans → digest computed over the plans (R5, fail-first)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-report-only-with-plans-'));
    t.after(() => cleanup(root));
    const phaseDir = path.join(root, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    const reportRel = '.planning/phases/01-foo/01-VERIFICATION.md';
    fs.writeFileSync(path.join(root, reportRel), '---\nstatus: passed\n---\n');
    const digest = computeCoveredDigest(root, [reportRel], 3, { phaseDir });
    assert.ok(
      digest,
      'a report-only declared set on a phase with real plans is evidence, not empty (R5)',
    );
  });

  test('row 3b: report-only declared set on a phase with NO plans → null (fail closed, kept)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-report-only-no-plans-'));
    t.after(() => cleanup(root));
    const phaseDir = path.join(root, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const reportRel = '.planning/phases/01-foo/01-VERIFICATION.md';
    // Exists on disk with real content — proves the null comes from the
    // report-path FILTER, not a missing-file coincidence (today's v2
    // default would hash it and return non-null).
    fs.writeFileSync(path.join(root, reportRel), '---\nstatus: passed\n---\n');
    assert.equal(
      computeCoveredDigest(root, [reportRel], 3, { phaseDir }), null,
      'v3: a report-only declared set with no plans/summaries to fall back on filters to empty → null',
    );
    assert.notEqual(
      computeCoveredDigest(root, [reportRel], 2), null,
      'sanity: v2 still hashes the report (proves the v3 null is the filter, not a missing file)',
    );
  });

  test('row 3 (CLI): fingerprinting only the report fails closed with no plans, succeeds when plans exist (R5, fail-first)', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const reportRel = '.planning/phases/01-foo/01-VERIFICATION.md';

    const withoutPlans = fpCli(projectDir, phaseDir, [reportRel]);
    assert.equal(
      withoutPlans.success, false,
      'a declared set that is only the report, with no plans in the phase, must fail the CLI',
    );

    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    const withPlans = fpCli(projectDir, phaseDir, [reportRel]);
    assert.equal(
      withPlans.success, true,
      `declaring only the report must still succeed once the phase has real plans/summaries: ${withPlans.error}`,
    );
  });

  // ── Row 4 (fail-first, negative): report-shaped files are filtered ───────
  test('row 4: -CORRECTION-VERIFICATION.md, bare VERIFICATION.md, docs/VERIFICATION.md are filtered', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-report-shaped-'));
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, 'impl.txt'), 'implementation content');
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, '07-CORRECTION-VERIFICATION.md'), '# worksheet\n');
    fs.writeFileSync(path.join(root, 'VERIFICATION.md'), '# bare report\n');
    fs.writeFileSync(path.join(root, 'docs', 'VERIFICATION.md'), '# doc report\n');

    const baseline = computeCoveredDigest(root, ['impl.txt']);
    const withReportShaped = computeCoveredDigest(root, [
      'impl.txt',
      '07-CORRECTION-VERIFICATION.md',
      'VERIFICATION.md',
      'docs/VERIFICATION.md',
    ]);
    assert.equal(
      withReportShaped, baseline,
      'report-shaped files (basename VERIFICATION.md or *-VERIFICATION.md) must not enter the v3 digest',
    );
  });

  // ── Row 5 (negative space): only report-shaped BASENAMES are filtered ────
  test('row 5: VERIFICATION-NOTES.md, X-VERIFICATION.md.bak, verification.md (lowercase) are NOT filtered', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-not-report-shaped-'));
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, 'impl.txt'), 'implementation content');
    fs.writeFileSync(path.join(root, 'VERIFICATION-NOTES.md'), 'notes');
    fs.writeFileSync(path.join(root, '07-VERIFICATION.md.bak'), 'backup');
    fs.writeFileSync(path.join(root, 'verification.md'), 'lowercase');

    const baseline = computeCoveredDigest(root, ['impl.txt']);
    const withNonReport = computeCoveredDigest(root, [
      'impl.txt', 'VERIFICATION-NOTES.md', '07-VERIFICATION.md.bak', 'verification.md',
    ]);
    assert.ok(withNonReport, 'must produce a real digest, not null');
    assert.notEqual(withNonReport, baseline, 'these basenames must still be hashed — they are not report-shaped');
  });

  // ── Row 6 (CLI, fail-first #4817): the emitter covers what the checker requires ──
  test('row 6: emitted covered_files ⊇ every live plan/summary even when the declared set omits them', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'src', 'impl.ts'), 'export const x = 1;\n');

    const fp = fpCli(projectDir, phaseDir, ['src/impl.ts']);
    assert.equal(fp.success, true, `expected success, got: ${fp.output}${fp.error}`);
    const parsed = JSON.parse(fp.output);
    assert.ok(
      parsed.covered_files.includes('.planning/phases/01-foo/01-01-PLAN.md'),
      `emitted covered_files must include the live PLAN even when undeclared; got: ${JSON.stringify(parsed.covered_files)}`,
    );
    assert.ok(
      parsed.covered_files.includes('.planning/phases/01-foo/01-01-SUMMARY.md'),
      `emitted covered_files must include the live SUMMARY even when undeclared; got: ${JSON.stringify(parsed.covered_files)}`,
    );

    writeReportFrom(phaseDir, '01-VERIFICATION.md', fp);
    assert.equal(statusCli(projectDir, phaseDir), 'passed', 'zero drift once the emitter self-completes the covered set');
  });

  // ── Row 7 (negative, regression-lock — R1(b)): a plan added after a v3
  // fingerprint changes the input set, so the digest → stale. ─────────────
  test('row 7: a plan added after fingerprinting → stale', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    const fp = fpCli(projectDir, phaseDir, [
      '.planning/phases/01-foo/01-01-PLAN.md',
      '.planning/phases/01-foo/01-01-SUMMARY.md',
    ]);
    writeReportFrom(phaseDir, '01-VERIFICATION.md', fp);
    assert.equal(statusCli(projectDir, phaseDir), 'passed');

    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# A new plan, never fingerprinted\n');
    assert.equal(statusCli(projectDir, phaseDir), 'stale');
  });

  // ── Row 8 (positive control, regression-lock) ─────────────────────────────
  test('row 8: covered impl file edited after fingerprinting → stale (positive control)', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'src', 'impl.ts'), 'export const x = 1;\n');
    const files = [
      '.planning/phases/01-foo/01-01-PLAN.md',
      '.planning/phases/01-foo/01-01-SUMMARY.md',
      'src/impl.ts',
    ];

    const fp = fpCli(projectDir, phaseDir, files);
    writeReportFrom(phaseDir, '01-VERIFICATION.md', fp);
    assert.equal(statusCli(projectDir, phaseDir), 'passed');

    fs.writeFileSync(path.join(projectDir, 'src', 'impl.ts'), 'export const x = 2;\n');
    assert.equal(statusCli(projectDir, phaseDir), 'stale');
  });

  // ── R1(a) (CLI, fail-first): --raw returns only the digest, and a caller
  // that writes its OWN declared list (no plans/summaries) plus that raw
  // digest still reads passed — the checker adds the same union on both
  // sides, so the caller never has to enumerate plans/summaries itself. ────
  test('R1(a): --raw digest + a self-written declared list omitting plans/summaries → status passed', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'src', 'impl.ts'), 'export const x = 1;\n');
    const declared = ['src/impl.ts'];

    const raw = runGsdTools(['verification', 'fingerprint', phaseDir, ...declared, '--raw'], projectDir);
    assert.equal(raw.success, true, `--raw fingerprint should succeed: ${raw.error}`);
    assert.match(raw.output.trim(), /^v3:sha256:[0-9a-f]{64}$/, '--raw must emit only the digest, no JSON envelope');

    // The caller declares ONLY its own list — no plans/summaries — and pairs
    // it with the raw digest. The checker's own union (stored ∪ live
    // plans/summaries) must still match.
    fs.writeFileSync(
      path.join(phaseDir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n${declared.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${raw.output.trim()}"\n---\n`,
    );
    assert.equal(statusCli(projectDir, phaseDir), 'passed');
  });

  // ── Row 9 (CLI, fail-first — amendment 1) ─────────────────────────────────
  test('row 9: .planning symlinked to an out-of-repo store; phase artifacts declared → digest computed, status passed', (t) => {
    const { projectDir, store } = mkSymlinkedPlanningProject('gsd-5095-row9');
    t.after(() => { cleanup(projectDir); cleanup(store); });
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    const files = [
      '.planning/phases/01-foo/01-01-PLAN.md',
      '.planning/phases/01-foo/01-01-SUMMARY.md',
    ];

    const fp = fpCli(projectDir, phaseDir, files);
    assert.equal(
      fp.success, true,
      `an out-of-repo .planning store must be its own containment root, not rejected as escaping projectRoot: ${fp.error}`,
    );
    writeReportFrom(phaseDir, '01-VERIFICATION.md', fp);
    assert.equal(statusCli(projectDir, phaseDir), 'passed');
  });

  // ── Row 10 (regression-lock): impl files stay confined to the checkout ───
  test('row 10: src/x.cts stays confined to the checkout root even with an out-of-repo .planning store', (t) => {
    const { projectDir, store } = mkSymlinkedPlanningProject('gsd-5095-row10');
    t.after(() => { cleanup(projectDir); cleanup(store); });
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'src', 'x.cts'), 'export const x = 1;\n');
    const digest = computeCoveredDigest(projectDir, ['src/x.cts']);
    assert.ok(digest, 'an ordinary checkout-relative file must still hash');
    assert.match(digest, /^v3:sha256:/);
  });

  // ── Row 11 (hostile, regression-lock) ─────────────────────────────────────
  test('row 11: .planning/phases/07/evil → a target outside the planning store is refused', (t) => {
    const { projectDir, store } = mkSymlinkedPlanningProject('gsd-5095-row11');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-row11-outside-'));
    t.after(() => { cleanup(projectDir); cleanup(store); cleanup(outside); });
    fs.mkdirSync(path.join(store, 'phases', '07'), { recursive: true });
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'not covered by this project');
    fs.symlinkSync(outsideFile, path.join(store, 'phases', '07', 'evil'));

    assert.equal(
      computeCoveredDigest(projectDir, ['.planning/phases/07/evil']),
      null,
      'a planning-rooted path whose target escapes the planning store must fail closed',
    );
  });

  // ── Row 12 (hostile, regression-lock) ─────────────────────────────────────
  test('row 12: src/link → a file inside the out-of-repo planning store must stay confined to the checkout, not the store', (t) => {
    const { projectDir, store } = mkSymlinkedPlanningProject('gsd-5095-row12');
    t.after(() => { cleanup(projectDir); cleanup(store); });
    fs.mkdirSync(path.join(projectDir, 'src'));
    const storeFile = path.join(store, 'leaked.txt');
    fs.writeFileSync(storeFile, 'store content, not checkout content');
    fs.symlinkSync(storeFile, path.join(projectDir, 'src', 'link'));

    assert.equal(
      computeCoveredDigest(projectDir, ['src/link']),
      null,
      'a non-planning path must be confined to the checkout root, even if its target sits inside the planning store',
    );
  });

  // Row 13 (`../x`, absolute, `''` → null) is already covered by the #4155
  // describe block above ('an escape via ".."', 'an absolute covered path',
  // 'an empty covered-files array') — matrix marks it "existing, kept".

  // ── Row 14 (independence — upgrade, regression-lock) ──────────────────────
  test('row 14: a stored v2 digest recomputes fresh under v2 semantics, unaffected by the v3 upgrade', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-v2-independence-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-foo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'content');
    const v2Digest = computeCoveredDigest(dir, ['impl.txt'], 2);
    fs.writeFileSync(
      path.join(dir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n  - impl.txt\ncovered_digest: "${v2Digest}"\n---\n`,
    );
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'passed', 'a v2-pinned report must recompute under v2 semantics, not v3');
  });

  // ── Row 15 (CLI, independence): a self-covering v2 report heals with one v3 restamp ──
  test('row 15: a stored v2 digest that covered the report stays stale; a v3 restamp is stable', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    const reportPath = path.join(phaseDir, '01-VERIFICATION.md');
    const planRel = '.planning/phases/01-foo/01-01-PLAN.md';
    const summaryRel = '.planning/phases/01-foo/01-01-SUMMARY.md';
    const reportRel = '.planning/phases/01-foo/01-VERIFICATION.md';

    // Seed the report file so it exists to be hashed as a v2 covered input.
    fs.writeFileSync(reportPath, '---\nstatus: passed\n---\n');
    const v2Digest = computeCoveredDigest(projectDir, [planRel, summaryRel, reportRel], 2, { phaseDir });
    // Overwriting the report to embed that digest changes the report's own
    // bytes — the exact #4857 self-covering trap.
    fs.writeFileSync(
      reportPath,
      `---\nstatus: passed\ncovered_files:\n  - ${planRel}\n  - ${summaryRel}\n  - ${reportRel}\ncovered_digest: "${v2Digest}"\n---\n`,
    );
    assert.equal(statusCli(projectDir, phaseDir), 'stale', 'a v2 report that covers itself never stabilizes');

    // Restamp via the v3 CLI (report excluded by construction).
    const fp = fpCli(projectDir, phaseDir, [planRel, summaryRel]);
    writeReportFrom(phaseDir, '01-VERIFICATION.md', fp);
    assert.equal(statusCli(projectDir, phaseDir), 'passed', 'v3 restamp must heal it');
    assert.equal(statusCli(projectDir, phaseDir), 'passed', 'and stay stable on a second recompute');
  });

  // ── Row 16 (CLI, fail-first, boundary): nested plans/ and a superseded plan ──
  test('row 16: emitter includes nested plans/ files and a superseded plan; checker passes', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '---\nstatus: superseded\n---\n# old plan\n');
    const nestedDir = path.join(phaseDir, 'plans');
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(path.join(nestedDir, 'PLAN-01.md'), '# nested plan\n');
    fs.writeFileSync(path.join(nestedDir, 'SUMMARY-01.md'), '# nested summary\n');
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'src', 'thing.cts'), 'export const x = 1;\n');

    const fp = fpCli(projectDir, phaseDir, ['src/thing.cts']);
    assert.equal(fp.success, true, `expected success, got: ${fp.output}${fp.error}`);
    const parsed = JSON.parse(fp.output);
    for (const expected of [
      '.planning/phases/01-foo/01-01-PLAN.md',
      '.planning/phases/01-foo/01-01-SUMMARY.md',
      '.planning/phases/01-foo/01-02-PLAN.md',
      '.planning/phases/01-foo/plans/PLAN-01.md',
      '.planning/phases/01-foo/plans/SUMMARY-01.md',
    ]) {
      assert.ok(
        parsed.covered_files.includes(expected),
        `covered_files must include ${expected}; got: ${JSON.stringify(parsed.covered_files)}`,
      );
    }

    writeReportFrom(phaseDir, '01-VERIFICATION.md', fp);
    assert.equal(statusCli(projectDir, phaseDir), 'passed');
  });

  // ── Row 17 (boundary, regression-lock): spelling normalization ───────────
  test('row 17: "./.planning/…" and ".planning//phases/…" normalize to the same v3 digest', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const canonical = computeCoveredDigest(projectDir, ['.planning/phases/01-foo/01-01-PLAN.md']);
    const dotPrefixed = computeCoveredDigest(projectDir, ['./.planning/phases/01-foo/01-01-PLAN.md']);
    const doubleSlash = computeCoveredDigest(projectDir, ['.planning//phases/01-foo/01-01-PLAN.md']);
    assert.equal(dotPrefixed, canonical);
    assert.equal(doubleSlash, canonical);
  });

  // ── Row 21 (cross-platform, regression-lock): backslash spelling ─────────
  test('row 21: a backslash-spelled declared path hashes the same file as its forward-slash spelling', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), 'line1\r\nline2\r\n');

    const forward = computeCoveredDigest(projectDir, ['.planning/phases/01-foo/01-01-PLAN.md']);
    const backslash = computeCoveredDigest(projectDir, ['.planning\\phases\\01-foo\\01-01-PLAN.md']);
    assert.equal(backslash, forward, 'a backslash-spelled path must normalize to the same posix key');
  });

  // ── R2 (CLI, fail-first): the #4894 --project-dir layout, now WITH plans ──
  // in the store's real phase dir — the digest and status must both see them
  // once artifact paths are mapped to the root they actually live in.
  test('R2: #4894 --project-dir layout with plans in the store phase dir → fingerprint then status passed', (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-r2-')));
    t.after(() => cleanup(base));
    const proj = path.join(base, 'proj');
    const store = path.join(base, 'store');
    const realPhaseDir = path.join(store, 'phases', '01-x');
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.git'));
    fs.mkdirSync(realPhaseDir, { recursive: true });
    fs.mkdirSync(path.join(store, '.git'));
    fs.writeFileSync(path.join(store, 'config.json'), '{}');
    fs.writeFileSync(path.join(proj, 'src', 'a.txt'), 'hi\n');
    fs.symlinkSync(store, path.join(proj, '.planning'), symlinkType);
    fs.writeFileSync(path.join(realPhaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(realPhaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    const fp = runGsdTools(
      ['verification', 'fingerprint', realPhaseDir, 'src/a.txt', '--project-dir', proj],
      base,
    );
    assert.equal(fp.success, true, `fingerprint under --project-dir with plans present should succeed: ${fp.error}`);
    const parsed = JSON.parse(fp.output);
    fs.writeFileSync(
      path.join(realPhaseDir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n${parsed.covered_files.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${parsed.covered_digest}"\n---\n`,
    );
    const res = runGsdTools(['query', 'verification.status', realPhaseDir, '--project-dir', proj, '--raw'], base);
    assert.ok(res.success, `verification.status should run: ${res.error}`);
    assert.equal(JSON.parse(res.output).status, 'passed');
  });

  // ── R3 (CLI, fail-first): a plan-scan match that is ALSO report-shaped ────
  // (`07-PLAN-01-VERIFICATION.md` matches the plan-scan pattern for phase 07
  // AND `isVerificationReportPath`) must never enter covered_files, while
  // the phase's real plan/summary still do — one report predicate on both
  // sides (R3).
  test('R3: 07-PLAN-01-VERIFICATION.md is both plan-shaped and report-shaped → excluded from covered_files; status passed', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '07-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '07-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '07-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(
      path.join(phaseDir, '07-PLAN-01-VERIFICATION.md'),
      '---\nstatus: passed\n---\n# report-shaped plan-scan overlap\n',
    );

    const fp = fpCli(projectDir, phaseDir, [
      '.planning/phases/07-foo/07-01-PLAN.md',
      '.planning/phases/07-foo/07-01-SUMMARY.md',
    ]);
    assert.equal(fp.success, true, `expected success, got: ${fp.output}${fp.error}`);
    const parsed = JSON.parse(fp.output);
    assert.ok(
      !parsed.covered_files.includes('.planning/phases/07-foo/07-PLAN-01-VERIFICATION.md'),
      `report-shaped plan-scan overlap must never enter covered_files; got: ${JSON.stringify(parsed.covered_files)}`,
    );

    writeReportFrom(phaseDir, '07-VERIFICATION.md', fp);
    assert.equal(statusCli(projectDir, phaseDir), 'passed');
  });

  // ── R4 (CLI, fail-first): a per-scope store — `.planning` is a REAL dir,
  // but `.planning/phases` is symlinked to a separate store dir holding the
  // phase (the phase's own planning root, per sharedPlanningRoots/R4). ─────
  test('R4: .planning is real, .planning/phases symlinks to a separate phase store → fingerprint + status passed', (t) => {
    const projectDir = createTempGitProject();
    const phasesStore = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-r4-phases-store-'));
    t.after(() => { cleanup(projectDir); cleanup(phasesStore); });
    // createTempGitProject() already created a real `.planning/phases`; this
    // fixture needs `.planning` to stay real but `.planning/phases` to be a
    // symlink to a separate store, so the pre-created real `phases` dir must
    // be removed before the symlink is created in its place.
    cleanup(path.join(projectDir, '.planning', 'phases'));
    fs.mkdirSync(path.join(phasesStore, '01-foo'), { recursive: true });
    fs.symlinkSync(phasesStore, path.join(projectDir, '.planning', 'phases'), symlinkType);
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    const files = [
      '.planning/phases/01-foo/01-01-PLAN.md',
      '.planning/phases/01-foo/01-01-SUMMARY.md',
    ];

    const fp = fpCli(projectDir, phaseDir, files);
    assert.equal(
      fp.success, true,
      `a per-scope store (.planning real, .planning/phases symlinked) must resolve, not be rejected as escaping: ${fp.error}`,
    );
    writeReportFrom(phaseDir, '01-VERIFICATION.md', fp);
    assert.equal(statusCli(projectDir, phaseDir), 'passed');
  });

  // ── R4/R1 upgrade safety (a), regression-lock: an in-repo `.planning ->
  // docs/planning` alias. A stored v2 digest built directly via
  // computeCoveredDigest(root, files, 2, {phaseDir}) with files declared
  // using the ALIAS spelling (`docs/planning/phases/...`) must still read
  // passed after the v3 upgrade — v1/v2 recomputation is version-pinned and
  // untouched by the v3 union/filter changes. ──────────────────────────────
  test('R4/R1(a): in-repo .planning -> docs/planning alias; stored v2 digest built with alias spelling stays passed', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const realPhaseDir = path.join(projectDir, 'docs', 'planning', 'phases', '01-foo');
    // createTempGitProject() already created a real `.planning` dir; the
    // fixture here needs `docs/planning` to be the REAL directory and
    // `.planning` to be a symlink pointing at it, so the pre-created real
    // dir must be removed before the symlink is created in its place.
    cleanup(path.join(projectDir, '.planning'));
    fs.mkdirSync(realPhaseDir, { recursive: true });
    fs.symlinkSync(path.join(projectDir, 'docs', 'planning'), path.join(projectDir, '.planning'), symlinkType);
    fs.writeFileSync(path.join(realPhaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(realPhaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    const aliasFiles = [
      'docs/planning/phases/01-foo/01-01-PLAN.md',
      'docs/planning/phases/01-foo/01-01-SUMMARY.md',
    ];

    const v2Digest = computeCoveredDigest(projectDir, aliasFiles, 2, { phaseDir: realPhaseDir });
    assert.ok(v2Digest, 'the alias spelling must still hash under v2');
    fs.writeFileSync(
      path.join(realPhaseDir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n${aliasFiles.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${v2Digest}"\n---\n`,
    );
    assert.equal(statusCli(projectDir, realPhaseDir), 'passed');
  });

  // ── R4/R1 upgrade safety (b), regression-lock: a stored v2 report whose
  // covered_files use a redundant `./`-prefixed (still root-relative) spelling
  // — the phase-relative-suffix-matchable form `allCurrentArtifactsCovered`
  // already accepted before the v3 upgrade — must stay passed. ─────────────
  test('R4/R1(b): stored v2 report with a redundant dot-prefixed spelling stays passed (suffix path)', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    const dotFiles = [
      './.planning/phases/01-foo/01-01-PLAN.md',
      './.planning/phases/01-foo/01-01-SUMMARY.md',
    ];

    const v2Digest = computeCoveredDigest(projectDir, dotFiles, 2, { phaseDir });
    assert.ok(v2Digest, 'a dot-prefixed but still root-relative spelling must hash under v2');
    fs.writeFileSync(
      path.join(phaseDir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n${dotFiles.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${v2Digest}"\n---\n`,
    );
    assert.equal(statusCli(projectDir, phaseDir), 'passed');
  });

  // ── R7 (a) (CLI, fail-first): a symlinked workstream `phases/` directory —
  // `.planning/workstreams/ws1` is REAL but its own `phases/` is symlinked to
  // a separate store. The anchored `.planning/workstreams/ws1` scope must be
  // recognised (never only the top-level `.planning` scope), so the emitted
  // covered_files/containment spelling is
  // `.planning/workstreams/ws1/phases/<phase>/…`, not dropped (null) and not
  // silently re-hashed under a same-named root-scope phase. ────────────────
  test('R7(a): .planning/workstreams/ws1/phases symlinked to a separate store → spelled under the workstream scope; status passed', (t) => {
    const projectDir = createTempGitProject();
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-r7a-store-'));
    t.after(() => { cleanup(projectDir); cleanup(store); });
    fs.mkdirSync(path.join(projectDir, '.planning', 'workstreams', 'ws1'), { recursive: true });
    fs.mkdirSync(path.join(store, '01-foo'), { recursive: true });
    fs.symlinkSync(store, path.join(projectDir, '.planning', 'workstreams', 'ws1', 'phases'), symlinkType);
    const phaseDir = path.join(projectDir, '.planning', 'workstreams', 'ws1', 'phases', '01-foo');
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    const env = { GSD_WORKSTREAM: 'ws1' };
    const planRel = '.planning/workstreams/ws1/phases/01-foo/01-01-PLAN.md';
    const summaryRel = '.planning/workstreams/ws1/phases/01-foo/01-01-SUMMARY.md';
    const fp = runGsdTools(['verification', 'fingerprint', phaseDir, planRel, summaryRel], projectDir, env);
    assert.equal(fp.success, true, `fingerprint over a symlinked workstream phases/ dir must succeed: ${fp.output}${fp.error}`);
    const parsed = JSON.parse(fp.output);
    for (const expected of [planRel, summaryRel]) {
      assert.ok(
        parsed.covered_files.includes(expected),
        `covered_files must be spelled under the workstream scope; got: ${JSON.stringify(parsed.covered_files)}`,
      );
    }
    fs.writeFileSync(
      path.join(phaseDir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n${parsed.covered_files.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${parsed.covered_digest}"\n---\n`,
    );
    const res = runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir, env);
    assert.ok(res.success, `verification status should run: ${res.error}`);
    assert.equal(res.output, 'passed');
  });

  // ── R7 (b) (CLI, fail-first, hostile): the same-name trap — a REAL
  // root-scope `.planning/phases/07-x/07-01-PLAN.md` and a DIFFERENT plan
  // under a workstream store also named `07-x`. Fingerprinting the
  // workstream phase must hash the WORKSTREAM's own plan bytes, never the
  // same-named root-scope phase's — proven by mutating only the workstream
  // store's plan and observing `stale`. ────────────────────────────────────
  test('R7(b): same-name phase in root scope and workstream scope → the workstream file is hashed, not the root one', (t) => {
    const projectDir = createTempGitProject();
    const wsStore = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-r7b-store-'));
    t.after(() => { cleanup(projectDir); cleanup(wsStore); });

    // Root-scope phase '07-x' with its own plan (createTempGitProject already
    // made .planning/phases real).
    const rootPhaseDir = path.join(projectDir, '.planning', 'phases', '07-x');
    fs.mkdirSync(rootPhaseDir, { recursive: true });
    fs.writeFileSync(path.join(rootPhaseDir, '07-01-PLAN.md'), '# root-scope plan\n');

    // Workstream-scope phase, SAME name '07-x', DIFFERENT plan content, via a
    // symlinked workstream phases/ dir.
    fs.mkdirSync(path.join(projectDir, '.planning', 'workstreams', 'ws1'), { recursive: true });
    fs.mkdirSync(path.join(wsStore, '07-x'), { recursive: true });
    fs.symlinkSync(wsStore, path.join(projectDir, '.planning', 'workstreams', 'ws1', 'phases'), symlinkType);
    const wsPhaseDir = path.join(projectDir, '.planning', 'workstreams', 'ws1', 'phases', '07-x');
    fs.writeFileSync(path.join(wsPhaseDir, '07-01-PLAN.md'), '# workstream-scope plan\n');

    const env = { GSD_WORKSTREAM: 'ws1' };
    const planRel = '.planning/workstreams/ws1/phases/07-x/07-01-PLAN.md';
    const fp = runGsdTools(['verification', 'fingerprint', wsPhaseDir, planRel], projectDir, env);
    assert.equal(fp.success, true, `fingerprint should succeed: ${fp.output}${fp.error}`);
    const parsed = JSON.parse(fp.output);
    fs.writeFileSync(
      path.join(wsPhaseDir, '07-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n${parsed.covered_files.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${parsed.covered_digest}"\n---\n`,
    );
    const statusRes = () => runGsdTools(['verification', 'status', wsPhaseDir, '--pick', 'status'], projectDir, env);
    assert.equal(statusRes().output, 'passed', 'freshly fingerprinted workstream phase must read passed');

    // Mutate ONLY the workstream store's plan — the root-scope '07-x' plan is
    // untouched. If the digest had hashed the root-scope file instead, this
    // mutation would be invisible and status would stay 'passed'.
    fs.appendFileSync(path.join(wsPhaseDir, '07-01-PLAN.md'), '// mutated\n');
    assert.equal(
      statusRes().output,
      'stale',
      'mutating the workstream plan must stale the phase — proves the workstream file, not the root file, was hashed',
    );
  });

  // ── R7 (c) (hostile, security): `.planning -> /` must never become an
  // admissible containment root — the scope is refused outright, not merely
  // ignored, so a covered path spelled under it fails closed rather than
  // silently gaining root-filesystem containment (every path is "inside"
  // `/`). ────────────────────────────────────────────────────────────────
  test('R7(c): .planning symlinked to the filesystem root is refused, not admitted', (t) => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-r7c-'));
    t.after(() => cleanup(projectDir));
    const fsRoot = path.parse(projectDir).root;
    fs.symlinkSync(fsRoot, path.join(projectDir, '.planning'), symlinkType);

    const digest = computeCoveredDigest(projectDir, ['.planning/etc/hosts']);
    assert.equal(
      digest,
      null,
      'a .planning -> filesystem-root symlink must be refused as a containment root, not silently admitted',
    );
  });

  // #5095: the filesystem-root construction above depends on `/etc/hosts`
  // existing and on being able to symlink to the literal root — true on every
  // dev machine and CI runner, but not guaranteed in every sandbox. This
  // variant exercises the identical refusal rule ("a scope that is an
  // ancestor of the checkout is refused") with a shape that needs nothing
  // outside a plain tmpdir, so it is deterministic on macOS AND on a
  // root-in-Linux bench alike. It is also the ACTUAL regression case: running
  // as root, `enumeratePlanningScopes` used to `listDirs` the (lexically
  // symlinked) `.planning` directory and mint a fresh, individually-legitimate
  // `.planning/<name>` scope for every entry it found there — so a `.planning`
  // refused as an ancestor of the checkout could still leak a SIBLING
  // directory's file back in through a scope minted from its own listing, as
  // long as that sibling directory's own realpath was neither the filesystem
  // root nor an ancestor of the checkout. Fixed by never walking a refused
  // `.planning` base's children into further scopes.
  test('R7(c\'): .planning symlinked to an ancestor of the checkout is refused, and its sibling directories do not leak in as scopes', (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5095-r7c-ancestor-'));
    t.after(() => cleanup(base));
    const checkout = path.join(base, 'checkout');
    fs.mkdirSync(checkout);
    // A sibling of `checkout`, OUTSIDE it, that `.planning`'s own directory
    // listing would surface as a would-be `.planning/outside` scope.
    fs.mkdirSync(path.join(base, 'outside'));
    fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'not part of the checkout\n');
    fs.symlinkSync(base, path.join(checkout, '.planning'), symlinkType);

    assert.equal(
      computeCoveredDigest(checkout, ['.planning/outside/secret.txt']),
      null,
      'a file reachable only through an ancestor-of-checkout .planning symlink must never be hashed',
    );
  });

  // ── Rows 18-20: properties (ADR ratchet) ──────────────────────────────────
  describe('properties (rows 18-20)', () => {
    const fc = require('./helpers/fast-check-setup.cjs');

    // Build a phase with a generated shape and fingerprint it via the real
    // CLI (the shipping call shape). Each case lives in its own subdir (its
    // own createTempGitProject / mkSymlinkedPlanningProject call).
    function buildAndFingerprint({ nPlans, nSummaries, nImpl, declareReport, symlinked }) {
      let projectDir;
      let store = null;
      if (symlinked) {
        const built = mkSymlinkedPlanningProject('gsd-5095-prop');
        projectDir = built.projectDir;
        store = built.store;
      } else {
        projectDir = createTempGitProject();
      }
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
      fs.mkdirSync(phaseDir, { recursive: true });
      for (let i = 0; i < nPlans; i++) {
        fs.writeFileSync(path.join(phaseDir, `01-0${i + 1}-PLAN.md`), `# Plan ${i}\n`);
      }
      for (let i = 0; i < nSummaries; i++) {
        fs.writeFileSync(path.join(phaseDir, `01-0${i + 1}-SUMMARY.md`), `# Summary ${i}\n`);
      }
      fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
      const implFiles = [];
      for (let i = 0; i < nImpl; i++) {
        const rel = `src/impl${i}.ts`;
        fs.writeFileSync(path.join(projectDir, rel), `export const x = ${i};\n`);
        implFiles.push(rel);
      }
      const declared = [...implFiles];
      if (declareReport) declared.push('.planning/phases/01-foo/01-VERIFICATION.md');
      if (declared.length === 0) {
        // computeCoveredDigest fails closed on an empty declared set — every
        // generated case must declare at least one real file.
        if (nPlans > 0) declared.push('.planning/phases/01-foo/01-01-PLAN.md');
        else if (nSummaries > 0) declared.push('.planning/phases/01-foo/01-01-SUMMARY.md');
        else {
          fs.writeFileSync(path.join(projectDir, 'src', 'fallback.ts'), 'export const y = 0;\n');
          declared.push('src/fallback.ts');
        }
      }

      const fp = runGsdTools(['verification', 'fingerprint', phaseDir, ...declared], projectDir);
      return { projectDir, store, phaseDir, fp };
    }

    // `try/finally` here is confined to a standalone helper with no access to
    // test context (CONTRIBUTING.md's carve-out) — every property callback
    // below calls this instead of holding its own try/finally.
    function withBuiltCase(shape, fn) {
      const built = buildAndFingerprint(shape);
      try {
        return fn(built);
      } finally {
        cleanup(built.projectDir);
        if (built.store) cleanup(built.store);
      }
    }

    test('row 18: compute → write → recompute is stable (fingerprint idempotence)', () => {
      fc.assert(
        fc.property(
          fc.record({
            nPlans: fc.integer({ min: 0, max: 3 }),
            nSummaries: fc.integer({ min: 0, max: 2 }),
            nImpl: fc.integer({ min: 0, max: 2 }),
            declareReport: fc.boolean(),
            symlinked: fc.boolean(),
          }),
          (shape) => {
            withBuiltCase(shape, ({ projectDir, phaseDir, fp }) => {
              assert.equal(fp.success, true, `fingerprint must succeed for shape ${JSON.stringify(shape)}: ${fp.output}${fp.error}`);
              const parsed = JSON.parse(fp.output);
              fs.writeFileSync(
                path.join(phaseDir, '01-VERIFICATION.md'),
                `---\nstatus: passed\ncovered_files:\n${parsed.covered_files.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${parsed.covered_digest}"\n---\n`,
              );
              const res1 = runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir);
              assert.equal(res1.success, true);
              assert.equal(res1.output, 'passed', `shape ${JSON.stringify(shape)} must read passed after restamping`);
              const res2 = runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir);
              assert.equal(res2.output, 'passed', 'recompute must stay stable');
            });
          },
        ),
        { numRuns: 25 },
      );
    });

    test('row 19: mutating one covered impl byte after fingerprinting → stale (property positive control)', () => {
      fc.assert(
        fc.property(
          fc.record({
            nPlans: fc.integer({ min: 0, max: 3 }),
            nSummaries: fc.integer({ min: 0, max: 2 }),
            declareReport: fc.boolean(),
            symlinked: fc.boolean(),
          }),
          (partial) => {
            const shape = { ...partial, nImpl: 1 }; // guarantee a mutation target
            withBuiltCase(shape, ({ projectDir, phaseDir, fp }) => {
              assert.equal(fp.success, true, `fingerprint must succeed for shape ${JSON.stringify(shape)}: ${fp.output}${fp.error}`);
              const parsed = JSON.parse(fp.output);
              fs.writeFileSync(
                path.join(phaseDir, '01-VERIFICATION.md'),
                `---\nstatus: passed\ncovered_files:\n${parsed.covered_files.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${parsed.covered_digest}"\n---\n`,
              );
              assert.equal(
                runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir).output,
                'passed',
              );
              fs.appendFileSync(path.join(projectDir, 'src', 'impl0.ts'), '// mutated\n');
              assert.equal(
                runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir).output,
                'stale',
                `shape ${JSON.stringify(shape)} must go stale after a covered-byte mutation`,
              );
            });
          },
        ),
        { numRuns: 25 },
      );
    });

    test('row 20: emitted covered_files is always a superset of every live plan/summary (emitter/checker parity)', () => {
      fc.assert(
        fc.property(
          fc.record({
            nPlans: fc.integer({ min: 0, max: 3 }),
            nSummaries: fc.integer({ min: 0, max: 2 }),
            nImpl: fc.integer({ min: 1, max: 2 }), // always at least one real declared file
            declareReport: fc.boolean(),
            symlinked: fc.boolean(),
          }),
          (shape) => {
            withBuiltCase(shape, ({ fp }) => {
              assert.equal(fp.success, true, `fingerprint must succeed for shape ${JSON.stringify(shape)}: ${fp.output}${fp.error}`);
              const parsed = JSON.parse(fp.output);
              for (let i = 0; i < shape.nPlans; i++) {
                assert.ok(
                  parsed.covered_files.includes(`.planning/phases/01-foo/01-0${i + 1}-PLAN.md`),
                  `plan ${i} missing from covered_files for shape ${JSON.stringify(shape)}`,
                );
              }
              for (let i = 0; i < shape.nSummaries; i++) {
                assert.ok(
                  parsed.covered_files.includes(`.planning/phases/01-foo/01-0${i + 1}-SUMMARY.md`),
                  `summary ${i} missing from covered_files for shape ${JSON.stringify(shape)}`,
                );
              }
            });
          },
        ),
        { numRuns: 25 },
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #5118 / ADR-5057 Phase 4: `VerificationStatus` is a closed enum with ONE
// owner (src/verification.cts), a status outside it is a hard error, `stale`
// has one route, and a missing phase directory reads `phase_dir_not_found`.
// Rows V1–V37, V48–V50 (#5118, ADR-5057 §3). Every row is red against `next`
// @ 582cb382ea except the regression locks / controls.
// Kept in this file, not a new one: lint-test-file-count caps verification.cjs.
// ═══════════════════════════════════════════════════════════════════════════

const { createTempProject } = require('./helpers.cjs');

const WRITER_5118 = ['passed', 'gaps_found', 'human_needed'];
const MEMBERS_5118 = ['passed', 'gaps_found', 'human_needed', 'stale', 'missing', 'unparseable', 'phase_dir_not_found'];

/** Late-bound read of the owner module so a not-yet-exported name reads as undefined, not a load-time crash. */
function owner5118() {
  return require('../gsd-core/bin/lib/verification.cjs');
}

/**
 * Write `<tmp>/<dirName>/01-VERIFICATION.md` carrying `status: <status>` and
 * register cleanup on the test context.
 */
function writeReport5118(t, status, { dirName = '01-foo', extraFm = '' } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5118-'));
  t.after(() => cleanup(parent));
  const dir = path.join(parent, dirName);
  fs.mkdirSync(dir);
  const file = path.join(dir, '01-VERIFICATION.md');
  fs.writeFileSync(file, `---\nstatus: ${status}\n${extraFm}---\n\n# Verification\n`);
  return { parent, dir, file };
}

/** Assert `fn` throws the owner's typed out-of-set error and return it. */
function expectOutOfSet5118(fn, { raw, file } = {}) {
  const { VerificationStatusError } = owner5118();
  assert.equal(typeof VerificationStatusError, 'function', 'VerificationStatusError must be exported by the owner');
  let caught = null;
  assert.throws(fn, (err) => {
    caught = err;
    return true;
  }, 'an out-of-set status must be a hard error, not a routed value');
  assert.ok(caught instanceof VerificationStatusError, `expected VerificationStatusError, got ${caught && caught.name}`);
  assert.ok(caught instanceof Error);
  assert.equal(caught.code, 'ERR_VERIFICATION_STATUS_OUT_OF_SET');
  assert.equal(caught.reason, 'verification_status_invalid');
  assert.deepEqual([...caught.accepted].sort(), [...WRITER_5118].sort(), 'the error carries the accepted values (#4817)');
  if (raw !== undefined) assert.deepEqual(caught.rawStatus, raw);
  if (file !== undefined) assert.equal(path.resolve(caught.file), path.resolve(file));
  return caught;
}

describe('#5118 A: the closed VerificationStatus enum and its one routing table', () => {
  test('V1: VERIFICATION_STATUS is frozen and holds exactly the seven members — no `unknown`', () => {
    const { VERIFICATION_STATUS } = owner5118();
    assert.ok(VERIFICATION_STATUS && typeof VERIFICATION_STATUS === 'object', 'VERIFICATION_STATUS must be exported');
    assert.ok(Object.isFrozen(VERIFICATION_STATUS));
    assert.deepEqual(Object.values(VERIFICATION_STATUS).sort(), [...MEMBERS_5118].sort());
    assert.equal(Object.values(VERIFICATION_STATUS).includes('unknown'), false);
  });

  test('V2: VERIFIER_STATUSES is a frozen Set holding exactly the writer set, a subset of the enum', () => {
    const { VERIFIER_STATUSES: writerSet, VERIFICATION_STATUS } = owner5118();
    assert.ok(writerSet instanceof Set, 'VERIFIER_STATUSES must be a Set (the writer contract), not an array');
    assert.ok(Object.isFrozen(writerSet));
    assert.deepEqual([...writerSet].sort(), [...WRITER_5118].sort());
    const members = new Set(Object.values(VERIFICATION_STATUS || {}));
    for (const s of writerSet) {
      assert.ok(members.has(s), `writer status ${JSON.stringify(s)} must be a VERIFICATION_STATUS member`);
    }
  });

  test('V3: VERIFICATION_ROUTES is keyed by exactly the enum (7 keys, no 8th), carries no per-entry status, and names one stale route', () => {
    const { VERIFICATION_ROUTES: routes } = owner5118();
    assert.ok(routes && typeof routes === 'object', 'VERIFICATION_ROUTES must be exported');
    assert.ok(Object.isFrozen(routes));
    assert.deepEqual(Object.keys(routes).sort(), [...MEMBERS_5118].sort());
    const commands = new Set(['', 'execute-phase', 'plan-phase', 'verify-work']);
    for (const [status, route] of Object.entries(routes)) {
      assert.equal(Object.prototype.hasOwnProperty.call(route, 'status'), false, `${status}: the key is the status`);
      assert.ok(commands.has(route.command), `${status}: command ${JSON.stringify(route.command)} is not a routable command`);
      assert.equal(typeof route.next_action, 'string', `${status}: next_action`);
    }
    assert.equal(routes.stale.command, 'execute-phase', 'the single stale route regenerates through execute-phase');
    assert.equal(routes.missing.command, 'execute-phase');
    assert.equal(routes.gaps_found.command, 'plan-phase');
    assert.equal(routes.gaps_found.tail, ' --gaps', 'the gaps tail is table data, not a hard-coded return');
    assert.equal(routes.human_needed.command, 'verify-work');
    assert.equal(routes.passed.command, '');
    assert.equal(routes.unparseable.command, '');
    assert.equal(routes.phase_dir_not_found.command, '', 'a missing phase dir is a usage error, never execute-phase');
  });

  test('V4: isVerificationStatus accepts every member and nothing else', () => {
    const { isVerificationStatus } = owner5118();
    assert.equal(typeof isVerificationStatus, 'function', 'isVerificationStatus must be exported');
    for (const m of MEMBERS_5118) assert.equal(isVerificationStatus(m), true, m);
    for (const bad of ['unknown', 'verified', 'Passed', ' passed', '', 5, true, null, undefined, ['passed'], {}]) {
      assert.equal(isVerificationStatus(bad), false, JSON.stringify(bad));
    }
  });

  test('V5: assertVerificationStatus returns for a member and throws a TypeError naming the call site otherwise', () => {
    const { assertVerificationStatus } = owner5118();
    assert.equal(typeof assertVerificationStatus, 'function', 'assertVerificationStatus must be exported');
    assert.doesNotThrow(() => assertVerificationStatus('stale', 'V5'));
    assert.throws(() => assertVerificationStatus('verified', 'V5-site'), (err) => err instanceof TypeError && err.message.includes('V5-site'));
  });

  test('V6: property — isVerificationStatus(s) holds exactly when s is an enum value', () => {
    const fc = require('./helpers/fast-check-setup.cjs');
    const { isVerificationStatus, VERIFICATION_STATUS } = owner5118();
    assert.equal(typeof isVerificationStatus, 'function', 'isVerificationStatus must be exported');
    const values = Object.values(VERIFICATION_STATUS || {});
    fc.assert(fc.property(fc.oneof(fc.string(), fc.constantFrom(...MEMBERS_5118)), (s) => {
      assert.equal(isVerificationStatus(s), values.includes(s), JSON.stringify(s));
    }), { numRuns: 300 });
  });

  // The writer contract "imports" the enum the only way a prose agent can:
  // its template's status tokens are parity-locked to VERIFIER_STATUSES.
  function templateStatusTokens(text) {
    const tokens = new Set();
    for (const line of text.split(/\r?\n/)) {
      const m = /^status:\s+([a-z_]+(?:\s*\|\s*[a-z_]+)+)\s*$/.exec(line);
      if (m) for (const token of m[1].split('|')) tokens.add(token.trim());
    }
    return tokens;
  }

  function statusValueBullets(text) {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith('**Status values (overall'));
    const tokens = new Set();
    if (start === -1) return tokens;
    for (let i = start + 1; i < lines.length; i += 1) {
      const m = /^- `([a-z_]+)` — /.exec(lines[i]);
      if (!m) break;
      tokens.add(m[1]);
    }
    return tokens;
  }

  test('V7: gsd-verifier.md and templates/verification-report.md spell exactly VERIFIER_STATUSES', () => {
    const writer = [...owner5118().VERIFIER_STATUSES].sort();
    const agent = fs.readFileSync(path.join(__dirname, '..', 'agents', 'gsd-verifier.md'), 'utf-8');
    const template = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'templates', 'verification-report.md'), 'utf-8');
    assert.deepEqual([...templateStatusTokens(agent)].sort(), writer, 'agent <output> frontmatter template');
    assert.deepEqual([...templateStatusTokens(template)].sort(), writer, 'report template frontmatter line');
    assert.deepEqual([...statusValueBullets(template)].sort(), writer, 'report template "Status values" bullets');
  });

  test('V7c CONTROL: the parity extractor sees an extra template token (not a pass-always check)', () => {
    const template = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'templates', 'verification-report.md'), 'utf-8');
    const drifted = template.replace(/^status: passed \| gaps_found \| human_needed$/m, 'status: passed | gaps_found | human_needed | verified');
    assert.notEqual(drifted, template, 'control precondition: the template line was rewritten');
    assert.notDeepEqual([...templateStatusTokens(drifted)].sort(), [...WRITER_5118].sort());
  });
});

describe('#5118 B: an out-of-set report status is a hard error in the reader', () => {
  test('V8: status: verified (#4817) throws VerificationStatusError naming the value, the file and the accepted set', (t) => {
    const { dir, file } = writeReport5118(t, 'verified');
    const err = expectOutOfSet5118(() => readVerificationStatus(dir, NO_GIT_TIMES), { raw: 'verified', file });
    for (const token of ['verified', ...WRITER_5118]) {
      assert.ok(err.message.includes(token), `the message must name ${token}: ${err.message}`);
    }
  });

  test('V9: status: Passed is out of set — exact match, no case folding', (t) => {
    const { dir } = writeReport5118(t, 'Passed');
    expectOutOfSet5118(() => readVerificationStatus(dir, NO_GIT_TIMES), { raw: 'Passed' });
  });

  test('V10: a reader-only member written into a report is out of set (stale, missing, unparseable, phase_dir_not_found, unknown)', (t) => {
    for (const status of ['stale', 'missing', 'unparseable', 'phase_dir_not_found', 'unknown']) {
      const { dir } = writeReport5118(t, status);
      expectOutOfSet5118(() => readVerificationStatus(dir, NO_GIT_TIMES), { raw: status });
    }
  });

  test('V11: a non-string status (5, true, a list) is out of set, never folded to missing', (t) => {
    for (const scalar of ['5', 'true', '[passed]']) {
      const { dir } = writeReport5118(t, scalar);
      expectOutOfSet5118(() => readVerificationStatus(dir, NO_GIT_TIMES));
    }
  });

  test('V12: boundary around a member — passe (limit-1) throws, passed (limit) routes, passedx (limit+1) throws', (t) => {
    const short = writeReport5118(t, 'passe');
    expectOutOfSet5118(() => readVerificationStatus(short.dir, NO_GIT_TIMES), { raw: 'passe' });
    const exact = writeReport5118(t, 'passed');
    const result = readVerificationStatus(exact.dir, NO_GIT_TIMES);
    assert.equal(result.status, 'passed');
    assert.equal(result.route, '');
    const long = writeReport5118(t, 'passedx');
    expectOutOfSet5118(() => readVerificationStatus(long.dir, NO_GIT_TIMES), { raw: 'passedx' });
  });

  test('V13: the hard error is not masked by staleness — out-of-set status plus a drifted fingerprint throws, never reads stale', (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5118-masked-'));
    t.after(() => cleanup(parent));
    const dir = path.join(parent, '01-foo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'original');
    const digest = computeCoveredDigest(dir, ['impl.txt']);
    const report = (status) => `---\nstatus: ${status}\ncovered_files:\n  - impl.txt\ncovered_digest: "${digest}"\n---\n`;
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'drifted');

    fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), report('passed'));
    assert.equal(readVerificationStatus(dir, NO_GIT_TIMES).status, 'stale', 'control: this drift stales a passed report');

    fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), report('verified'));
    expectOutOfSet5118(() => readVerificationStatus(dir, NO_GIT_TIMES), { raw: 'verified' });
  });

  test('V14: regression lock — an empty status and an absent status key still read missing', (t) => {
    const empty = writeReport5118(t, '""');
    assert.equal(readVerificationStatus(empty.dir, NO_GIT_TIMES).status, 'missing');
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5118-nokey-'));
    t.after(() => cleanup(parent));
    const dir = path.join(parent, '01-foo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), '---\nphase: 01-foo\n---\n');
    assert.equal(readVerificationStatus(dir, NO_GIT_TIMES).status, 'missing');
  });

  test('V15: every result carries `route`, projected from the same table entry as next_command', (t) => {
    const { VERIFICATION_ROUTES: routes } = owner5118();
    assert.ok(routes, 'VERIFICATION_ROUTES must be exported');
    const cases = [];

    for (const status of WRITER_5118) {
      const { dir } = writeReport5118(t, status);
      cases.push({ status, result: readVerificationStatus(dir, NO_GIT_TIMES) });
    }

    const stale = writeReport5118(t, 'passed');
    const summaryPath = path.join(stale.dir, '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, '# Summary\n');
    setMtime(stale.file, '2026-01-01T00:00:00.000Z');
    setMtime(summaryPath, '2026-01-01T00:01:00.000Z');
    cases.push({ status: 'stale', result: readVerificationStatus(stale.dir, NO_GIT_TIMES) });

    const emptyParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5118-route-missing-'));
    t.after(() => cleanup(emptyParent));
    const emptyDir = path.join(emptyParent, '01-foo');
    fs.mkdirSync(emptyDir);
    cases.push({ status: 'missing', result: readVerificationStatus(emptyDir, NO_GIT_TIMES) });

    const unparseable = writeReport5118(t, '"passed');
    cases.push({ status: 'unparseable', result: readVerificationStatus(unparseable.dir, NO_GIT_TIMES) });

    const expectedNext = {
      passed: '',
      gaps_found: '/gsd-plan-phase 01 --gaps',
      human_needed: '/gsd-verify-work 01',
      stale: '/gsd-execute-phase 01',
      missing: '/gsd-execute-phase 01',
      unparseable: '',
    };
    for (const { status, result } of cases) {
      assert.equal(result.status, status);
      assert.ok(Object.prototype.hasOwnProperty.call(result, 'route'), `${status}: every result carries route`);
      assert.equal(result.route, routes[status].command, `${status}: route is the table's command`);
      assert.equal(result.next_command, expectedNext[status], `${status}: next_command`);
    }
  });

  test('V16: property — every non-member status string throws; every writer member routes through the one table', (t) => {
    const fc = require('./helpers/fast-check-setup.cjs');
    const { VerificationStatusError, VERIFICATION_ROUTES: routes } = owner5118();
    assert.equal(typeof VerificationStatusError, 'function', 'VerificationStatusError must be exported');
    assert.ok(routes, 'VERIFICATION_ROUTES must be exported');
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5118-prop-'));
    t.after(() => cleanup(parent));
    const dir = path.join(parent, '01-foo');
    fs.mkdirSync(dir);
    const file = path.join(dir, '01-VERIFICATION.md');

    // YAML `null` is "no value", not an out-of-set value — excluded by construction.
    const nonMember = fc.stringMatching(/^[A-Za-z0-9_]{1,24}$/)
      .filter((s) => !WRITER_5118.includes(s) && !/^(null|Null|NULL)$/.test(s));
    fc.assert(fc.property(nonMember, (s) => {
      fs.writeFileSync(file, `---\nstatus: ${s}\n---\n`);
      assert.throws(() => readVerificationStatus(dir, NO_GIT_TIMES), VerificationStatusError, JSON.stringify(s));
    }), { numRuns: 150 });

    for (const m of WRITER_5118) {
      fs.writeFileSync(file, `---\nstatus: ${m}\n---\n`);
      const result = readVerificationStatus(dir, NO_GIT_TIMES);
      assert.equal(result.status, m);
      assert.equal(result.route, routes[m].command, m);
    }
  });

  test('V17: isPhaseComplete keeps its no-throw contract — an out-of-set report degrades to an unreadable scope', (t) => {
    const { dir } = writeReport5118(t, 'verified');
    let completion = null;
    assert.doesNotThrow(() => {
      completion = isPhaseComplete(dir, NO_GIT_TIMES);
    });
    assert.equal(completion.scope, 'unreadable', 'the owner answers "could not read", never a confident verdict');
    assert.equal(completion.value.complete, false);
    // Review decision C: `unparseable` keeps ONE meaning (the frontmatter does
    // not parse). The out-of-set projection is status null, no route, and the
    // typed error carried in the value.
    assert.equal(completion.value.verification.status, null, 'an out-of-set report is not `unparseable`');
    assert.equal(completion.value.verification.route, '');
    assert.equal(completion.value.verification.next_command, '');
    assert.ok(completion.value.statusError instanceof owner5118().VerificationStatusError, 'the value carries the typed error');
    assert.ok(completion.value.verification.next_action.includes('verified'), 'next_action is the error message naming the value');
  });

  test('V17b: an in-set report carries no statusError (boundary with V17)', (t) => {
    const { dir } = writeReport5118(t, 'passed');
    const completion = isPhaseComplete(dir, NO_GIT_TIMES);
    assert.equal(completion.value.statusError, undefined);
    assert.equal(completion.value.verification.status, 'passed');
  });

  test('V17c: the parked-error cell is gone — no module-level channel carries the error past its caller', () => {
    assert.equal(owner5118().takePendingVerificationStatusError, undefined, 'the error travels in results, never in module state');
    assert.equal(owner5118().VERIFICATION_STATUS_ERROR_CODE, 'ERR_VERIFICATION_STATUS_OUT_OF_SET', 'the code constant is exported for every matcher');
  });
});

describe('#5118 review H: the echoed raw status is sanitized and bounded', () => {
  const { formatDiagnosticToken } = require('../gsd-core/bin/lib/io.cjs');
  const hex4 = (cp) => cp.toString(16).padStart(4, '0');

  test('H1: every invisible / bidi range endpoint is escaped as \\uXXXX, never emitted raw', () => {
    const endpoints = [0x7f, 0x9f, 0x2028, 0x2029, 0x200b, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff];
    for (const cp of endpoints) {
      const token = formatDiagnosticToken(`a${String.fromCharCode(cp)}b`);
      assert.equal(token, `"a\\u${hex4(cp)}b"`, `U+${hex4(cp).toUpperCase()}`);
      assert.equal(token.includes(String.fromCharCode(cp)), false);
    }
  });

  test('H1b: neighbours just outside each range pass through unchanged (boundary)', () => {
    for (const cp of [0x7e, 0xa0, 0x200a, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a, 0xfefe, 0xff00]) {
      const token = formatDiagnosticToken(`a${String.fromCharCode(cp)}b`);
      assert.equal(token, JSON.stringify(`a${String.fromCharCode(cp)}b`), `U+${hex4(cp).toUpperCase()}`);
    }
  });

  test('H2: the raw status token is cut at 120 characters — limit-1 / limit / limit+1', (t) => {
    const { VerificationStatusError } = owner5118();
    // A plain ASCII string of length L renders as L + 2 characters (its quotes).
    const render = (raw) => new VerificationStatusError(raw, '/p/01-VERIFICATION.md').message;
    const at119 = 'a'.repeat(117);
    const at120 = 'a'.repeat(118);
    const at121 = 'a'.repeat(119);
    assert.ok(render(at119).includes(`"${at119}"`), 'limit-1: whole');
    assert.ok(render(at120).includes(`"${at120}"`), 'limit: whole');
    assert.equal(render(at120).includes('more)'), false);
    assert.ok(render(at121).includes(`"${'a'.repeat(119)}…(1 more)`), 'limit+1: cut with the remainder count');
    t.diagnostic('rendered token length is bounded by RAW_STATUS_TOKEN_LIMIT');
  });

  test('H3: a 200k-character status with a bidi override is bounded and escaped in the error message', (t) => {
    const { VerificationStatusError } = owner5118();
    const hostile = `${String.fromCharCode(0x202e)}${'x'.repeat(200000)}`;
    const { dir, file } = writeReport5118(t, 'placeholder');
    fs.writeFileSync(file, `---\nstatus: ${hostile}\n---\n`);
    const err = expectOutOfSet5118(() => readVerificationStatus(dir, NO_GIT_TIMES));
    assert.ok(err instanceof VerificationStatusError);
    assert.ok(err.message.length < 2000, `message must be bounded, got ${err.message.length} chars`);
    assert.equal(err.message.includes(String.fromCharCode(0x202e)), false, 'the bidi override never reaches the message raw');
    assert.ok(err.message.includes('\\u202e'), 'it is escaped');
    assert.match(err.message, /…\(\d+ more\)/);
  });
});

describe('#5118 review (security): a report outside its phase directory is never read into a message', () => {
  test('S1: a VERIFICATION symlink escaping the phase dir reads `missing` and discloses nothing', {
    skip: process.platform === 'win32' ? 'symlink semantics differ on win32' : false,
  }, (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5118-escape-'));
    t.after(() => cleanup(parent));
    const outside = path.join(parent, 'outside.md');
    fs.writeFileSync(outside, '---\nstatus: TOP_SECRET_5118_VALUE\n---\n');
    const dir = path.join(parent, '01-foo');
    fs.mkdirSync(dir);
    fs.symlinkSync(outside, path.join(dir, '01-VERIFICATION.md'));

    const result = readVerificationStatus(dir, NO_GIT_TIMES);
    assert.equal(result.status, 'missing', 'refused before any byte is read');
    assert.equal(JSON.stringify(result).includes('TOP_SECRET_5118_VALUE'), false);
    const completion = isPhaseComplete(dir, NO_GIT_TIMES);
    assert.equal(completion.value.statusError, undefined);
    assert.equal(owner5118().findVerificationStatusError([dir]), null);
  });

  test('S1 CONTROL: the same report inside the phase dir IS read (and judged out of set)', (t) => {
    const { dir } = writeReport5118(t, 'TOP_SECRET_5118_VALUE');
    expectOutOfSet5118(() => readVerificationStatus(dir, NO_GIT_TIMES));
  });
});

describe('#5118 review A: the command-routing hub returns the out-of-set error as a pure Result', () => {
  test('A1: a handler that throws VerificationStatusError yields {ok:false, kind:ERROR_KINDS.VerificationStatusInvalid, message, reason, file}', () => {
    const { createHub, ERROR_KINDS } = require('../gsd-core/bin/lib/command-routing-hub.cjs');
    const { VerificationStatusError } = owner5118();
    const thrown = new VerificationStatusError('verified', '/p/01-foo/01-VERIFICATION.md');
    const hub = createHub({
      cjsRegistry: { fam: { sub: () => { throw thrown; } } },
      manifest: { fam: ['sub'] },
    });
    const result = hub.dispatch({ family: 'fam', subcommand: 'sub' });
    assert.deepEqual({ ...result }, {
      ok: false,
      kind: ERROR_KINDS.VerificationStatusInvalid,
      message: thrown.message,
      reason: 'verification_status_invalid',
      file: '/p/01-foo/01-VERIFICATION.md',
    });
    assert.equal(result.reason, thrown.reason, 'the Result carries the error\'s own ERROR_REASON');
  });

  test('A1 CONTROL: any other thrown Error stays a HandlerFailure', () => {
    const { createHub } = require('../gsd-core/bin/lib/command-routing-hub.cjs');
    const hub = createHub({
      cjsRegistry: { fam: { sub: () => { throw new Error('boom'); } } },
      manifest: { fam: ['sub'] },
    });
    const result = hub.dispatch({ family: 'fam', subcommand: 'sub' });
    assert.equal(result.kind, 'HandlerFailure');
  });
});

describe('#5118 C: a missing phase directory reads phase_dir_not_found and routes to a usage error', () => {
  const { runGsdTools } = require('./helpers.cjs');

  function assertDirNotFound(result, label) {
    assert.equal(result.status, 'phase_dir_not_found', label);
    assert.equal(result.route, '', `${label}: route`);
    assert.equal(result.next_command, '', `${label}: never /gsd-execute-phase`);
    assert.equal(typeof result.message, 'string', `${label}: message`);
    assert.ok(result.message.length > 0, `${label}: the usage error is named`);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'error'), false, `${label}: an error field would declare DEGRADED`);
    assert.doesNotMatch(result.next_action, /execute-phase/, `${label}: next_action`);
  }

  function tmpParent(t, tag) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-5118-${tag}-`));
    t.after(() => cleanup(parent));
    return parent;
  }

  test('V18: ENOENT — a nonexistent path', (t) => {
    const parent = tmpParent(t, 'enoent');
    assertDirNotFound(readVerificationStatus(path.join(parent, '03-gone'), NO_GIT_TIMES), 'ENOENT');
  });

  test('V19: ENOTDIR — a path whose parent is a regular file', (t) => {
    const parent = tmpParent(t, 'enotdir');
    fs.writeFileSync(path.join(parent, 'a-file'), 'x');
    assertDirNotFound(readVerificationStatus(path.join(parent, 'a-file', '01-foo'), NO_GIT_TIMES), 'ENOTDIR');
  });

  test('V20: a regular file where the phase directory should be', (t) => {
    const parent = tmpParent(t, 'isfile');
    const notADir = path.join(parent, '01-foo');
    fs.writeFileSync(notADir, '---\nstatus: passed\n---\n');
    assertDirNotFound(readVerificationStatus(notADir, NO_GIT_TIMES), 'regular file');
  });

  test('V21: a dangling symlink is not found; a symlink to a real phase dir reads normally', {
    skip: process.platform === 'win32' ? 'symlink creation needs elevated privilege on Windows' : false,
  }, (t) => {
    const parent = tmpParent(t, 'symlink');
    const dangling = path.join(parent, '01-dangling');
    fs.symlinkSync(path.join(parent, 'nowhere'), dangling);
    assertDirNotFound(readVerificationStatus(dangling, NO_GIT_TIMES), 'dangling symlink');

    const target = path.join(parent, 'store');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, '01-VERIFICATION.md'), '---\nstatus: passed\n---\n');
    const linked = path.join(parent, '01-foo');
    fs.symlinkSync(target, linked, 'dir');
    assert.equal(readVerificationStatus(linked, NO_GIT_TIMES).status, 'passed');
  });

  test('V22: a containment-error FsLike (code-less Error) stays missing — never phase_dir_not_found', () => {
    const containment = () => {
      throw new Error('planning-inspect: path escapes planning root');
    };
    const fsLike = { readdirSync: containment, readFileSync: containment, statSync: containment };
    const result = readVerificationStatus(path.join(os.tmpdir(), 'gsd-5118-contained', '01-foo'), { fs: fsLike, ...NO_GIT_TIMES });
    assert.equal(result.status, 'missing');
  });

  test('V23: EACCES on an existing directory (FsLike with isDirectory) stays missing with an unreadable completion scope', () => {
    const fsLike = {
      statSync: () => ({ mtimeMs: 0, isFile: () => false, isDirectory: () => true }),
      readdirSync: () => {
        throw Object.assign(new Error('EACCES: permission denied (injected)'), { code: 'EACCES' });
      },
      readFileSync: () => {
        throw Object.assign(new Error('EACCES: permission denied (injected)'), { code: 'EACCES' });
      },
    };
    const phaseDir = path.join(os.tmpdir(), 'gsd-5118-eacces', '01-foo');
    assert.equal(readVerificationStatus(phaseDir, { fs: fsLike, ...NO_GIT_TIMES }).status, 'missing');
    assert.equal(isPhaseComplete(phaseDir, { fs: fsLike, ...NO_GIT_TIMES }).scope, 'unreadable');
  });

  test('V24: boundary with V18 — an existing empty directory is missing and routes to execute-phase', (t) => {
    const parent = tmpParent(t, 'empty');
    const dir = path.join(parent, '01-foo');
    fs.mkdirSync(dir);
    const result = readVerificationStatus(dir, NO_GIT_TIMES);
    assert.equal(result.status, 'missing');
    assert.equal(result.route, 'execute-phase');
    assert.equal(result.next_command, '/gsd-execute-phase 01');
  });

  test('V25: CLI — exit 0 under both exit contracts, --pick status prints phase_dir_not_found, no error field', (t) => {
    const parent = tmpParent(t, 'cli');
    const gone = path.join(parent, '.planning', 'phases', '03-gone');
    for (const contract of ['v1', 'v2']) {
      const res = runGsdTools(['verification', 'status', gone], parent, { GSD_EXIT_CONTRACT: contract });
      assert.equal(res.exitCode, 0, `${contract}: a usage answer is not a degraded run: ${res.error}`);
      const json = JSON.parse(res.output);
      assertDirNotFound(json, `CLI ${contract}`);
    }
    const picked = runGsdTools(['verification', 'status', gone, '--pick', 'status'], parent);
    assert.equal(picked.output, 'phase_dir_not_found');
  });

  test('V26: #4987 repro — an archived phase: the old path is not found, the milestones path reads passed', (t) => {
    const projectDir = createTempProject('gsd-5118-archived-');
    t.after(() => cleanup(projectDir));
    const archived = path.join(projectDir, '.planning', 'milestones', 'v1.0-phases', '03-x');
    fs.mkdirSync(archived, { recursive: true });
    fs.writeFileSync(path.join(archived, '03-VERIFICATION.md'), '---\nstatus: passed\n---\n');
    const old = runGsdTools(['verification', 'status', path.join(projectDir, '.planning', 'phases', '03-x'), '--pick', 'status'], projectDir);
    assert.equal(old.output, 'phase_dir_not_found');
    const moved = runGsdTools(['verification', 'status', archived, '--pick', 'status'], projectDir);
    assert.equal(moved.output, 'passed');
  });

  test('V27: verification.resolve-file distinguishes a nonexistent directory from an existing empty one', (t) => {
    const parent = tmpParent(t, 'resolve');
    const empty = path.join(parent, '01-foo');
    fs.mkdirSync(empty);
    const gone = path.join(parent, '02-gone');
    const a = runGsdTools(['query', 'verification.resolve-file', empty], parent);
    const b = runGsdTools(['query', 'verification.resolve-file', gone], parent);
    assert.equal(a.exitCode, 0, a.error);
    assert.equal(b.exitCode, 0, b.error);
    assert.notDeepEqual(JSON.parse(b.output), JSON.parse(a.output), 'a missing directory must not read as "exists, no report"');
  });

  test('V28: init progress — a roadmap-only phase (no directory) reads phase_dir_not_found with no next command', (t) => {
    const projectDir = createTempProject('gsd-5118-roadmap-only-');
    t.after(() => cleanup(projectDir));
    writeSurfaceFixture5118(projectDir, 'passed');
    const res = runGsdTools(['init', 'progress'], projectDir);
    assert.equal(res.exitCode, 0, res.error);
    const phase2 = JSON.parse(res.output).phases.find((p) => String(p.number).replace(/^0+/, '') === '2');
    assert.ok(phase2, 'fixture precondition: ROADMAP phase 2 is listed');
    assert.equal(phase2.verification_status, 'phase_dir_not_found');
    assert.equal(phase2.verification_next_command, '');
    assert.equal(phase2.verification_route, '');
  });
});

/**
 * ROADMAP (phases 1 and 2, progress table), STATE, PROJECT, config, and a
 * phase-01 directory with one plan, one summary and a report carrying
 * `status: <status>`. Phase 2 has no directory (roadmap-only).
 */
function writeSurfaceFixture5118(projectDir, status) {
  const planningDir = path.join(projectDir, '.planning');
  const phaseDir = path.join(planningDir, 'phases', '01-foundation');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'PROJECT.md'), '# Project\n\nA fixture project.\n');
  fs.writeFileSync(path.join(planningDir, 'config.json'), '{}\n');
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
    '# Roadmap', '',
    '- [ ] Phase 1: Foundation', '- [ ] Phase 2: API', '',
    '### Phase 1: Foundation', '**Goal:** Setup', '**Plans:** 1 plans', '',
    '### Phase 2: API', '**Goal:** Build API', '',
    '## Progress', '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 01. Foundation | 0/1 | Not started | - |',
    '| 02. API | 0/1 | Not started | - |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), [
    '# State', '',
    '**Current Phase:** 01', '**Current Phase Name:** Foundation', '**Status:** In progress',
    '**Current Plan:** 01-01', '**Last Activity:** 2025-01-01', '**Last Activity Description:** Working on phase 1', '',
  ].join('\n'));
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
  fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
  const reportPath = path.join(phaseDir, '01-VERIFICATION.md');
  fs.writeFileSync(reportPath, `---\nstatus: ${status}\n---\n\n# Verification\n`);
  return { phaseDir, reportPath };
}

/** The structured `--json-errors` envelope: the last stderr line that parses as `{ ok: false }`. */
function errorEnvelope5118(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && parsed.ok === false) return parsed;
    } catch {
      // not the envelope line
    }
  }
  return null;
}

describe('#5118 D: every CLI surface translates the out-of-set error once, centrally', () => {
  const { runGsdTools } = require('./helpers.cjs');

  function project(t, status) {
    const projectDir = createTempProject('gsd-5118-surface-');
    t.after(() => cleanup(projectDir));
    return { projectDir, ...writeSurfaceFixture5118(projectDir, status) };
  }

  // Every planning file a surface could write — compared byte for byte
  // before/after a refused run (review decision B: no write before the error).
  function planningBytes(projectDir) {
    const planning = path.join(projectDir, '.planning');
    const out = {};
    for (const name of ['STATE.md', 'ROADMAP.md', 'REQUIREMENTS.md', 'state.json']) {
      const file = path.join(planning, name);
      out[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    }
    return out;
  }

  // Review decision A: read-only aggregates CARRY the owner's error in their
  // own result and fail with its reason; writers fail before their first write.
  const SURFACES = [
    { row: 'V29', name: 'verification status', argv: (phaseDir) => ['verification', 'status', phaseDir] },
    { row: 'V30', name: 'phase uat-passed', argv: () => ['phase', 'uat-passed', '1', '--require-verification'] },
    { row: 'V32', name: 'roadmap analyze', argv: () => ['roadmap', 'analyze'] },
    { row: 'V33', name: 'state sync', argv: () => ['state', 'sync'] },
    { row: 'V34', name: 'planning inspect', argv: () => ['planning', 'inspect'] },
    { row: 'V35', name: 'init progress', argv: () => ['init', 'progress'] },
    { row: 'V36', name: 'smart-entry', argv: () => ['smart-entry'] },
    { row: 'V36b', name: 'progress', argv: () => ['progress'] },
    { row: 'V36c', name: 'stats', argv: () => ['stats'] },
  ];

  for (const { row, name, argv } of SURFACES) {
    test(`${row}: ${name} exits non-zero with reason verification_status_invalid and writes nothing (control: the same fixture with passed exits 0)`, (t) => {
      const control = project(t, 'passed');
      const ok = runGsdTools(['--json-errors', ...argv(control.phaseDir)], control.projectDir);
      // #5170: `phase uat-passed` answers with its verdict, so exit 1 (not passed) is an answer there;
      // every other surface still exits 0 on an in-set report.
      const answered = row === 'V30' ? [0, 1] : [0];
      assert.ok(answered.includes(ok.exitCode), `control: ${name} must answer on an in-set report: ${ok.error}`);

      const bad = project(t, 'verified');
      const before = planningBytes(bad.projectDir);
      const res = runGsdTools(['--json-errors', ...argv(bad.phaseDir)], bad.projectDir);
      assert.notEqual(res.exitCode, 0, `${name} must not answer on an out-of-set report: ${res.output}`);
      assert.equal(res.output, '', `${name}: nothing on stdout — no answer computed over a refused report`);
      const envelope = errorEnvelope5118(res.error);
      assert.ok(envelope, `${name}: expected a --json-errors envelope on stderr, got: ${res.error}`);
      assert.equal(envelope.reason, 'verification_status_invalid');
      assert.deepEqual(planningBytes(bad.projectDir), before, `${name}: no planning file changed`);
    });
  }

  test('B1: phase complete with a bad report in ANOTHER phase fails before its first write — STATE.md and ROADMAP.md byte-identical, no commit, lock released', (t) => {
    const { createTempGitProject } = require('./helpers.cjs');
    const { execFileSync } = require('node:child_process');
    const projectDir = createTempGitProject('gsd-5118-b1-');
    t.after(() => cleanup(projectDir));
    writeSurfaceFixture5118(projectDir, 'passed');
    const otherPhase = path.join(projectDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(otherPhase, { recursive: true });
    fs.writeFileSync(path.join(otherPhase, '02-VERIFICATION.md'), '---\nstatus: verified\n---\n');
    const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
    const git = (...args) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS }).trim();
    git('add', '-A');
    git('commit', '-q', '-m', 'seed');
    const head = git('rev-parse', 'HEAD');
    const before = planningBytes(projectDir);

    const res = runGsdTools(['--json-errors', 'phase', 'complete', '1'], projectDir);
    assert.notEqual(res.exitCode, 0, `phase complete must refuse: ${res.output}`);
    const envelope = errorEnvelope5118(res.error);
    assert.ok(envelope, res.error);
    assert.equal(envelope.reason, 'verification_status_invalid');
    assert.ok(envelope.message.includes('02-VERIFICATION.md'), 'the error names the OTHER phase\'s report');
    assert.deepEqual(planningBytes(projectDir), before, 'no planning file changed');
    assert.equal(git('rev-parse', 'HEAD'), head, 'no commit');
    assert.equal(git('status', '--porcelain'), '', 'the working tree is untouched');
    assert.equal(fs.existsSync(path.join(projectDir, '.planning', '.lock')), false, 'the planning lock is released');

    // CONTROL: the same fixture with the other report in set completes.
    fs.writeFileSync(path.join(otherPhase, '02-VERIFICATION.md'), '---\nstatus: gaps_found\n---\n');
    const ok = runGsdTools(['phase', 'complete', '1'], projectDir);
    assert.equal(ok.exitCode, 0, `control: an in-set sibling report does not block phase 1: ${ok.error}`);
  });

  test('B2: state sync with a bad report in another phase writes nothing (STATE.md byte-identical)', (t) => {
    const control = project(t, 'passed');
    const other = path.join(control.projectDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, '02-VERIFICATION.md'), '---\nstatus: Passed\n---\n');
    const before = planningBytes(control.projectDir);
    const res = runGsdTools(['--json-errors', 'state', 'sync'], control.projectDir);
    assert.notEqual(res.exitCode, 0);
    assert.equal(errorEnvelope5118(res.error)?.reason, 'verification_status_invalid');
    assert.deepEqual(planningBytes(control.projectDir), before);
  });

  test('V29 (message): verification status names the offending value and the accepted set, with nothing on stdout', (t) => {
    const bad = project(t, 'verified');
    const res = runGsdTools(['--json-errors', 'verification', 'status', bad.phaseDir], bad.projectDir);
    assert.notEqual(res.exitCode, 0);
    assert.equal(res.output, '', '--pick callers must see no status, and the non-zero exit');
    const envelope = errorEnvelope5118(res.error);
    assert.ok(envelope, res.error);
    for (const token of ['verified', ...WRITER_5118]) {
      assert.ok(envelope.message.includes(token), `message must name ${token} (#4817): ${envelope.message}`);
    }
  });

  test('V31: phase complete exits with verification_status_invalid, releases the planning lock, and completes once the report is fixed', (t) => {
    const bad = project(t, 'verified');
    const res = runGsdTools(['--json-errors', 'phase', 'complete', '1'], bad.projectDir);
    assert.notEqual(res.exitCode, 0);
    const envelope = errorEnvelope5118(res.error);
    assert.ok(envelope, res.error);
    assert.equal(envelope.reason, 'verification_status_invalid');
    assert.equal(fs.existsSync(path.join(bad.projectDir, '.planning', '.lock')), false, 'the planning lock must be released on throw');

    fs.writeFileSync(bad.reportPath, '---\nstatus: passed\n---\n\n# Verification\n');
    const retry = runGsdTools(['phase', 'complete', '1'], bad.projectDir);
    assert.equal(retry.exitCode, 0, `a corrected report must complete without waiting on a stale lock: ${retry.error}`);
  });

  test('V37: validate health survives the out-of-set report, exits 0, and reports the file as W030', (t) => {
    const bad = project(t, 'verified');
    const res = runGsdTools(['validate', 'health'], bad.projectDir);
    assert.equal(res.exitCode, 0, `health must not crash on the defect it diagnoses: ${res.error}`);
    const report = JSON.parse(res.output);
    const findings = [...(report.errors || []), ...(report.warnings || []), ...(report.info || [])];
    const w030 = findings.filter((f) => f.code === 'W030');
    assert.equal(w030.length, 1, `exactly one W030 finding: ${JSON.stringify(findings)}`);
    assert.ok(JSON.stringify(w030[0]).includes('01-VERIFICATION.md'), 'W030 names the offending report');
  });

  test('V37b: validate consistency survives the out-of-set report, exits 0, and reports W030', (t) => {
    const bad = project(t, 'verified');
    const res = runGsdTools(['validate', 'consistency'], bad.projectDir);
    assert.equal(res.exitCode, 0, `consistency must not crash on the defect it diagnoses: ${res.error}`);
    const report = JSON.parse(res.output);
    assert.ok((report.warnings || []).some((w) => w.code === 'W030' && w.message.includes('01-VERIFICATION.md')),
      `W030 must name the report: ${JSON.stringify(report.warnings)}`);

    const control = project(t, 'passed');
    const clean = JSON.parse(runGsdTools(['validate', 'consistency'], control.projectDir).output);
    assert.equal((clean.warnings || []).some((w) => w.code === 'W030'), false, 'control: no W030 on an in-set report');
  });
});

describe('#5118 round 3: containment before read, no write before the error, and a recovery that works', () => {
  const { runGsdTools } = require('./helpers.cjs');
  const SECRET = 'TOP_SECRET_5118_VALUE';
  const symlinkSkip = process.platform === 'win32' ? 'symlink creation needs elevated privilege on Windows' : false;

  function project(t, status) {
    const projectDir = createTempProject('gsd-5118-r3-');
    t.after(() => cleanup(projectDir));
    return { projectDir, ...writeSurfaceFixture5118(projectDir, status) };
  }

  /** Every file under `dir`, keyed by relative path — the byte-identical-tree comparison. */
  function treeBytes(dir, base = dir, acc = {}) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) treeBytes(full, base, acc);
      else acc[path.relative(base, full)] = fs.readFileSync(full, 'utf-8');
    }
    return acc;
  }

  function outsideDir(t) {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5118-r3-outside-'));
    t.after(() => cleanup(outside));
    return outside;
  }

  // `expectExit0` is true (exit 0), false (any exit) or an array of accepted exits. `phase uat-passed`
  // answers with its verdict (#5170): exit 0 = passed, exit 1 = not passed — both are answers.
  const VERDICT_EXITS = [0, 1];
  function assertNoLeak(argv, cwd, expectExit0 = true) {
    const res = runGsdTools(argv, cwd);
    if (Array.isArray(expectExit0)) assert.ok(expectExit0.includes(res.exitCode), `${argv.join(' ')}: ${res.error}`);
    else if (expectExit0) assert.equal(res.exitCode, 0, `${argv.join(' ')}: ${res.error}`);
    assert.equal((`${res.output}${res.error}`).includes(SECRET), false, `${argv.join(' ')}: content of an escaped report reached the output`);
    return res;
  }

  // S1 (security): the two readers that used to read `*-VERIFICATION.md` with a
  // plain readFileSync and echo its status into a thrown message.
  for (const [label, linkTarget] of [
    ['an absolute symlink', (p1, secretFile) => secretFile],
    ['a relative ../ symlink', (p1, secretFile) => path.relative(p1, secretFile)],
  ]) {
    test(`S1: ${label} to a report outside the project reads missing through init verify-work, phase uat-passed, audit-uat and verification status — nothing leaks`, { skip: symlinkSkip }, (t) => {
      const { projectDir, phaseDir, reportPath } = project(t, 'passed');
      const secretFile = path.join(outsideDir(t), 'secret.md');
      fs.writeFileSync(secretFile, `---\nstatus: ${SECRET}\n---\n`);
      fs.unlinkSync(reportPath);
      fs.symlinkSync(linkTarget(phaseDir, secretFile), reportPath);

      assertNoLeak(['init', 'verify-work', '1'], projectDir);
      assertNoLeak(['phase', 'uat-passed', '1', '--require-verification'], projectDir, VERDICT_EXITS);
      assertNoLeak(['audit-uat'], projectDir);
      const status = assertNoLeak(['verification', 'status', phaseDir], projectDir);
      assert.equal(JSON.parse(status.output).status, 'missing', 'the escaped file reads missing');
    });
  }

  test('S1 CONTROL: the same status spelled in a regular file inside the phase dir IS read and refused', (t) => {
    const bad = project(t, SECRET);
    const res = runGsdTools(['init', 'verify-work', '1'], bad.projectDir);
    assert.notEqual(res.exitCode, 0, 'the in-project report is read (and judged out of set)');
    const audit = runGsdTools(['verification', 'status', bad.phaseDir], bad.projectDir);
    assert.notEqual(audit.exitCode, 0);
  });

  // S2 (security): a phase directory that is itself a symlink out of the
  // project — its realpath and the report's realpath both resolve outside, so
  // containing against the phase dir's own realpath admitted the escape.
  test('S2: a symlinked phase directory outside the project reads missing through verification status, smart-entry and the aggregates — nothing leaks', { skip: symlinkSkip }, (t) => {
    const { projectDir, phaseDir } = project(t, 'passed');
    const outside = outsideDir(t);
    fs.writeFileSync(path.join(outside, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(outside, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(outside, '01-VERIFICATION.md'), `---\nstatus: ${SECRET}\n---\n`);
    cleanup(phaseDir);
    fs.symlinkSync(outside, phaseDir, 'dir');

    const status = assertNoLeak(['verification', 'status', phaseDir], projectDir);
    assert.equal(JSON.parse(status.output).status, 'missing');
    assertNoLeak(['smart-entry'], projectDir);
    assertNoLeak(['init', 'verify-work', '1'], projectDir);
    assertNoLeak(['audit-uat'], projectDir);
    assertNoLeak(['audit-open'], projectDir);
    assertNoLeak(['planning', 'inspect'], projectDir);
    assertNoLeak(['state', 'sync'], projectDir);
  });

  // D3: no write before the error — every command that writes something
  // BEFORE the STATE.md rewrite whose frontmatter rebuild throws.
  function threePhaseProject(t, thirdStatus) {
    const { projectDir } = project(t, 'passed');
    const planning = path.join(projectDir, '.planning');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), [
      '# Roadmap', '',
      '- [ ] Phase 1: Foundation', '- [ ] Phase 2: API', '- [ ] Phase 3: Extra', '',
      '### Phase 1: Foundation', '**Goal:** Setup', '**Plans:** 1 plans', '',
      '### Phase 2: API', '**Goal:** Build API', '',
      '### Phase 3: Extra', '**Goal:** More', '',
      '## Progress', '',
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|----------------|--------|-----------|',
      '| 01. Foundation | 0/1 | Not started | - |',
      '| 02. API | 0/1 | Not started | - |',
      '| 03. Extra | 0/1 | Not started | - |', '',
    ].join('\n'));
    fs.mkdirSync(path.join(planning, 'phases', '02-api'), { recursive: true });
    const third = path.join(planning, 'phases', '03-extra');
    fs.mkdirSync(third, { recursive: true });
    fs.writeFileSync(path.join(third, '03-VERIFICATION.md'), `---\nstatus: ${thirdStatus}\n---\n`);
    return projectDir;
  }

  test('D3: phase remove with a bad report in a SURVIVING phase fails before the first write — directories, STATE.md and ROADMAP.md untouched', (t) => {
    const bad = threePhaseProject(t, 'verified');
    const before = treeBytes(path.join(bad, '.planning'));
    const dirsBefore = fs.readdirSync(path.join(bad, '.planning', 'phases')).sort();
    const res = runGsdTools(['--json-errors', 'phase', 'remove', '2'], bad);
    assert.notEqual(res.exitCode, 0, `phase remove must refuse: ${res.output}`);
    assert.equal(errorEnvelope5118(res.error)?.reason, 'verification_status_invalid');
    assert.deepEqual(treeBytes(path.join(bad, '.planning')), before, 'the tree is byte-identical');
    assert.deepEqual(fs.readdirSync(path.join(bad, '.planning', 'phases')).sort(), dirsBefore, 'the target phase directory is still present and nothing was renumbered');

    const control = threePhaseProject(t, 'passed');
    const ok = runGsdTools(['phase', 'remove', '2'], control);
    assert.equal(ok.exitCode, 0, `control: an in-set report lets the removal proceed: ${ok.error}`);
    assert.deepEqual(fs.readdirSync(path.join(control, '.planning', 'phases')).sort(), ['01-foundation', '02-extra']);
  });

  test('D3: phase remove of the phase that CARRIES the bad report is not blocked by it (its report is never read afterwards)', (t) => {
    const bad = threePhaseProject(t, 'verified');
    const res = runGsdTools(['phase', 'remove', '3'], bad);
    assert.equal(res.exitCode, 0, `removing the offending phase is the fix, not a refusal: ${res.error}`);
    assert.equal(fs.existsSync(path.join(bad, '.planning', 'phases', '03-extra')), false);
  });

  function quickProject(t, status) {
    const { projectDir } = project(t, status);
    const planning = path.join(projectDir, '.planning');
    fs.writeFileSync(path.join(planning, 'STATE.md'), [
      '---', 'milestone: v1.0', '---', '# State', '',
      '**Current Phase:** 01', '**Status:** In progress', '**Total Phases:** 1', '',
      '## Quick Tasks Completed', '', '| # | Description |', '|---|---|', '| 1 | thing |', '',
    ].join('\n'));
    fs.mkdirSync(path.join(planning, 'quick', '260101-abc-thing'), { recursive: true });
    fs.writeFileSync(path.join(planning, 'quick', '260101-abc-thing', '260101-abc-PLAN.md'), '# q\n');
    return projectDir;
  }

  test('D3: milestone archive-quick with a bad report fails before moving any quick task directory', (t) => {
    const bad = quickProject(t, 'verified');
    const before = treeBytes(path.join(bad, '.planning'));
    const res = runGsdTools(['--json-errors', 'milestone', 'archive-quick', 'v1.0'], bad);
    assert.notEqual(res.exitCode, 0, res.output);
    assert.equal(errorEnvelope5118(res.error)?.reason, 'verification_status_invalid');
    assert.deepEqual(treeBytes(path.join(bad, '.planning')), before, 'the quick task directory was not moved');

    const ok = runGsdTools(['milestone', 'archive-quick', 'v1.0'], quickProject(t, 'passed'));
    assert.equal(ok.exitCode, 0, `control: ${ok.error}`);
  });

  test('D3: milestone complete with a bad report fails before its first write — no archive directory, tree byte-identical', (t) => {
    const bad = quickProject(t, 'verified');
    fs.writeFileSync(path.join(bad, '.planning', 'ROADMAP.md'), [
      '# Roadmap', '', '## v1.0 Milestone', '', '- [ ] Phase 1: Foundation', '',
      '### Phase 1: Foundation', '**Goal:** Setup', '**Plans:** 1 plans', '',
      '## Progress', '', '| Phase | Plans Complete | Status | Completed |', '|---|---|---|---|',
      '| 01. Foundation | 1/1 | Complete | 2025-01-01 |', '',
    ].join('\n'));
    const before = treeBytes(path.join(bad, '.planning'));
    const res = runGsdTools(['--json-errors', 'milestone', 'complete', 'v1.0', '--name', 'M', '--confirm'], bad);
    assert.notEqual(res.exitCode, 0, res.output);
    assert.equal(errorEnvelope5118(res.error)?.reason, 'verification_status_invalid');
    assert.deepEqual(treeBytes(path.join(bad, '.planning')), before, 'nothing archived, nothing rewritten');
    assert.equal(fs.existsSync(path.join(bad, '.planning', 'milestones')), false);
  });

  test('D3: validate health --repair REGENERATE_STATE validates before its backup copy — a failed repair, no .bak file, STATE.md untouched', (t) => {
    const bad = project(t, 'verified');
    const healthDiagnostic = require('../gsd-core/bin/lib/health-diagnostic.cjs');
    const { REMEDY_ACTION, REMEDY_RISK } = healthDiagnostic;
    const before = treeBytes(path.join(bad.projectDir, '.planning'));
    // regenerateState is DESTRUCTIVE (the dispatcher refuses it), so the handler
    // is driven through a fabricated RISK.NONE diagnostic — the only way to reach it.
    const diagnostics = [{
      code: 'X001', severity: 'error', message: 'fabricated',
      remedy: { action: REMEDY_ACTION.REGENERATE_STATE, risk: REMEDY_RISK.NONE, args: {} },
    }];
    const out = healthDiagnostic.applyRepairs(bad.projectDir, diagnostics, true, false);
    assert.equal(out.details.length, 1);
    assert.equal(out.details[0].success, false);
    assert.match(out.details[0].error, /outside the closed set/);
    assert.deepEqual(out.applied, []);
    assert.deepEqual(treeBytes(path.join(bad.projectDir, '.planning')), before, 'no STATE backup was written, no file changed');
  });

  test('D3: phase complete pre-validates exactly the set its own STATE rewrite reads — a phase the rewrite never scans (not in the ROADMAP) does not block it', (t) => {
    const { projectDir } = project(t, 'passed');
    const orphan = path.join(projectDir, '.planning', 'phases', '05-old');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, '05-VERIFICATION.md'), '---\nstatus: verified\n---\n');
    const res = runGsdTools(['phase', 'complete', '1'], projectDir);
    assert.equal(res.exitCode, 0, `an unscanned phase must not refuse phase complete: ${res.error}`);
  });

  // F2 (round 4): `phase remove` validates the set its STATE rebuild scans
  // (milestone-scoped, one directory per phase key), not every subdirectory.
  test('D3 (F2): phase remove validates the set the STATE rebuild scans — a same-number sibling the rebuild dedupes away does not block it, a scanned one does', (t) => {
    // `01-zz-shadow` shares phase number 01 with `01-foundation`; the rebuild
    // keeps one directory per phase key (the lexicographically first), so the
    // shadow is never scanned and its report is never read afterwards.
    const unscanned = threePhaseProject(t, 'passed');
    const zz = path.join(unscanned, '.planning', 'phases', '01-zz-shadow');
    fs.mkdirSync(zz, { recursive: true });
    fs.writeFileSync(path.join(zz, '01-VERIFICATION.md'), '---\nstatus: verified\n---\n');
    const ok = runGsdTools(['phase', 'remove', '2'], unscanned);
    assert.equal(ok.exitCode, 0, `a survivor the rebuild never scans must not block the removal: ${ok.error}`);
    assert.equal(fs.existsSync(path.join(unscanned, '.planning', 'phases', '02-api')), false, 'the target was removed');

    // CONTROL: the same shadow sorted FIRST becomes the scanned survivor for
    // phase key 01 — its bad report is read by the rebuild, so the remove refuses.
    const scanned = threePhaseProject(t, 'passed');
    const aa = path.join(scanned, '.planning', 'phases', '01-aa-shadow');
    fs.mkdirSync(aa, { recursive: true });
    fs.writeFileSync(path.join(aa, '01-VERIFICATION.md'), '---\nstatus: verified\n---\n');
    const before = treeBytes(path.join(scanned, '.planning'));
    const res = runGsdTools(['--json-errors', 'phase', 'remove', '2'], scanned);
    assert.notEqual(res.exitCode, 0, `a scanned survivor's bad report still refuses: ${res.output}`);
    assert.equal(errorEnvelope5118(res.error)?.reason, 'verification_status_invalid');
    assert.deepEqual(treeBytes(path.join(scanned, '.planning')), before, 'nothing was written');
  });

  // F3 (round 4): one `--repair` run validates before ITS first write, not
  // only before the REGENERATE_STATE handler's own backup copy.
  test('D3 (F3): validate health --repair validates before the run\'s first write — a config repair ordered before REGENERATE_STATE does not write when a report is refused', (t) => {
    const bad = project(t, 'verified');
    const healthDiagnostic = require('../gsd-core/bin/lib/health-diagnostic.cjs');
    const { REMEDY_ACTION, REMEDY_RISK } = healthDiagnostic;
    cleanup(path.join(bad.projectDir, '.planning', 'config.json'));
    const before = treeBytes(path.join(bad.projectDir, '.planning'));
    const remedy = (action) => ({ action, risk: REMEDY_RISK.NONE, args: {} });
    const diagnostics = [
      { code: 'E005', severity: 'error', message: 'fabricated', remedy: remedy(REMEDY_ACTION.CREATE_CONFIG) },
      { code: 'X001', severity: 'error', message: 'fabricated', remedy: remedy(REMEDY_ACTION.REGENERATE_STATE) },
    ];
    const out = healthDiagnostic.applyRepairs(bad.projectDir, diagnostics, true, false);
    assert.deepEqual(out.applied, [], 'no repair in the run was applied');
    assert.equal(out.details.length, 2);
    assert.ok(out.details.every((d) => d.success === false), JSON.stringify(out.details));
    assert.match(out.details[0].error, /the run stopped before its first write/);
    assert.match(out.details[1].error, /outside the closed set/);
    assert.deepEqual(treeBytes(path.join(bad.projectDir, '.planning')), before, 'config.json was not written; the tree is byte-identical');

    // CONTROL: the same first diagnostic alone, over an in-set report, does write.
    const good = project(t, 'passed');
    cleanup(path.join(good.projectDir, '.planning', 'config.json'));
    const ran = healthDiagnostic.applyRepairs(good.projectDir, diagnostics.slice(0, 1), true, false);
    assert.deepEqual(ran.applied, ['E005']);
    assert.equal(fs.existsSync(path.join(good.projectDir, '.planning', 'config.json')), true);
  });

  // SEC-1 (round 4): a symlinked UAT file is contained before its read, like a
  // VERIFICATION report — its `### N. <name>` / `expected:` text never leaks.
  const uatSecret = () => ['---', 'status: testing', '---', '', '## Tests', '', `### 1. ${SECRET}`, `expected: ${SECRET}`, 'result: [pending]', ''].join('\n');
  for (const [label, uatName, linkTarget] of [
    ['an absolute symlink', '01-UAT.md', (p1, secretFile) => secretFile],
    ['a relative ../ symlink', '01-UAT.md', (p1, secretFile) => path.relative(p1, secretFile)],
    ['an absolute symlink', '01-HUMAN-UAT.md', (p1, secretFile) => secretFile],
  ]) {
    test(`SEC-1: ${uatName} as ${label} to a file outside the project reads absent through audit-uat, phase uat-passed, init verify-work and audit-open — nothing leaks`, { skip: symlinkSkip }, (t) => {
      const { projectDir, phaseDir } = project(t, 'passed');
      const secretFile = path.join(outsideDir(t), 'secret-uat.md');
      fs.writeFileSync(secretFile, uatSecret());
      cleanup(path.join(phaseDir, uatName));
      fs.symlinkSync(linkTarget(phaseDir, secretFile), path.join(phaseDir, uatName));

      assertNoLeak(['audit-uat'], projectDir);
      assertNoLeak(['phase', 'uat-passed', '1'], projectDir, VERDICT_EXITS);
      assertNoLeak(['phase', 'uat-passed', '1', '--require-verification'], projectDir, VERDICT_EXITS);
      assertNoLeak(['init', 'verify-work', '1'], projectDir);
      assertNoLeak(['audit-open'], projectDir);
    });
  }

  test('SEC-1 CONTROL: the same UAT text in a regular file inside the phase dir IS read (the leak the guard closes is real)', (t) => {
    const { projectDir, phaseDir } = project(t, 'passed');
    fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), uatSecret());
    const res = runGsdTools(['audit-uat'], projectDir);
    assert.equal(res.exitCode, 0, res.error);
    assert.ok(`${res.output}${res.error}`.includes(SECRET), 'an in-project UAT file surfaces its test name');
  });

  // SEC-2 (round 4): the 120-character cut of the rendered raw status never
  // lands inside a `\uXXXX` escape or between the halves of a surrogate pair.
  test('SEC-2: the truncated raw-status token is cut on a boundary — no partial escape, no lone surrogate, and the count is exact', () => {
    const { VerificationStatusError } = owner5118();
    const { formatDiagnosticToken } = require('../gsd-core/bin/lib/io.cjs');
    const tokenOf = (raw) => {
      const message = new VerificationStatusError(raw, '/p/01-VERIFICATION.md').message;
      const start = message.indexOf('has status ') + 'has status '.length;
      return message.slice(start, message.indexOf(', which is outside the closed set'));
    };
    let truncated = 0;
    // Sweep the unit across the cut position (limit-1, limit, limit+1 and around).
    for (let pad = 100; pad <= 125; pad += 1) {
      for (const unit of ['\u0001', '\u{1F600}', '​']) {
        const raw = `${'a'.repeat(pad)}${unit}${'b'.repeat(40)}`;
        const token = tokenOf(raw);
        const at = token.indexOf('…(');
        if (at === -1) continue;
        truncated += 1;
        const kept = token.slice(0, at);
        const more = Number(/^…\((\d+) more\)$/.exec(token.slice(at))?.[1]);
        const rendered = formatDiagnosticToken(raw);
        assert.ok(rendered.startsWith(kept), 'the kept part is a prefix of the rendered token');
        assert.equal(kept.length + more, rendered.length, `the (N more) count is exact for pad=${pad}`);
        assert.doesNotMatch(kept, /\\u[0-9a-fA-F]{0,3}$/, `pad=${pad}: the cut split a \\uXXXX escape`);
        assert.doesNotMatch(kept, /[\ud800-\udbff]$/, `pad=${pad}: the cut split a surrogate pair`);
      }
    }
    assert.ok(truncated >= 40, `non-vacuous: the sweep truncated ${truncated} tokens`);
  });

  // SEC-2b (round 5): JSON escapes of two characters (`\n`, `\\`, `\"`) are
  // atomic too — a cut may not leave the kept token ending in a lone
  // backslash (an odd trailing run), which would escape the ellipsis.
  describe('SEC-2b: the truncated raw-status token never ends in an odd backslash run', () => {
    const formatDiagnosticToken = (raw) => require('../gsd-core/bin/lib/io.cjs').formatDiagnosticToken(raw);
    const tokenOf = (raw) => {
      const { VerificationStatusError } = owner5118();
      const message = new VerificationStatusError(raw, '/p/01-VERIFICATION.md').message;
      const start = message.indexOf('has status ') + 'has status '.length;
      return message.slice(start, message.indexOf(', which is outside the closed set'));
    };
    const split =(token) => {
      const at = token.indexOf('…(');
      if (at === -1) return null;
      return { kept: token.slice(0, at), more: Number(/^…\((\d+) more\)$/.exec(token.slice(at))?.[1]) };
    };
    const oddTrailingBackslashes = /(?:^|[^\\])(?:\\\\)*\\$/;

    test('a cut right after the backslash of a `\\n` escape drops the backslash', () => {
      const raw = `${'a'.repeat(118)}\nzzzz`;
      const rendered = formatDiagnosticToken(raw);
      assert.equal(rendered.slice(119, 121), '\\n', 'fixture: the escape straddles the cut');
      const { kept, more } = split(tokenOf(raw));
      assert.equal(kept.length, 119, 'the trailing backslash was dropped');
      assert.doesNotMatch(kept, oddTrailingBackslashes);
      assert.equal(more, rendered.length - 119, 'N counts the dropped backslash');
    });

    test('a cut between the two backslashes of `\\\\` drops one; a cut after both keeps both', () => {
      const between = `${'a'.repeat(118)}\\zzzz`;
      const renderedBetween = formatDiagnosticToken(between);
      assert.equal(renderedBetween.slice(119, 121), '\\\\', 'fixture: the cut falls between the pair');
      const cutBetween = split(tokenOf(between));
      assert.equal(cutBetween.kept.length, 119);
      assert.doesNotMatch(cutBetween.kept, oddTrailingBackslashes);
      assert.equal(cutBetween.more, renderedBetween.length - 119);

      const after = `${'a'.repeat(117)}\\zzzz`;
      const renderedAfter = formatDiagnosticToken(after);
      assert.equal(renderedAfter.slice(118, 120), '\\\\', 'fixture: the cut falls after both');
      const cutAfter = split(tokenOf(after));
      assert.equal(cutAfter.kept.length, 120, 'an even run is kept whole');
      assert.doesNotMatch(cutAfter.kept, oddTrailingBackslashes);
      assert.equal(cutAfter.more, renderedAfter.length - 120);
    });

    test('a cut inside `\\"` drops the backslash', () => {
      const raw = `${'a'.repeat(118)}"zzzz`;
      const rendered = formatDiagnosticToken(raw);
      assert.equal(rendered.slice(119, 121), '\\"', 'fixture: the escape straddles the cut');
      const { kept, more } = split(tokenOf(raw));
      assert.equal(kept.length, 119);
      assert.doesNotMatch(kept, oddTrailingBackslashes);
      assert.equal(more, rendered.length - 119);
    });

    test('sweep: every escape shape across limit-1, limit and limit+1 — no odd trailing run, exact count', () => {
      let truncated = 0;
      for (let pad = 110; pad <= 125; pad += 1) {
        for (const unit of ['\n', '\t', '\r', '\b', '\f', '\\', '"', '\\\\\\', '\\"\\']) {
          const raw = `${'a'.repeat(pad)}${unit}${'b'.repeat(40)}`;
          const cut = split(tokenOf(raw));
          if (cut === null) continue;
          truncated += 1;
          const rendered = formatDiagnosticToken(raw);
          assert.ok(rendered.startsWith(cut.kept), 'the kept part is a prefix of the rendered token');
          assert.equal(cut.kept.length + cut.more, rendered.length, `count is exact (pad=${pad}, unit=${JSON.stringify(unit)})`);
          assert.doesNotMatch(cut.kept, oddTrailingBackslashes, `pad=${pad}, unit=${JSON.stringify(unit)}: lone trailing backslash`);
        }
      }
      assert.ok(truncated >= 100, `non-vacuous: the sweep truncated ${truncated} tokens`);
    });

    test('boundary: a rendered token of limit-1 and limit characters is whole; limit+1 is cut with an exact count', () => {
      // A plain run renders as the run plus two quotes.
      for (const length of [119, 120]) {
        const token = tokenOf('a'.repeat(length - 2));
        assert.equal(token.length, length);
        assert.equal(split(token), null, `length ${length} is not truncated`);
      }
      const token = tokenOf('a'.repeat(119));
      const cut = split(token);
      assert.equal(cut.kept.length, 120);
      assert.equal(cut.more, 1);
    });
  });

  // D4: the recovery the error text names must be real.
  test('D4: the out-of-set error names the file, the value, the accepted values and a recovery that works — set `status:` or delete the report', (t) => {
    const bad = project(t, 'verified');
    const res = runGsdTools(['--json-errors', 'verification', 'status', bad.phaseDir], bad.projectDir);
    assert.notEqual(res.exitCode, 0);
    const { message } = errorEnvelope5118(res.error);
    assert.ok(message.includes('01-VERIFICATION.md'), 'names the file');
    assert.ok(message.includes('"verified"'), 'names the value');
    for (const accepted of WRITER_5118) assert.ok(message.includes(accepted), `names ${accepted}`);
    assert.match(message, /set the report's frontmatter `status:` to one of/);
    assert.match(message, /delete the report and re-run the phase's verification/);
    assert.doesNotMatch(message, /regenerates it/, 'the old text promised a verifier run the failing commands never reach');

    // The named recovery, performed: deleting the report reaches the
    // regenerating path — `missing`, routed to execute-phase — and the bundles
    // that failed on the bad report answer again.
    fs.unlinkSync(bad.reportPath);
    const after = runGsdTools(['verification', 'status', bad.phaseDir], bad.projectDir);
    assert.equal(after.exitCode, 0, after.error);
    const result = JSON.parse(after.output);
    assert.equal(result.status, 'missing');
    assert.equal(result.route, 'execute-phase');
    for (const argv of [['init', 'execute-phase', '1'], ['init', 'verify-work', '1'], ['init', 'progress']]) {
      const init = runGsdTools(argv, bad.projectDir);
      assert.equal(init.exitCode, 0, `${argv.join(' ')} must answer once the report is deleted: ${init.error}`);
    }
  });
});

describe('#5118 G: workflows surface verification-status errors instead of reading them as "no result"', () => {
  const { readWorkflowCombined } = require('./helpers.cjs');
  const WORKFLOWS = path.join(__dirname, '..', 'gsd-core', 'workflows');

  function bashFenceLines(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (const block of scanFencedBlocks(lines)) {
      if (block.closeLineIdx === -1) continue;
      if (!['bash', 'sh'].includes((block.infoString || '').trim())) continue;
      for (let i = block.openLineIdx + 1; i < block.closeLineIdx; i += 1) out.push(lines[i]);
    }
    return out;
  }

  const STATUS_READ_RE = /gsd_run\s+(?:query\s+)?(?:verification[. ]status|phase\s+uat-passed)\b/;

  test('V48: every verification.status / uat-passed read keeps stderr and never coerces a failure to "no result" (§R3)', () => {
    for (const rel of [
      'verify-work.md',
      'autonomous.md',
      'progress.md',
      'ship.md',
      path.join('quick', 'steps', 'quick-verification.md'),
      path.join('quick-batch', 'steps', 'verification-wave.md'),
      'execute-phase.md',
    ]) {
      const reads = bashFenceLines(readWorkflowCombined(path.join(WORKFLOWS, rel))).filter((line) => STATUS_READ_RE.test(line));
      assert.ok(reads.length > 0, `${rel}: expected at least one status read in a bash fence (non-vacuous)`);
      for (const line of reads) {
        assert.doesNotMatch(line, /2>\s*\/dev\/null/, `${rel}: stderr discarded: ${line.trim()}`);
        assert.doesNotMatch(line, /\|\|\s*true\b/, `${rel}: failure coerced to success: ${line.trim()}`);
      }
    }
  });

  test('V49: progress.md reads the resolved phase directory, not a hard-coded .planning/phases literal (§R4)', () => {
    const lines = bashFenceLines(readWorkflowCombined(path.join(WORKFLOWS, 'progress.md')));
    const literal = lines.filter((line) => /^\s*PHASE_DIR=["']?\.planning\/phases\//.test(line));
    assert.deepEqual(literal, [], 'workstream projects do not live under .planning/phases');
  });

  test('V50: gsd-verifier runs the write-time self-check — verification.status on its own report, stderr kept (§2.3b, §R6)', () => {
    const agent = fs.readFileSync(path.join(__dirname, '..', 'agents', 'gsd-verifier.md'), 'utf-8');
    const checks = bashFenceLines(agent).filter((line) => /gsd_run\s+query\s+verification\.status\b/.test(line));
    assert.ok(checks.length > 0, 'the verifier <output> must run verification.status after writing the report');
    for (const line of checks) {
      assert.doesNotMatch(line, /2>\s*\/dev\/null/, `the self-check must surface the hard error: ${line.trim()}`);
    }
  });

  // Review E: a flag set by `|| VERIFY_ERROR=1` inside a per-phase / per-item
  // loop must be reset in the SAME fence before the read, or one phase's
  // refusal leaks into every later iteration's routing.
  test('V48b: every `|| VERIFY_ERROR=1` read is preceded in its own fence by a `VERIFY_ERROR=""` reset (review E)', () => {
    let seen = 0;
    for (const rel of ['autonomous.md', path.join('quick-batch', 'steps', 'verification-wave.md')]) {
      const lines = fs.readFileSync(path.join(WORKFLOWS, rel), 'utf-8').split(/\r?\n/);
      for (const block of scanFencedBlocks(lines)) {
        if (block.closeLineIdx === -1) continue;
        const body = lines.slice(block.openLineIdx + 1, block.closeLineIdx);
        body.forEach((line, i) => {
          if (!/\|\|\s*VERIFY_ERROR=1\b/.test(line)) return;
          seen += 1;
          const resetBefore = body.slice(0, i).some((l) => /^\s*VERIFY_ERROR=""/.test(l));
          assert.ok(resetBefore, `${rel}: the flag is not reset before this read: ${line.trim()}`);
        });
      }
    }
    assert.ok(seen >= 3, `non-vacuous: expected the two autonomous reads and the wave read, saw ${seen}`);
  });

  // Review H: the CLI error already names the report (sanitized); a workflow
  // echo must not re-print the raw, unsanitized phase path.
  test('V48c: execute-phase status-read failure echoes do not interpolate PHASE_DIR (review H)', () => {
    const lines = bashFenceLines(fs.readFileSync(path.join(WORKFLOWS, 'execute-phase.md'), 'utf-8'))
      .filter((line) => /gsd_run\s+query\s+verification[. ]status\b/.test(line) && /\|\|\s*\{\s*echo\b/.test(line));
    assert.ok(lines.length >= 2, 'non-vacuous: the resume ladder reads status and route');
    for (const line of lines) {
      const echoPart = line.slice(line.indexOf('|| {'));
      assert.doesNotMatch(echoPart, /\$\{?PHASE_DIR\}?/, `echo re-prints the raw path: ${line.trim()}`);
    }
  });
});
