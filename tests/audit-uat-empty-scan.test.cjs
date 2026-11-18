/**
 * #6231: `audit-uat` could not tell a scan that reached no files from a scan
 * that read files and found them clean — `summary.total_files` is the number of
 * files that held something to report, so it is 0 in both cases and the
 * workflow printed `## All Clear` for both. `summary.files_scanned` counts every
 * UAT / VERIFICATION / deferred-items document the scan read, whether or not it
 * yielded an item, so an empty scan is distinguishable from a clean one.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

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

  const phaseDir = (name, root = path.join('.planning', 'phases')) => {
    const dir = path.join(tmpDir, root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const audit = () => {
    const r = runGsdTools(['audit-uat', '--raw'], tmpDir);
    assert.ok(r.success, r.error);
    return JSON.parse(r.output).summary;
  };

  test('an empty phases tree reports files_scanned 0 (#6231)', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
    const s = audit();
    assert.equal(s.files_scanned, 0);
    assert.equal(s.total_files, 0);
    assert.equal(s.total_items, 0);
    assert.equal(s.parse_gap_files, 0);
  });

  test('a clean UAT file is scanned: files_scanned 1 with no items (#6231)', () => {
    fs.writeFileSync(path.join(phaseDir('01-login'), '01-UAT.md'), CLEAN_UAT);
    const s = audit();
    assert.equal(s.files_scanned, 1);
    assert.equal(s.total_files, 0);
    assert.equal(s.total_items, 0);
    assert.equal(s.parse_gap_files, 0);
  });

  test('a parse-gap file counts as scanned and still reports the gap', () => {
    fs.writeFileSync(path.join(phaseDir('01-login'), '01-UAT.md'), PARSE_GAP_UAT);
    const s = audit();
    assert.equal(s.files_scanned, 1);
    assert.equal(s.parse_gap_files, 1);
    assert.equal(s.total_items, 0);
  });

  test('a passed VERIFICATION file counts as scanned', () => {
    fs.writeFileSync(path.join(phaseDir('01-login'), '01-VERIFICATION.md'), PASSED_VERIFICATION);
    const s = audit();
    assert.equal(s.files_scanned, 1);
    assert.equal(s.total_files, 0);
  });

  test('a fully resolved deferred-items.md counts as scanned', () => {
    fs.writeFileSync(path.join(phaseDir('01-login'), 'deferred-items.md'), '# Deferred Items\n\nNothing deferred.\n');
    const s = audit();
    assert.equal(s.files_scanned, 1);
    assert.equal(s.total_files, 0);
  });

  test('a clean archived UAT counts as scanned', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(path.join(phaseDir('01-login', path.join('.planning', 'milestones', 'v1.0-phases')), '01-UAT.md'), CLEAN_UAT);
    const s = audit();
    assert.equal(s.files_scanned, 1);
    assert.equal(s.total_items, 0);
  });

  test('phase directories without UAT, VERIFICATION or deferred files scan nothing', () => {
    fs.writeFileSync(path.join(phaseDir('01-login'), '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir('02-billing'), '02-01-PLAN.md'), '# Plan\n');
    assert.equal(audit().files_scanned, 0);
  });

  test('files_scanned counts every scanned file, not just those with items', () => {
    fs.writeFileSync(path.join(phaseDir('01-login'), '01-UAT.md'), CLEAN_UAT);
    fs.writeFileSync(path.join(phaseDir('02-billing'), '02-UAT.md'), CLEAN_UAT);
    const s = audit();
    assert.equal(s.files_scanned, 2);
    assert.equal(s.total_files, 0);
  });
});
