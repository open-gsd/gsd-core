'use strict';

/**
 * Tests for scripts/workflow-size.cjs — the shared LF byte counter and
 * workflow enumeration used by both the size guard and the baseline generator.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const path = require('path');

const {
  lfByteCount,
  listWorkflowStems,
  measureWorkflows,
  WORKFLOWS_DIR,
} = require('../scripts/workflow-size.cjs');
const { cleanup } = require('./helpers.cjs');

describe('lfByteCount', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-wfsize-'));
  });
  afterEach(() => cleanup(dir));

  test('counts raw UTF-8 bytes of an LF file', () => {
    const body = 'line one\nline two\n';
    const p = path.join(dir, 'a.md');
    fs.writeFileSync(p, body);
    assert.strictEqual(lfByteCount(p), Buffer.byteLength(body, 'utf-8'));
  });

  test('CRLF and LF of the same logical content count identically (#683)', () => {
    const body = 'alpha\nbeta\ngamma — multibyte dash\n';
    const lf = path.join(dir, 'lf.md');
    const crlf = path.join(dir, 'crlf.md');
    fs.writeFileSync(lf, body);
    fs.writeFileSync(crlf, body.replace(/\n/g, '\r\n'));
    assert.strictEqual(lfByteCount(crlf), lfByteCount(lf));
  });

  test('multibyte characters count as their UTF-8 byte length', () => {
    const body = '— 漢字 🚀\n'; // em-dash (3) + CJK (3 each) + emoji (4)
    const p = path.join(dir, 'm.md');
    fs.writeFileSync(p, body);
    assert.strictEqual(lfByteCount(p), Buffer.byteLength(body, 'utf-8'));
  });

  test('empty file counts as zero bytes', () => {
    const p = path.join(dir, 'empty.md');
    fs.writeFileSync(p, '');
    assert.strictEqual(lfByteCount(p), 0);
  });

  test('throws on a missing file (no silent zero)', () => {
    assert.throws(() => lfByteCount(path.join(dir, 'nope.md')), /ENOENT/);
  });
});

describe('listWorkflowStems / measureWorkflows', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-wfmeasure-'));
  });
  afterEach(() => cleanup(dir));

  test('lists only .md stems, sorted, without extension', () => {
    fs.writeFileSync(path.join(dir, 'zeta.md'), 'z');
    fs.writeFileSync(path.join(dir, 'alpha.md'), 'a');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    assert.deepStrictEqual(listWorkflowStems(dir), ['alpha', 'zeta']);
  });

  test('does not recurse into subdirectories (modes/templates excluded)', () => {
    fs.writeFileSync(path.join(dir, 'top.md'), 'x');
    fs.mkdirSync(path.join(dir, 'modes'));
    fs.writeFileSync(path.join(dir, 'modes', 'sub.md'), 'should not be counted');
    assert.deepStrictEqual(listWorkflowStems(dir), ['top']);
    assert.deepStrictEqual(Object.keys(measureWorkflows(dir)), ['top.md']);
  });

  test('measureWorkflows keys by <stem>.md with LF byte sizes', () => {
    const body = 'hello\nworld\n';
    fs.writeFileSync(path.join(dir, 'one.md'), body);
    const sizes = measureWorkflows(dir);
    assert.deepStrictEqual(sizes, { 'one.md': Buffer.byteLength(body, 'utf-8') });
  });

  test('canonical WORKFLOWS_DIR resolves to a real directory with workflows', () => {
    assert.ok(fs.existsSync(WORKFLOWS_DIR), 'canonical workflows dir should exist');
    const sizes = measureWorkflows();
    assert.ok(Object.keys(sizes).length > 0, 'should measure at least one workflow');
    assert.ok('plan-phase.md' in sizes, 'plan-phase.md should be among the measured workflows');
  });
});
