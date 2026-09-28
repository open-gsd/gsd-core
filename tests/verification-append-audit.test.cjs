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
const os = require('os');
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

describe('S2: verification.append-audit containment refusals (#5105 review)', () => {
  test('S2a: absolute path outside the project root is refused, bytes unchanged', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5105-outside-'));
    t.after(() => cleanup(outside));
    const outsideFile = path.join(outside, 'x-SECURITY.md');
    const before = '# Security\n';
    fs.writeFileSync(outsideFile, before);

    const result = callAppendAudit(projectDir, outsideFile, { heading: 'H', rows: { a: 1 } });
    assert.ok(!result.success, 'must refuse an absolute path outside the project root');
    assert.strictEqual(fs.readFileSync(outsideFile, 'utf-8'), before);
  });

  test('S2b: a `../` escape is refused', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = callAppendAudit(projectDir, '../../../../etc/passwd-SECURITY.md', { heading: 'H', rows: { a: 1 } });
    assert.ok(!result.success, 'must refuse a `../` escape');
  });

  test('S2c: a symlink whose real target is a *-VERIFICATION.md is refused', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-VERIFICATION.md'), '# V\n');
    try {
      fs.symlinkSync('01-VERIFICATION.md', path.join(phaseDir, 'link-SECURITY.md'));
    } catch {
      t.skip('this host cannot create symlinks (unprivileged Windows)');
      return;
    }

    const result = callAppendAudit(projectDir, '.planning/phases/01-foo/link-SECURITY.md', { heading: 'H', rows: { a: 1 } });
    assert.ok(!result.success, 'must refuse a symlink resolving to a verification report');
  });

  test('S2d: a lowercase `07-verification.md` basename is refused (case-insensitive)', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '07-verification.md');
    fs.writeFileSync(filePath, '# v\n');

    const result = callAppendAudit(projectDir, '.planning/phases/01-foo/07-verification.md', { heading: 'H', rows: { a: 1 } });
    assert.ok(!result.success, 'must refuse a lowercase verification-report-shaped basename');
  });

  test('S2e: a `README.md` target (neither -SECURITY.md nor -VALIDATION.md) is refused', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const filePath = path.join(projectDir, 'README.md');
    const before = '# hi\n';
    fs.writeFileSync(filePath, before);

    const result = callAppendAudit(projectDir, 'README.md', { heading: 'H', rows: { a: 1 } });
    assert.ok(!result.success, 'must refuse a target that is not *-SECURITY.md / *-VALIDATION.md');
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), before);
  });
});

describe('S3: verification.append-audit input validation (#5105 review)', () => {
  function setupFixture(t) {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '01-SECURITY.md');
    fs.writeFileSync(filePath, '# Security\n\nNo audit trail yet.\n');
    return { projectDir, filePath: '.planning/phases/01-foo/01-SECURITY.md' };
  }

  test('S3a: a newline in --heading is refused', (t) => {
    const { projectDir, filePath } = setupFixture(t);
    const result = callAppendAudit(projectDir, filePath, { heading: 'H\nX', rows: { a: 1 } });
    assert.ok(!result.success, 'must refuse a heading containing a newline');
  });

  test('S3b: a `|` in a row key is refused', (t) => {
    const { projectDir, filePath } = setupFixture(t);
    const result = callAppendAudit(projectDir, filePath, { heading: 'H', rows: { 'a|b': 1 } });
    assert.ok(!result.success, 'must refuse a row key containing |');
  });

  test('S3c: a negative row value is refused', (t) => {
    const { projectDir, filePath } = setupFixture(t);
    const result = callAppendAudit(projectDir, filePath, { heading: 'H', rows: { a: -1 } });
    assert.ok(!result.success, 'must refuse a negative row value');
  });

  test('S3d: a non-integer row value is refused', (t) => {
    const { projectDir, filePath } = setupFixture(t);
    const result = callAppendAudit(projectDir, filePath, { heading: 'H', rows: { a: 1.5 } });
    assert.ok(!result.success, 'must refuse a non-integer row value');
  });

  test('S3e: --date not matching YYYY-MM-DD is refused', (t) => {
    const { projectDir, filePath } = setupFixture(t);
    const result = callAppendAudit(projectDir, filePath, { heading: 'H', rows: { a: 1 }, date: '2026/01/01' });
    assert.ok(!result.success, 'must refuse a malformed --date');
  });

  test('S3f: --rows that is not a JSON object (an array) is refused', (t) => {
    const { projectDir, filePath } = setupFixture(t);
    const result = runGsdTools(
      ['query', 'verification.append-audit', filePath, '--heading', 'H', '--rows', '[1,2]'],
      projectDir,
    );
    assert.ok(!result.success, 'must refuse a non-object --rows value');
  });

  test('#5105 review finding 6: a --heading with leading/trailing whitespace is refused', (t) => {
    const { projectDir, filePath } = setupFixture(t);
    const result = callAppendAudit(projectDir, filePath, { heading: ' H', rows: { a: 1 } });
    assert.ok(!result.success, 'must refuse a heading with leading whitespace');
  });

  test('#5105 review finding 6: a --rows key with leading/trailing whitespace is refused', (t) => {
    const { projectDir, filePath } = setupFixture(t);
    const result = callAppendAudit(projectDir, filePath, { heading: 'H', rows: { ' Open': 1 } });
    assert.ok(!result.success, 'must refuse a row key with leading whitespace, so it cannot silently fail to match an existing trimmed "Open" row');
  });

  test('#5105 review finding 9: --date with an out-of-range month/day (2026-99-99) is refused', (t) => {
    const { projectDir, filePath } = setupFixture(t);
    const result = callAppendAudit(projectDir, filePath, { heading: 'H', rows: { a: 1 }, date: '2026-99-99' });
    assert.ok(!result.success, 'must refuse a date whose month/day are out of calendar range');
  });

  test('#5105 review finding 9: --date for a day that does not exist in that month (2026-02-30) is refused', (t) => {
    const { projectDir, filePath } = setupFixture(t);
    const result = callAppendAudit(projectDir, filePath, { heading: 'H', rows: { a: 1 }, date: '2026-02-30' });
    assert.ok(!result.success, 'must refuse a day that overflows its month (2026 is not a leap year in February)');
  });

  test('#5105 review finding 9: a real calendar date (2026-02-28) is accepted', (t) => {
    const { projectDir, filePath } = setupFixture(t);
    const result = callAppendAudit(projectDir, filePath, { heading: 'H', rows: { a: 1 }, date: '2026-02-28' });
    assert.ok(result.success, `a real calendar date must be accepted: ${result.error}`);
  });
});

describe('S4: verification.append-audit table comparison robustness (#5105 review)', () => {
  test('S4a: legacy block (no blank line, wide `|--------|` separator), identical counts → appended:false', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '01-SECURITY.md');
    fs.writeFileSync(
      filePath,
      '# Security\n\n## Security Audit 2026-01-01\n'
        + '| Metric | Count |\n|--------|-------|\n'
        + '| Threats found | 3 |\n| Closed | 3 |\n| Open | 0 |\n',
    );

    const result = callAppendAudit(projectDir, '.planning/phases/01-foo/01-SECURITY.md', {
      heading: 'Security Audit',
      rows: { 'Threats found': 3, Closed: 3, Open: 0 },
      date: '2026-02-01',
    });
    assert.ok(result.success, `expected success: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).appended, false);
  });

  test('S4b: only the template\'s bare "## Security Audit Trail" heading is present → appended:true', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '01-SECURITY.md');
    fs.writeFileSync(filePath, '# Security\n\n## Security Audit Trail\n\nNo entries yet.\n');

    const result = callAppendAudit(projectDir, '.planning/phases/01-foo/01-SECURITY.md', {
      heading: 'Security Audit',
      rows: { 'Threats found': 1 },
      date: '2026-01-01',
    });
    assert.ok(result.success, `expected success: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).appended, true, '"Security Audit Trail" is not a dated block');
  });

  test('S4c: reordered keys, same values → appended:false (order-insensitive compare)', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '01-SECURITY.md');
    fs.writeFileSync(
      filePath,
      '# Security\n\n'
        + auditBlock('Security Audit', '2026-01-01', { 'Threats found': 3, Closed: 3, Open: 0 }),
    );

    const result = callAppendAudit(projectDir, '.planning/phases/01-foo/01-SECURITY.md', {
      heading: 'Security Audit',
      rows: { Open: 0, Closed: 3, 'Threats found': 3 },
      date: '2026-02-01',
    });
    assert.ok(result.success, `expected success: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).appended, false);
  });

  test('S4d: one count differs (order also reshuffled) → appended:true', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '01-SECURITY.md');
    fs.writeFileSync(
      filePath,
      '# Security\n\n'
        + auditBlock('Security Audit', '2026-01-01', { 'Threats found': 3, Closed: 3, Open: 0 }),
    );

    const result = callAppendAudit(projectDir, '.planning/phases/01-foo/01-SECURITY.md', {
      heading: 'Security Audit',
      rows: { Open: 1, Closed: 3, 'Threats found': 3 },
      date: '2026-02-01',
    });
    assert.ok(result.success, `expected success: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).appended, true);
  });
});

describe('S6: verification.append-audit fence-aware block detection (#5105 review)', () => {
  test('S6a: a `## <heading> <date>`-shaped line inside a fenced code block is not a block', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const filePath = path.join(phaseDir, '01-SECURITY.md');
    fs.writeFileSync(
      filePath,
      '# Security\n\n'
        + '```\n## Security Audit 2026-01-01\n| Metric | Count |\n|---|---|\n| Threats found | 3 |\n```\n',
    );

    const result = callAppendAudit(projectDir, '.planning/phases/01-foo/01-SECURITY.md', {
      heading: 'Security Audit',
      rows: { 'Threats found': 3 },
      date: '2026-02-01',
    });
    assert.ok(result.success, `expected success: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).appended, true, 'a fenced heading must never be selected as a real block');
  });
});

describe('#5105 review: planAuditAppend default-date clock seam (pure core, no subprocess)', () => {
  test('omitting `date` defaults through the injectable `clock` seam, never a bare `new Date()`', () => {
    const { planAuditAppend } = require('../gsd-core/bin/lib/verification.cjs');
    class FixedClock extends Date {
      constructor() {
        super('2027-03-04T00:00:00.000Z');
      }
    }
    const result = planAuditAppend('# Security\n\nNo audit trail yet.\n', {
      heading: 'Security Audit',
      rows: { a: 1 },
      clock: FixedClock,
    });
    assert.strictEqual(result.appended, true);
    assert.match(result.content, /## Security Audit 2027-03-04/);
  });

  test('omitting `date` and `clock` picks up node:test mock.timers on global Date', (t) => {
    const { planAuditAppend } = require('../gsd-core/bin/lib/verification.cjs');
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2027-05-06T00:00:00.000Z') });
    t.after(() => t.mock.timers.reset());
    const result = planAuditAppend('# Security\n\nNo audit trail yet.\n', {
      heading: 'Security Audit',
      rows: { a: 1 },
    });
    assert.strictEqual(result.appended, true);
    assert.match(result.content, /## Security Audit 2027-05-06/);
  });
});
