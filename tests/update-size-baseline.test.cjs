'use strict';

/**
 * Tests for scripts/update-size-baseline.cjs — the per-file workflow size
 * baseline generator (issue #1074).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const path = require('path');

const {
  generateBaseline,
  serializeBaseline,
} = require('../scripts/update-size-baseline.cjs');
const { assertFileBaseline } = require('../scripts/lib/allowlist-ratchet.cjs');
const { measureWorkflows } = require('../scripts/workflow-size.cjs');
const { cleanup } = require('./helpers.cjs');

describe('serializeBaseline', () => {
  test('keys are sorted and output ends with a trailing newline', () => {
    const out = serializeBaseline({ 'z.md': 3, 'a.md': 1, 'm.md': 2 });
    assert.ok(out.endsWith('\n'), 'must end with a trailing newline');
    const keys = Object.keys(JSON.parse(out));
    assert.deepStrictEqual(keys, ['a.md', 'm.md', 'z.md'], 'keys must be sorted');
  });

  test('is stable: same input serializes identically (minimal-diff artifact)', () => {
    const input = { 'b.md': 2, 'a.md': 1 };
    assert.strictEqual(serializeBaseline(input), serializeBaseline({ ...input }));
  });
});

describe('generateBaseline', () => {
  let dir;
  let outPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gen-baseline-'));
    outPath = path.join(dir, 'baseline.json');
  });
  afterEach(() => cleanup(dir));

  test('writes a baseline matching the measured workflow sizes', () => {
    const wfDir = path.join(dir, 'workflows');
    fs.mkdirSync(wfDir);
    fs.writeFileSync(path.join(wfDir, 'one.md'), 'hello\n');
    fs.writeFileSync(path.join(wfDir, 'two.md'), 'a longer body here\n');

    const result = generateBaseline({ dir: wfDir, outPath });
    assert.strictEqual(result.count, 2);

    const written = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    assert.deepStrictEqual(written, measureWorkflows(wfDir));
  });

  test('idempotent: a second run with no changes produces an identical file', () => {
    const wfDir = path.join(dir, 'workflows');
    fs.mkdirSync(wfDir);
    fs.writeFileSync(path.join(wfDir, 'one.md'), 'hello\n');

    generateBaseline({ dir: wfDir, outPath });
    const first = fs.readFileSync(outPath, 'utf-8');
    generateBaseline({ dir: wfDir, outPath });
    const second = fs.readFileSync(outPath, 'utf-8');
    assert.strictEqual(first, second, 'a no-op regeneration must not churn the file');
  });

  test('round-trip: a freshly generated baseline satisfies assertFileBaseline', () => {
    const wfDir = path.join(dir, 'workflows');
    fs.mkdirSync(wfDir);
    fs.writeFileSync(path.join(wfDir, 'one.md'), 'hello\n');
    fs.writeFileSync(path.join(wfDir, 'two.md'), 'world body\n');

    generateBaseline({ dir: wfDir, outPath });
    const baseline = JSON.parse(fs.readFileSync(outPath, 'utf-8'));

    const calls = [];
    assertFileBaseline({
      label: 'roundtrip',
      current: measureWorkflows(wfDir),
      baseline,
      fail: (m) => calls.push(m),
    });
    assert.deepStrictEqual(calls, [], 'a just-generated baseline must pass the guard with zero failures');
  });

  test('regeneration records growth after a workflow file grows', () => {
    const wfDir = path.join(dir, 'workflows');
    fs.mkdirSync(wfDir);
    const wf = path.join(wfDir, 'one.md');
    fs.writeFileSync(wf, 'small\n');
    generateBaseline({ dir: wfDir, outPath });

    // File grows; the OLD baseline should now flag growth...
    fs.writeFileSync(wf, 'small\nplus several more bytes\n');
    const oldBaseline = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    const beforeRegen = [];
    assertFileBaseline({
      label: 'grow',
      current: measureWorkflows(wfDir),
      baseline: oldBaseline,
      fail: (m) => beforeRegen.push(m),
    });
    assert.strictEqual(beforeRegen.length, 1, 'old baseline must flag the growth');

    // ...and regenerating clears it.
    generateBaseline({ dir: wfDir, outPath });
    const newBaseline = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    const afterRegen = [];
    assertFileBaseline({
      label: 'grow',
      current: measureWorkflows(wfDir),
      baseline: newBaseline,
      fail: (m) => afterRegen.push(m),
    });
    assert.deepStrictEqual(afterRegen, [], 'regenerated baseline must pass');
  });

  test('throws when the workflows directory does not exist', () => {
    assert.throws(
      () => generateBaseline({ dir: path.join(dir, 'missing'), outPath }),
      /ENOENT/
    );
  });
});
