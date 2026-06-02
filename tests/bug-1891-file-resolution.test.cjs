// allow-test-rule: structural-implementation-guard
// gsd-tools.cjs @file: resolution is a low-level stdout interception that cannot be
// exercised end-to-end via runGsdTools without a real workflow that emits @file: output.
// These structural tests guard the interception wiring until a behavioral integration
// test suite for the full @file: path is added.

/**
 * Regression tests for bug #1891
 *
 * gsd-tools.cjs must transparently resolve @file: references in stdout
 * so that workflows never see the @file: prefix. This eliminates the
 * bash-specific `if [[ "$INIT" == @file:* ]]` check that breaks on
 * PowerShell and other non-bash shells.
 */

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const GSD_TOOLS_SRC = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

describe('bug #1891: @file: resolution in gsd-tools.cjs', () => {
  let src;

  before(() => {
    src = fs.readFileSync(GSD_TOOLS_SRC, 'utf-8');
  });

  test('main() intercepts stdout and resolves @file: references', () => {
    // The non-pick path should have @file: resolution, just like the --pick path
    assert.ok(
      src.includes("captured.startsWith('@file:')") ||
      src.includes('captured.startsWith(\'@file:\')'),
      'main() should check for @file: prefix in captured output'
    );
  });

  test('@file: resolution reads file content via readFileSync', () => {
    // Verify the resolution reads the actual file
    assert.ok(
      src.includes("readFileSync(captured.slice(6)") ||
      src.includes('readFileSync(captured.slice(6)'),
      '@file: resolution should read file at the path after the prefix'
    );
  });

  test('stdout interception wraps runCommand in the non-pick path', () => {
    // The main function should resolve @file: output in BOTH --pick and
    // non-pick paths. This can be either two inline checks or a shared helper.
    const mainFunc = src.slice(src.indexOf('async function main()'));
    const resolveCalls = (mainFunc.match(/resolveAtFileOutput\(/g) || []).length;
    const inlineAtFileChecks = (mainFunc.match(/@file:/g) || []).length;
    assert.ok(
      resolveCalls >= 2 || inlineAtFileChecks >= 2,
      'Both --pick and normal paths should resolve @file: references'
    );
  });
});
