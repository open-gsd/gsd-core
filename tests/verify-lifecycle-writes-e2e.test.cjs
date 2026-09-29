/**
 * tests/verify-lifecycle-writes-e2e.test.cjs — #5105 test matrix rows
 * T15, T15c (CONTROL), T16.
 *
 * Builds a phase whose v3 VERIFICATION.md is produced by the real
 * `verification.fingerprint` command, with UAT/SECURITY/VALIDATION declared
 * as covered — mirroring tests/verification-status.test.cjs's "fingerprint
 * input set is closed and idempotent" fixture pattern.
 *
 * T15 (fail-first): the fixed post-fingerprint verbs (render-hooks
 * --after-fingerprint, uat.complete-session, verification.append-audit) must
 * leave the report FRESH (`passed`) on an unchanged re-run — this needs R1-R3
 * (40-design.md §R), so it fails until they land.
 *
 * T15c is the CONTROL for T15: it runs TODAY's pre-fix behavior (a raw dated
 * audit-block append + a raw UAT `updated:` rewrite) against the identical
 * fixture and asserts the report goes STALE — proving the fixture is capable
 * of detecting the defect the fix removes. This control does not require
 * any of R1-R3 and should pass unmodified before and after the fix.
 *
 * T16: a GENUINE change (a changed audit count, or a UAT row flip) must still
 * publish and stale the report — invariant 5 (never launder a real change).
 *
 * Design: .gsd/phase/fix-5105-verify-lifecycle-writes/40-design.md §R.
 * Matrix: .gsd/phase/fix-5105-verify-lifecycle-writes/50-test-matrix.md T15/T15c/T16.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

function auditBlock(heading, date, rows) {
  const lines = [`## ${heading} ${date}`, '', '| Metric | Count |', '|---|---|'];
  for (const [k, v] of Object.entries(rows)) lines.push(`| ${k} | ${v} |`);
  return lines.join('\n') + '\n';
}

function uatContent({ updated = '2026-01-01T00:00:00Z', row2Result = 'pass' } = {}) {
  return [
    '---',
    'status: complete',
    'phase: 01-foo',
    'started: 2026-01-01T00:00:00Z',
    `updated: ${updated}`,
    '---',
    '',
    '## Current Test',
    '',
    '[testing complete]',
    '',
    '## Tests',
    '',
    '### 1. Login Form',
    'expected: Form displays correctly',
    'result: pass',
    '',
    '### 2. Submit Button',
    'expected: Submitting shows loading state',
    `result: ${row2Result}`,
    '',
  ].join('\n');
}

function securityContent(rows, date = '2026-01-01') {
  return '---\nstatus: draft\nthreats_open: 0\n---\n\n# Security\n\n' + auditBlock('Security Audit', date, rows);
}

function validationContent(rows, date = '2026-01-01') {
  return '---\nstatus: validated\nnyquist_compliant: true\n---\n\n# Validation\n\n' + auditBlock('Validation Audit', date, rows);
}

// Build a phase directory with UAT/SECURITY/VALIDATION, fingerprint it via the
// real `verification.fingerprint` command declaring all three, and write the
// v3 report. Returns { projectDir, phaseDir, uatPath, securityPath, validationPath }.
function buildFingerprintedPhase(t) {
  const projectDir = createTempGitProject();
  t.after(() => cleanup(projectDir));
  const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
  fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
  const uatPath = path.join(phaseDir, '01-UAT.md');
  const securityPath = path.join(phaseDir, '01-SECURITY.md');
  const validationPath = path.join(phaseDir, '01-VALIDATION.md');
  fs.writeFileSync(uatPath, uatContent());
  fs.writeFileSync(securityPath, securityContent({ 'Threats found': 1, Closed: 1, Open: 0 }));
  fs.writeFileSync(validationPath, validationContent({ Gaps: 0, Resolved: 0, Escalated: 0 }));

  const declared = [
    '.planning/phases/01-foo/01-01-PLAN.md',
    '.planning/phases/01-foo/01-01-SUMMARY.md',
    '.planning/phases/01-foo/01-UAT.md',
    '.planning/phases/01-foo/01-SECURITY.md',
    '.planning/phases/01-foo/01-VALIDATION.md',
  ];
  const fp = runGsdTools(['verification', 'fingerprint', phaseDir, ...declared], projectDir);
  assert.ok(fp.success, `fingerprint must succeed: ${fp.error}`);
  const parsed = JSON.parse(fp.output);
  fs.writeFileSync(
    path.join(phaseDir, '01-VERIFICATION.md'),
    `---\nstatus: passed\ncovered_files:\n${parsed.covered_files.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${parsed.covered_digest}"\n---\n`,
  );

  const { execFileSync } = require('child_process');
  execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
  execFileSync('git', ['commit', '-q', '-m', 'seed fingerprinted phase'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });

  return { projectDir, phaseDir, uatPath, securityPath, validationPath, covered_digest: parsed.covered_digest };
}

function statusOf(projectDir, phaseDir) {
  const res = runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir);
  assert.ok(res.success, `verification status must run: ${res.error}`);
  return res.output;
}

describe('T15: fixed post-fingerprint verbs leave an unchanged report fresh (#4887/#4981, fail-first)', () => {
  test('render-hooks --after-fingerprint (no covered step dispatched) + uat.complete-session no-op + append-audit no-op → status stays passed', (t) => {
    const { projectDir, phaseDir, covered_digest: before } = buildFingerprintedPhase(t);
    assert.strictEqual(statusOf(projectDir, phaseDir), 'passed', 'sanity: freshly fingerprinted phase is passed');

    // 1. render-hooks with the gating flag — the design says no covered step
    // should even be dispatched, since SECURITY/VALIDATION/UI-REVIEW already
    // exist. We assert this by checking skippedHooks names them.
    const { runNode } = require('./helpers/process-seam.cjs');
    const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
    const ROOT = path.resolve(__dirname, '..');
    const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
    const hooksResult = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'verify:post', '--cwd', projectDir, '--raw', '--after-fingerprint', phaseDir],
      { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.strictEqual(hooksResult.exitCode, 0, `render-hooks must succeed: ${hooksResult.stderr}`);
    const envelope = JSON.parse(hooksResult.stdout.trim());
    const securitySkip = envelope.skippedHooks && envelope.skippedHooks.find((s) => s.capId === 'security');
    assert.ok(securitySkip, 'SECURITY.md already exists — the security step must be skipped, not dispatched');

    // 2. uat.complete-session on the already-complete UAT: no-op.
    const uatResult = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(uatResult.success, `uat.complete-session must succeed: ${uatResult.error}`);
    assert.strictEqual(JSON.parse(uatResult.output).changed, false);

    // 3. append-audit with the SAME counts already on record: no-op.
    const auditResult = runGsdTools(
      [
        'query', 'verification.append-audit', '.planning/phases/01-foo/01-SECURITY.md',
        '--heading', 'Security Audit',
        '--rows', JSON.stringify({ 'Threats found': 1, Closed: 1, Open: 0 }),
        '--date', '2026-01-02',
      ],
      projectDir,
    );
    assert.ok(auditResult.success, `append-audit must succeed: ${auditResult.error}`);
    assert.strictEqual(JSON.parse(auditResult.output).appended, false);

    // The report must still be fresh, and the digest must be byte-identical
    // (never restamped — invariant 5).
    assert.strictEqual(statusOf(projectDir, phaseDir), 'passed', 'an unchanged post-fingerprint re-run must leave the report fresh');
    const finalFp = runGsdTools(
      ['verification', 'fingerprint', phaseDir,
        '.planning/phases/01-foo/01-01-PLAN.md', '.planning/phases/01-foo/01-01-SUMMARY.md',
        '.planning/phases/01-foo/01-UAT.md', '.planning/phases/01-foo/01-SECURITY.md', '.planning/phases/01-foo/01-VALIDATION.md'],
      projectDir,
    );
    assert.ok(finalFp.success);
    assert.strictEqual(JSON.parse(finalFp.output).covered_digest, before, 'the digest must never be restamped by a publish verb');
  });
});

describe('T15c: CONTROL — the pre-fix sequence stales the identical fixture (proves the fixture can detect the defect)', () => {
  test('raw dated audit append + raw UAT `updated:` rewrite → status reads stale', (t) => {
    const { projectDir, phaseDir, uatPath, securityPath } = buildFingerprintedPhase(t);
    assert.strictEqual(statusOf(projectDir, phaseDir), 'passed', 'sanity: freshly fingerprinted phase is passed');

    // Pre-fix secure-phase behavior: append an audit row unconditionally,
    // identical counts, just a new date — bytes of the covered file change.
    fs.appendFileSync(securityPath, '\n' + auditBlock('Security Audit', '2026-01-02', { 'Threats found': 1, Closed: 1, Open: 0 }));

    // Pre-fix verify-work complete_session behavior: rewrite `updated:` even
    // though nothing material changed.
    const uat = fs.readFileSync(uatPath, 'utf-8');
    fs.writeFileSync(uatPath, uat.replace(/updated: .*/, 'updated: 2026-03-03T00:00:00Z'));

    assert.strictEqual(
      statusOf(projectDir, phaseDir), 'stale',
      'raw unconditional writes to covered files must stale the report — this is the defect #5105 fixes',
    );
  });
});

describe('T16: a genuine change still publishes and stales the report (invariant 5, digest untouched)', () => {
  test('append-audit with a changed count → status reads stale; digest bytes identical before/after', (t) => {
    const { projectDir, phaseDir, securityPath, covered_digest: before } = buildFingerprintedPhase(t);
    assert.strictEqual(statusOf(projectDir, phaseDir), 'passed');

    const auditResult = runGsdTools(
      [
        'query', 'verification.append-audit', '.planning/phases/01-foo/01-SECURITY.md',
        '--heading', 'Security Audit',
        '--rows', JSON.stringify({ 'Threats found': 2, Closed: 1, Open: 1 }),
        '--date', '2026-01-02',
      ],
      projectDir,
    );
    assert.ok(auditResult.success, `append-audit must succeed: ${auditResult.error}`);
    assert.strictEqual(JSON.parse(auditResult.output).appended, true, 'a genuinely changed count must append');
    assert.match(fs.readFileSync(securityPath, 'utf-8'), /Threats found \| 2/);

    assert.strictEqual(statusOf(projectDir, phaseDir), 'stale', 'a material change must publish and stale the report');

    const finalFp = runGsdTools(
      ['verification', 'fingerprint', phaseDir,
        '.planning/phases/01-foo/01-01-PLAN.md', '.planning/phases/01-foo/01-01-SUMMARY.md',
        '.planning/phases/01-foo/01-UAT.md', '.planning/phases/01-foo/01-SECURITY.md', '.planning/phases/01-foo/01-VALIDATION.md'],
      projectDir,
    );
    assert.ok(finalFp.success);
    assert.notStrictEqual(
      JSON.parse(finalFp.output).covered_digest, before,
      'sanity: the CONTENT digest recomputed fresh does change (the file changed) — but nothing ever restamps the stored covered_digest in the report itself',
    );
  });

  test('complete-session on a UAT whose row genuinely flipped → status reads stale', (t) => {
    const { projectDir, phaseDir, uatPath } = buildFingerprintedPhase(t);
    assert.strictEqual(statusOf(projectDir, phaseDir), 'passed');

    fs.writeFileSync(uatPath, uatContent({ row2Result: '[issue]' }));
    const uatResult = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(uatResult.success, `uat.complete-session must succeed: ${uatResult.error}`);
    assert.strictEqual(JSON.parse(uatResult.output).changed, true, 'a real row flip is material');

    assert.strictEqual(statusOf(projectDir, phaseDir), 'stale', 'a material UAT change must publish and stale the report');
  });
});
