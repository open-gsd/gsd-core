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

      const result = readVerificationStatus(dir);
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

      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'stale');
      assert.equal(result.next_command, '/gsd:verify-work 01');
    } finally {
      cleanup(baseDir);
    }
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
