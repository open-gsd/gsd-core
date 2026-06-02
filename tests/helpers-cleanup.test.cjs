/**
 * GSD Tools Test Helpers – cleanup() behavioral tests
 *
 * Three deterministic, cross-platform tests that verify cleanup()'s
 * observable contract at the seam rather than probing its internals.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { cleanup, createTempDir } = require('./helpers.cjs');

// ─── Test 1: Real-FS happy path ──────────────────────────────────────────────

test('cleanup removes a real temp dir with nested subdirs and files', () => {
  const dir = createTempDir('gsd-cleanup-test-');
  const nested = path.join(dir, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'file.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'root.txt'), 'world');

  cleanup(dir);

  assert.strictEqual(fs.existsSync(dir), false, 'temp dir should not exist after cleanup');
});

// ─── Test 2: Retry-budget contract ───────────────────────────────────────────

test('cleanup passes recursive/force/maxRetries/retryDelay options to fs.rmSync', () => {
  // Use a real temp dir as the target so cleanup() has a valid path argument.
  // We chdir AWAY from it first so cleanup() does not try to chdir either.
  const dir = createTempDir('gsd-cleanup-opts-test-');

  // Capture original cwd and shift away from the target.
  const originalCwd = process.cwd();
  // Chdir to the parent of the target so cleanup's cwd-guard is a no-op.
  process.chdir(path.dirname(dir));

  let capturedOptions = null;
  const realRmSync = fs.rmSync;

  try {
    // Replace fs.rmSync with a probe that captures options then does nothing.
    // This is an assignment expression (not a CallExpression) so it satisfies
    // the ESLint rule that bans raw fs.rmSync(...) call expressions in tests.
    fs.rmSync = (targetPath, opts) => {
      capturedOptions = opts;
      // Do NOT call through — we don't want the dir actually removed here;
      // we're only testing the options shape.
    };

    cleanup(dir);
  } finally {
    fs.rmSync = realRmSync;
    process.chdir(originalCwd);
    // Remove the dir with the real rmSync now that we restored it.
    cleanup(dir);
  }

  assert.ok(capturedOptions !== null, 'fs.rmSync should have been called');
  assert.strictEqual(capturedOptions.recursive, true, 'recursive must be true');
  assert.strictEqual(capturedOptions.force, true, 'force must be true');
  assert.ok(
    typeof capturedOptions.maxRetries === 'number' && capturedOptions.maxRetries > 0,
    'maxRetries must be a positive number'
  );
  assert.ok(
    typeof capturedOptions.retryDelay === 'number' && capturedOptions.retryDelay > 0,
    'retryDelay must be a positive number'
  );
});

// ─── Test 3: cwd-guard ───────────────────────────────────────────────────────

test('cleanup does not throw when cwd is inside the target dir, and removes the dir', () => {
  const dir = createTempDir('gsd-cleanup-cwd-test-');
  const nested = path.join(dir, 'deep', 'nested');
  fs.mkdirSync(nested, { recursive: true });

  const originalCwd = process.cwd();

  try {
    // Step INTO the nested subdir so cwd is inside the cleanup target.
    process.chdir(nested);

    assert.doesNotThrow(() => {
      cleanup(dir);
    }, 'cleanup should not throw even when cwd is inside the target');
  } finally {
    // Restore original cwd. cleanup() will have chdir'd to dirname(dir),
    // so we always restore explicitly regardless.
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
  }

  assert.strictEqual(fs.existsSync(dir), false, 'temp dir should not exist after cleanup');
});
