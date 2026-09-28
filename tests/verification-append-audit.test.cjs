/**
 * tests/verification-append-audit.test.cjs — #5105 test matrix rows T10-T14.
 *
 * FAILING-FIRST: `verification.append-audit` (src/verification.cts, added to
 * VERIFICATION_SUBCOMMANDS) does not exist yet — design 40-design.md §R "R3".
 * Expected to fail until R3 lands.
 *
 * Design: .gsd/phase/fix-5105-verify-lifecycle-writes/40-design.md §R "R3".
 * Matrix: .gsd/phase/fix-5105-verify-lifecycle-writes/50-test-matrix.md T10-T14.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');

function auditBlock(heading, date, rows) {
  const lines = [`## ${heading} ${date}`, '', '| Metric | Count |', '|---|---|'];
  for (const [k, v] of Object.entries(rows)) lines.push(`| ${k} | ${v} |`);
  return lines.join('\n') + '\n';
}

function callAppendAudit(projectDir, filePath, { heading, rows, date }) {
  return runGsdTools(
    [
      'query', 'verification.append-audit', filePath,
      '--heading', heading,
      '--rows', JSON.stringify(rows),
      ...(date ? ['--date', date] : []),
    ],
    projectDir,
  );
}

describe('T10-T14: verification.append-audit (#5105 R3)', () => {
  test('T10: last block identical rows, different date → appended:false, bytes identical', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '01-SECURITY.md');
    const before = '# Security\n\n' + auditBlock('Security Audit', '2026-01-01', { 'Threats found': 3, Closed: 3, Open: 0 });
    fs.writeFileSync(filePath, before);

    const result = callAppendAudit(projectDir, '.planning/phases/01-foo/01-SECURITY.md', {
      heading: 'Security Audit',
      rows: { 'Threats found': 3, Closed: 3, Open: 0 },
      date: '2026-01-02',
    });
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.appended, false);
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), before, 'bytes must be unchanged (#4887)');
  });

  test('T11: one count differs from the last block → appended:true, new block is last', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '01-SECURITY.md');
    fs.writeFileSync(filePath, '# Security\n\n' + auditBlock('Security Audit', '2026-01-01', { 'Threats found': 3, Closed: 2, Open: 1 }));

    const result = callAppendAudit(projectDir, '.planning/phases/01-foo/01-SECURITY.md', {
      heading: 'Security Audit',
      rows: { 'Threats found': 3, Closed: 3, Open: 0 },
      date: '2026-01-02',
    });
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.appended, true);
    const after = fs.readFileSync(filePath, 'utf-8');
    const blocks = [...after.matchAll(/## Security Audit \d{4}-\d{2}-\d{2}/g)];
    assert.strictEqual(blocks.length, 2, 'expected exactly two audit blocks after append');
    const lastBlockIdx = after.lastIndexOf('## Security Audit 2026-01-02');
    assert.ok(lastBlockIdx > -1, 'new block must be present and last');
    assert.ok(lastBlockIdx > after.lastIndexOf('## Security Audit 2026-01-01'));
  });

  test('T12: boundary — an earlier block matches but the LAST block differs → appended:true', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '01-SECURITY.md');
    const rowsA = { 'Threats found': 2, Closed: 2, Open: 0 };
    const rowsB = { 'Threats found': 3, Closed: 2, Open: 1 };
    fs.writeFileSync(
      filePath,
      '# Security\n\n'
        + auditBlock('Security Audit', '2026-01-01', rowsA)
        + '\n'
        + auditBlock('Security Audit', '2026-01-02', rowsB),
    );

    // New rows match the EARLIER block (rowsA), not the last block (rowsB) —
    // must still append, since comparison is against the LAST block only.
    const result = callAppendAudit(projectDir, '.planning/phases/01-foo/01-SECURITY.md', {
      heading: 'Security Audit',
      rows: rowsA,
      date: '2026-01-03',
    });
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.appended, true, 'comparison must be against the LAST block, not any earlier one');
  });

  test('T13: no prior block → appended:true', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '01-SECURITY.md');
    fs.writeFileSync(filePath, '# Security\n\nNo audit trail yet.\n');

    const result = callAppendAudit(projectDir, '.planning/phases/01-foo/01-SECURITY.md', {
      heading: 'Security Audit',
      rows: { 'Threats found': 1, Closed: 0, Open: 1 },
      date: '2026-01-01',
    });
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.appended, true);
    assert.match(fs.readFileSync(filePath, 'utf-8'), /## Security Audit 2026-01-01/);
  });

  test('T14: property — append(append(f, r), r) second call gives appended:false (idempotence)', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '01-VALIDATION.md');

    fc.assert(
      fc.property(
        fc.record({
          Gaps: fc.nat({ max: 20 }),
          Resolved: fc.nat({ max: 20 }),
          Escalated: fc.nat({ max: 5 }),
        }),
        (rows) => {
          fs.writeFileSync(filePath, '# Validation\n\nNo audit trail yet.\n');
          const first = callAppendAudit(projectDir, '.planning/phases/01-foo/01-VALIDATION.md', {
            heading: 'Validation Audit',
            rows,
            date: '2026-02-01',
          });
          assert.ok(first.success, `expected success: ${first.error}`);
          assert.strictEqual(JSON.parse(first.output).appended, true, 'first append onto an empty file must append');

          const second = callAppendAudit(projectDir, '.planning/phases/01-foo/01-VALIDATION.md', {
            heading: 'Validation Audit',
            rows,
            date: '2026-02-02',
          });
          assert.ok(second.success, `expected success: ${second.error}`);
          assert.strictEqual(JSON.parse(second.output).appended, false, 'appending the identical rows again must be a no-op');
        },
      ),
      { numRuns: 15 },
    );
  });
});
