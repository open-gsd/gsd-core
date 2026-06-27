'use strict';

/**
 * feat-1754-cli-skew-detection.test.cjs
 *
 * Tests for the CLI version-skew detection module (src/cli-skew-check.cts).
 *
 * The check warns (returns a string) when the running gsd-tools.cjs is NOT the
 * project-local install while a project-local install EXISTS — the shadowing
 * scenario from #1748 (a stale global canary from @gsd-build/sdk shadowing
 * project-local 1.6.0).
 *
 * DEFECT class: environment / version skew (enhancement #1754)
 *
 * The function is PURE (no I/O — the caller provides paths + existence flags),
 * making it trivially testable without filesystem setup.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { checkCliSkew } = require('../gsd-core/bin/lib/cli-skew-check.cjs');

describe('#1754: checkCliSkew — pure path-comparison skew detection', () => {
  test('SKEW: resolved CLI outside project root + project-local exists → returns warning', () => {
    const warning = checkCliSkew({
      resolvedPath: '/opt/homebrew/bin/gsd-tools',
      projectRoot: '/home/user/my-project',
      projectLocalExists: true,
    });
    assert.ok(warning, 'Expected a warning string when resolved CLI is outside project root and project-local exists');
    assert.ok(warning.includes('shadow') || warning.includes('outside') || warning.includes('may'),
      `Warning should mention the shadowing/outside nature, got: "${warning}"`);
  });

  test('NO-SKEW: resolved CLI is the project-local install → returns null', () => {
    const warning = checkCliSkew({
      resolvedPath: '/home/user/my-project/.claude/gsd-core/bin/gsd-tools.cjs',
      projectRoot: '/home/user/my-project',
      projectLocalExists: true,
    });
    assert.strictEqual(warning, null, 'No warning expected when resolved CLI IS the project-local install');
  });

  test('NO-SKEW: resolved CLI outside project root but NO project-local install → returns null', () => {
    const warning = checkCliSkew({
      resolvedPath: '/usr/local/bin/gsd-tools',
      projectRoot: '/home/user/my-project',
      projectLocalExists: false,
    });
    assert.strictEqual(warning, null, 'No warning expected when no project-local install exists (legitimate global-only)');
  });

  test('NO-SKEW: projectRoot is null (no project context) → returns null', () => {
    const warning = checkCliSkew({
      resolvedPath: '/usr/local/bin/gsd-tools',
      projectRoot: null,
      projectLocalExists: false,
    });
    assert.strictEqual(warning, null, 'No warning expected when there is no project root');
  });

  test('LEGACY-SDK: resolved path contains @gsd-build → warning includes removal instructions', () => {
    const warning = checkCliSkew({
      resolvedPath: '/opt/homebrew/lib/node_modules/@gsd-build/sdk/bin/gsd-tools',
      projectRoot: '/home/user/my-project',
      projectLocalExists: true,
    });
    assert.ok(warning, 'Expected a warning for @gsd-build/sdk paths');
    assert.ok(warning.includes('@gsd-build/sdk') || warning.includes('npm uninstall'),
      `Warning should include @gsd-build/sdk removal instructions, got: "${warning}"`);
  });

  test('PATH-NORMALIZATION: resolved under project root via realpath → no false positive', () => {
    // Even if the resolved path differs in symlink resolution, if it's under the
    // project root, it's not a skew. The caller normalizes paths before calling.
    const warning = checkCliSkew({
      resolvedPath: path.resolve('/home/user/my-project/.claude/gsd-core/bin/gsd-tools.cjs'),
      projectRoot: path.resolve('/home/user/my-project'),
      projectLocalExists: true,
    });
    assert.strictEqual(warning, null, 'No warning when resolved path is under project root (even with realpath normalization)');
  });
});
