/**
 * #3783 — `query audit-uat`'s summary must self-segment current-milestone
 * debt from archived-milestone debt instead of conflating both into
 * `total_items`/`by_phase`/`by_category`.
 *
 * The scan already stamps each archived result with `archived_milestone`
 * (`src/uat.cts` `UatFileResult.archived_milestone`, set from
 * `getAllArchivedPhaseDirs`'s per-version label) but previously discarded
 * that distinction when building `summary`. This adds two additive fields —
 * `summary.current_milestone: {files, items}` and
 * `summary.archived: {files, items, by_milestone}` — so a consumer reads one
 * field instead of re-deriving the `archived_milestone` filter itself (the
 * duplication class behind #3782, which fixed `progress.md`'s render-side
 * conflation independently and is not touched here).
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const FRONTMATTER = `---
status: testing
phase: 01-foundation
started: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

`;

function uatBody(items) {
  let body = `${FRONTMATTER}## Tests\n\n`;
  items.forEach(({ name, result }, i) => {
    body += `### ${i + 1}. ${name}\nresult: ${result}\n\n`;
  });
  return body;
}

function writeActivePhaseUat(tmpDir, phaseSlug, fileName, items) {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, fileName), uatBody(items));
}

function writeArchivedPhaseUat(tmpDir, version, phaseSlug, fileName, items) {
  const phaseDir = path.join(tmpDir, '.planning', 'milestones', `${version}-phases`, phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, fileName), uatBody(items));
}

function writeArchivedDeferred(tmpDir, version, phaseSlug, text) {
  const phaseDir = path.join(tmpDir, '.planning', 'milestones', `${version}-phases`, phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(phaseDir, 'deferred-items.md'),
    `## Deferred Items\n\n- ${text}\n`,
  );
}

function writeActiveDeferred(tmpDir, phaseSlug, text) {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(phaseDir, 'deferred-items.md'),
    `## Deferred Items\n\n- ${text}\n`,
  );
}

function runAudit(tmpDir) {
  const result = runGsdTools('audit-uat --raw', tmpDir);
  assert.ok(result.success, `Command failed: ${result.error}`);
  return JSON.parse(result.output);
}

describe('#3783: audit-uat summary self-segments current-milestone vs archived debt', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('current-milestone-only results segment entirely into current_milestone', () => {
    writeActivePhaseUat(tmpDir, '01-foundation', '01-UAT.md', [
      { name: 'Alpha', result: 'pending' },
      { name: 'Beta', result: 'pass' },
    ]);

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.deepStrictEqual(
      output.summary.current_milestone,
      { files: 1, items: 1 },
      describeAll(),
    );
    assert.deepStrictEqual(
      output.summary.archived,
      { files: 0, items: 0, by_milestone: {} },
      describeAll(),
    );
    // Legacy fields untouched by the new segmentation.
    assert.strictEqual(output.summary.total_items, 1, describeAll());
    assert.strictEqual(output.summary.total_files, 1, describeAll());
  });

  test('archived-only results segment entirely into archived, keyed by version', () => {
    writeArchivedPhaseUat(tmpDir, 'v0.1.0', '01-foundation', '01-UAT.md', [
      { name: 'Alpha', result: 'pending' },
      { name: 'Beta', result: 'blocked' },
    ]);

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.deepStrictEqual(
      output.summary.current_milestone,
      { files: 0, items: 0 },
      describeAll(),
    );
    assert.strictEqual(output.summary.archived.files, 1, describeAll());
    assert.strictEqual(output.summary.archived.items, 2, describeAll());
    assert.deepStrictEqual(
      output.summary.archived.by_milestone,
      { 'v0.1.0': 2 },
      describeAll(),
    );
    assert.strictEqual(output.summary.total_items, 2, describeAll());
  });

  test('mixed active + multiple archived milestones segments per version', () => {
    writeActivePhaseUat(tmpDir, '02-current', '02-UAT.md', [
      { name: 'Active Item', result: 'pending' },
    ]);
    writeArchivedPhaseUat(tmpDir, 'v0.1.0', '01-foundation', '01-UAT.md', [
      { name: 'Old A', result: 'pending' },
      { name: 'Old B', result: 'blocked' },
      { name: 'Old C', result: 'skipped' },
    ]);
    writeArchivedPhaseUat(tmpDir, 'v0.2.0', '01-followup', '01-UAT.md', [
      { name: 'Newer A', result: 'pending' },
    ]);

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.deepStrictEqual(
      output.summary.current_milestone,
      { files: 1, items: 1 },
      describeAll(),
    );
    assert.strictEqual(output.summary.archived.files, 2, describeAll());
    assert.strictEqual(output.summary.archived.items, 4, describeAll());
    assert.deepStrictEqual(
      output.summary.archived.by_milestone,
      { 'v0.1.0': 3, 'v0.2.0': 1 },
      describeAll(),
    );
    // Cross-population legacy total is the sum of both buckets (unchanged shape).
    assert.strictEqual(
      output.summary.total_items,
      output.summary.current_milestone.items + output.summary.archived.items,
      describeAll(),
    );
  });

  test('a zero-item result still counts toward .files but not .items, in the correct bucket', () => {
    // A phase whose only test row has no `result:` line at all is a parse
    // gap: zero items, but the file WAS scanned. See UatFileResult.parse_gap.
    writeActivePhaseUat(tmpDir, '01-foundation', '01-UAT.md', []);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-UAT.md'),
      `${FRONTMATTER}## Tests\n\n### 1. Unparseable\n`,
    );
    writeArchivedPhaseUat(tmpDir, 'v0.1.0', '01-old', '01-UAT.md', []);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'milestones', 'v0.1.0-phases', '01-old', '01-UAT.md'),
      `${FRONTMATTER}## Tests\n\n### 1. Unparseable Old\n`,
    );

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.deepStrictEqual(
      output.summary.current_milestone,
      { files: 1, items: 0 },
      describeAll(),
    );
    assert.strictEqual(output.summary.archived.files, 1, describeAll());
    assert.strictEqual(output.summary.archived.items, 0, describeAll());
    assert.deepStrictEqual(
      output.summary.archived.by_milestone,
      { 'v0.1.0': 0 },
      describeAll(),
    );
  });

  test('legacy summary fields stay unchanged (additive-only)', () => {
    writeActivePhaseUat(tmpDir, '01-foundation', '01-UAT.md', [
      { name: 'Alpha', result: 'pending' },
    ]);
    writeArchivedPhaseUat(tmpDir, 'v0.1.0', '01-old', '01-UAT.md', [
      { name: 'Old', result: 'blocked' },
    ]);

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.strictEqual(output.summary.total_files, 2, describeAll());
    assert.strictEqual(output.summary.total_items, 2, describeAll());
    assert.strictEqual(output.summary.parse_gap_files, 0, describeAll());
    assert.deepStrictEqual(output.summary.by_category, { pending: 1, blocked: 1 }, describeAll());
    assert.ok(Object.prototype.hasOwnProperty.call(output.summary.by_phase, '01'), describeAll());
  });

  test('deferred-type results segment by archived_milestone the same as uat/verification', () => {
    writeActiveDeferred(tmpDir, '01-foundation', 'Some deferred follow-up.');
    writeArchivedDeferred(tmpDir, 'v0.1.0', '01-old', 'An old deferred item.');

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output, null, 2);

    assert.strictEqual(output.summary.current_milestone.files, 1, describeAll());
    assert.strictEqual(output.summary.current_milestone.items, 1, describeAll());
    assert.strictEqual(output.summary.archived.files, 1, describeAll());
    assert.strictEqual(output.summary.archived.items, 1, describeAll());
    assert.deepStrictEqual(output.summary.archived.by_milestone, { 'v0.1.0': 1 }, describeAll());
  });

  test('an empty scan yields zeroed current_milestone and archived buckets', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const output = runAudit(tmpDir);
    const describeAll = () => JSON.stringify(output.summary, null, 2);

    assert.deepStrictEqual(
      output.summary.current_milestone,
      { files: 0, items: 0 },
      describeAll(),
    );
    assert.deepStrictEqual(
      output.summary.archived,
      { files: 0, items: 0, by_milestone: {} },
      describeAll(),
    );
  });
});

// ─── #6231: summary.files_scanned ────────────────────────────────────────────
//
// `audit-uat` could not tell a scan that reached no files from a scan that read
// files and found them clean: `summary.total_files` is the number of files that
// held something to report, so it is 0 in both cases and the workflow printed
// `## All Clear` for both. `summary.files_scanned` counts every UAT /
// VERIFICATION / deferred-items document the scan read, whether or not it
// yielded an item.

const CLEAN_UAT = [
  '---',
  'status: complete',
  '---',
  '# UAT',
  '',
  '## Tests',
  '',
  '### 1. Login works',
  'expected: the user signs in',
  'result: pass',
  '',
].join('\n');

// A `### N.` test block with no `result:` field yields no item: a parse gap.
const PARSE_GAP_UAT = [
  '---',
  'status: testing',
  '---',
  '# UAT',
  '',
  '## Tests',
  '',
  '### 1. Login works',
  'expected: the user signs in',
  '',
].join('\n');

const PASSED_VERIFICATION = ['---', 'status: passed', '---', '', '# Verification', ''].join('\n');

describe('audit-uat reports how many files it scanned (#6231)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  const phaseDirOf = (name, root = path.join('.planning', 'phases')) => {
    const dir = path.join(tmpDir, root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const auditSummary = () => {
    const r = runGsdTools(['audit-uat', '--raw'], tmpDir);
    assert.ok(r.success, r.error);
    return JSON.parse(r.output).summary;
  };

  test('an empty phases tree reports files_scanned 0 (#6231)', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
    const s = auditSummary();
    assert.equal(s.files_scanned, 0);
    assert.equal(s.total_files, 0);
    assert.equal(s.total_items, 0);
    assert.equal(s.parse_gap_files, 0);
  });

  test('a clean UAT file is scanned: files_scanned 1 with no items (#6231)', () => {
    fs.writeFileSync(path.join(phaseDirOf('01-login'), '01-UAT.md'), CLEAN_UAT);
    const s = auditSummary();
    assert.equal(s.files_scanned, 1);
    assert.equal(s.total_files, 0);
    assert.equal(s.total_items, 0);
    assert.equal(s.parse_gap_files, 0);
  });

  test('a parse-gap file counts as scanned and still reports the gap', () => {
    fs.writeFileSync(path.join(phaseDirOf('01-login'), '01-UAT.md'), PARSE_GAP_UAT);
    const s = auditSummary();
    assert.equal(s.files_scanned, 1);
    assert.equal(s.parse_gap_files, 1);
    assert.equal(s.total_items, 0);
  });

  test('a passed VERIFICATION file counts as scanned', () => {
    fs.writeFileSync(path.join(phaseDirOf('01-login'), '01-VERIFICATION.md'), PASSED_VERIFICATION);
    const s = auditSummary();
    assert.equal(s.files_scanned, 1);
    assert.equal(s.total_files, 0);
  });

  test('a fully resolved deferred-items.md counts as scanned', () => {
    fs.writeFileSync(path.join(phaseDirOf('01-login'), 'deferred-items.md'), '# Deferred Items\n\nNothing deferred.\n');
    const s = auditSummary();
    assert.equal(s.files_scanned, 1);
    assert.equal(s.total_files, 0);
  });

  test('a clean archived UAT counts as scanned', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(path.join(phaseDirOf('01-login', path.join('.planning', 'milestones', 'v1.0-phases')), '01-UAT.md'), CLEAN_UAT);
    const s = auditSummary();
    assert.equal(s.files_scanned, 1);
    assert.equal(s.total_items, 0);
  });

  test('phase directories without UAT, VERIFICATION or deferred files scan nothing', () => {
    fs.writeFileSync(path.join(phaseDirOf('01-login'), '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDirOf('02-billing'), '02-01-PLAN.md'), '# Plan\n');
    assert.equal(auditSummary().files_scanned, 0);
  });

  test('the audit workflows gate their all-clear on files_scanned (#6231)', () => {
    const workflow = (name) => splitLines(
      fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', name), 'utf-8'),
    ).join('\n');
    const uat = workflow('audit-uat.md');
    const nothing = uat.indexOf('## Nothing Scanned');
    const clear = uat.indexOf('## All Clear');
    assert.ok(nothing !== -1 && clear !== -1 && nothing < clear,
      'audit-uat.md must test the empty scan before it can print All Clear');
    assert.match(uat, /`summary\.files_scanned` is 0/);
    assert.match(workflow('audit-fix.md'), /`summary\.files_scanned` in `\$INIT` is 0/);
  });

  test('files_scanned counts every scanned file, not just those with items', () => {
    fs.writeFileSync(path.join(phaseDirOf('01-login'), '01-UAT.md'), CLEAN_UAT);
    fs.writeFileSync(path.join(phaseDirOf('02-billing'), '02-UAT.md'), CLEAN_UAT);
    const s = auditSummary();
    assert.equal(s.files_scanned, 2);
    assert.equal(s.total_files, 0);
  });
});
