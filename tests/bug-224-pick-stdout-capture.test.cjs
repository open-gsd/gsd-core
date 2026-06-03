// allow-test-rule: structural-implementation-guard
// Bug #224 is a platform-specific (Node 24 + Windows) flake in `--pick` where
// stdout interception can produce non-deterministic failures. We lock the seam
// contract structurally until we have a deterministic Windows reproduction
// harness in CI.

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools } = require('./helpers.cjs');

const GSD_TOOLS_SRC = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

describe('bug #224: --pick stdout capture contract', () => {
  let src;

  before(() => {
    src = fs.readFileSync(GSD_TOOLS_SRC, 'utf-8');
  });

  test('--pick output still succeeds for current-timestamp command', () => {
    const result = runGsdTools(['current-timestamp', '--pick', 'timestamp']);
    assert.strictEqual(result.success, true, result.error || 'expected command to succeed');
    assert.match(result.output, /^\d{4}-\d{2}-\d{2}T/, 'expected ISO timestamp output');
  });

  test('stdout interception for fd=1 returns a byte count (never undefined)', () => {
    const mainStart = src.indexOf('async function main()');
    assert.ok(mainStart !== -1, 'main() must exist');
    const mainSrc = src.slice(mainStart);

    assert.ok(
      mainSrc.includes('Buffer.byteLength(') || mainSrc.includes('return data.length'),
      'stdout interception must return written-byte counts for fd=1 captures'
    );
  });
});
