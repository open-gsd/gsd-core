'use strict';
/**
 * Regression test for bug #866: profile-pipeline temp output dirs must be
 * created under GSD_TEMP_DIR (path.join(os.tmpdir(), 'gsd')), not directly
 * under os.tmpdir() root where reapStaleTempFiles() never scans.
 *
 * Hardening (adversarial-review follow-up):
 *  - TMPDIR/TEMP/TMP are redirected to a fixture-scoped directory so the child
 *    process's os.tmpdir() returns an isolated root. This prevents the test from
 *    touching the real shared temp root and keeps it out of the production
 *    reaper's view.
 *  - Both sides of the startsWith assertion are realpath-normalized to kill the
 *    macOS /var ↔ /private/var symlink flakiness.
 *  - An explicit exitCode === 0 assertion is added before JSON.parse so a
 *    non-zero early-exit produces a clear failure rather than a confusing parse
 *    error.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');

describe('bug-866: profile-pipeline temp dirs under GSD_TEMP_DIR', () => {
  let tmpDir;
  let isolatedSysTmp;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-866-');
    // Create an isolated os.tmpdir() root inside the fixture so the child
    // process never writes to the real shared temp dir.
    isolatedSysTmp = path.join(tmpDir, 'systmp');
    fs.mkdirSync(isolatedSysTmp, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Helper: create a minimal synthetic sessions directory structure
  function createSessions(root) {
    const sessionsDir = path.join(root, 'projects');
    const projectDir = path.join(sessionsDir, 'test-project-866');
    fs.mkdirSync(projectDir, { recursive: true });
    const messages = [
      { type: 'user', userType: 'external', message: { content: 'fix the login bug' }, timestamp: Date.now() },
      { type: 'assistant', message: { content: 'Sure.' }, timestamp: Date.now() },
    ];
    fs.writeFileSync(
      path.join(projectDir, 'session-001.jsonl'),
      messages.map(m => JSON.stringify(m)).join('\n')
    );
    return sessionsDir;
  }

  test('extract-messages output_file is under GSD_TEMP_DIR, not os.tmpdir() root', () => {
    const sessionsDir = createSessions(tmpDir);

    // Pass the isolated tmp root so the child's os.tmpdir() = isolatedSysTmp.
    // Belt-and-suspenders: set all three env vars Node checks (TMPDIR=POSIX,
    // TEMP+TMP=Windows).
    const result = runGsdTools(
      ['extract-messages', 'test-project-866', '--path', sessionsDir, '--raw'],
      tmpDir,
      { TMPDIR: isolatedSysTmp, TEMP: isolatedSysTmp, TMP: isolatedSysTmp }
    );

    // Explicit exitCode check first — parse errors are confusing on non-zero exit.
    assert.strictEqual(result.exitCode, 0, `extract-messages must exit 0; error: ${result.error}`);
    assert.ok(result.success, `extract-messages failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.ok(out.output_file, 'should have output_file in result');

    const outputFile = out.output_file;

    // The expected GSD_TEMP_DIR from the child's perspective: isolatedSysTmp/gsd
    const expectedGsdTempDir = path.join(isolatedSysTmp, 'gsd');

    // Normalize both sides via realpath to kill macOS /var↔/private/var symlink
    // flakiness. Realpath the existing output_file's parent directory (the file
    // itself may have been cleaned up already, but the dir will exist).
    const expectedRoot = fs.realpathSync(expectedGsdTempDir);
    const outputDir = path.dirname(outputFile);
    // The output dir must exist since the tool just wrote there; realpath it.
    const actualDir = fs.realpathSync(outputDir);

    assert.ok(
      actualDir.startsWith(expectedRoot + path.sep) || actualDir === expectedRoot,
      `output_file "${outputFile}" must be under GSD_TEMP_DIR "${expectedGsdTempDir}" (realpath: ${expectedRoot}); got dir "${actualDir}"`
    );

    // Must NOT be directly under the isolated systmp root (i.e., no gsd-pipeline-*
    // at depth 1 of isolatedSysTmp).
    const rel = path.relative(isolatedSysTmp, outputFile);
    const depth1Dir = rel.split(path.sep)[0];
    assert.ok(
      !depth1Dir.startsWith('gsd-pipeline-'),
      `output_file must not be in isolatedSysTmp/gsd-pipeline-* but got depth-1 dir: "${depth1Dir}"`
    );
  });

  test('profile-sample output_file is under GSD_TEMP_DIR, not os.tmpdir() root', () => {
    const sessionsDir = createSessions(tmpDir);

    const result = runGsdTools(
      ['profile-sample', '--path', sessionsDir, '--raw'],
      tmpDir,
      { TMPDIR: isolatedSysTmp, TEMP: isolatedSysTmp, TMP: isolatedSysTmp }
    );

    // Explicit exitCode check first.
    assert.strictEqual(result.exitCode, 0, `profile-sample must exit 0; error: ${result.error}`);
    assert.ok(result.success, `profile-sample failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.ok(out.output_file, 'should have output_file in result');

    const outputFile = out.output_file;

    const expectedGsdTempDir = path.join(isolatedSysTmp, 'gsd');

    const expectedRoot = fs.realpathSync(expectedGsdTempDir);
    const outputDir = path.dirname(outputFile);
    const actualDir = fs.realpathSync(outputDir);

    assert.ok(
      actualDir.startsWith(expectedRoot + path.sep) || actualDir === expectedRoot,
      `output_file "${outputFile}" must be under GSD_TEMP_DIR "${expectedGsdTempDir}" (realpath: ${expectedRoot}); got dir "${actualDir}"`
    );

    const rel = path.relative(isolatedSysTmp, outputFile);
    const depth1Dir = rel.split(path.sep)[0];
    assert.ok(
      !depth1Dir.startsWith('gsd-profile-'),
      `output_file must not be in isolatedSysTmp/gsd-profile-* but got depth-1 dir: "${depth1Dir}"`
    );
  });
});
