/**
 * Profile Pipeline Tests
 *
 * Tests for session scanning, message extraction, and profile sampling.
 * Uses synthetic session data in temp directories via --path override.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempDir, createTempProject, cleanup } = require('./helpers.cjs');

// ─── scan-sessions ────────────────────────────────────────────────────────────

describe('scan-sessions command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-profile-test-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns empty array for empty sessions directory', () => {
    const sessionsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const result = runGsdTools(['scan-sessions', '--path', sessionsDir, '--raw'], tmpDir);
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(Array.isArray(out), 'should return an array');
    assert.strictEqual(out.length, 0, 'should be empty');
  });

  test('scans synthetic project directory', () => {
    const sessionsDir = path.join(tmpDir, 'projects');
    const projectDir = path.join(sessionsDir, 'test-project-abc123');
    fs.mkdirSync(projectDir, { recursive: true });

    // Create a synthetic session file
    const sessionData = [
      JSON.stringify({ type: 'user', userType: 'external', message: { content: 'hello' }, timestamp: Date.now() }),
      JSON.stringify({ type: 'assistant', message: { content: 'hi' }, timestamp: Date.now() }),
    ].join('\n');
    fs.writeFileSync(path.join(projectDir, 'session-001.jsonl'), sessionData);

    const result = runGsdTools(['scan-sessions', '--path', sessionsDir, '--raw'], tmpDir);
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(Array.isArray(out), 'should return array');
    assert.strictEqual(out.length, 1, 'should find 1 project');
    assert.strictEqual(out[0].sessionCount, 1, 'should have 1 session');
  });

  test('reports multiple sessions and sizes', () => {
    const sessionsDir = path.join(tmpDir, 'projects');
    const projectDir = path.join(sessionsDir, 'multi-session-project');
    fs.mkdirSync(projectDir, { recursive: true });

    for (let i = 1; i <= 3; i++) {
      const data = JSON.stringify({ type: 'user', userType: 'external', message: { content: `msg ${i}` }, timestamp: Date.now() });
      fs.writeFileSync(path.join(projectDir, `session-${i}.jsonl`), data + '\n');
    }

    const result = runGsdTools(['scan-sessions', '--path', sessionsDir, '--raw'], tmpDir);
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out[0].sessionCount, 3);
    assert.ok(out[0].totalSize > 0, 'should have non-zero size');
  });
});

// ─── extract-messages ─────────────────────────────────────────────────────────

describe('extract-messages command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-profile-test-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts user messages from synthetic session', () => {
    const sessionsDir = path.join(tmpDir, 'projects');
    const projectDir = path.join(sessionsDir, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const messages = [
      { type: 'user', userType: 'external', message: { content: 'fix the login bug' }, timestamp: Date.now() },
      { type: 'assistant', message: { content: 'I will fix it.' }, timestamp: Date.now() },
      { type: 'user', userType: 'external', message: { content: 'add dark mode' }, timestamp: Date.now() },
      { type: 'user', userType: 'internal', isMeta: true, message: { content: '<local-command' }, timestamp: Date.now() },
    ];
    fs.writeFileSync(
      path.join(projectDir, 'session-001.jsonl'),
      messages.map(m => JSON.stringify(m)).join('\n')
    );

    const result = runGsdTools(['extract-messages', 'my-project', '--path', sessionsDir, '--raw'], tmpDir);
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.messages_extracted, 2, 'should extract 2 genuine user messages');
    assert.strictEqual(out.project, 'my-project');
    assert.ok(out.output_file, 'should have output file path');
  });

  test('filters out meta and internal messages', () => {
    const sessionsDir = path.join(tmpDir, 'projects');
    const projectDir = path.join(sessionsDir, 'filter-test');
    fs.mkdirSync(projectDir, { recursive: true });

    const messages = [
      { type: 'user', userType: 'external', message: { content: 'real message' }, timestamp: Date.now() },
      { type: 'user', userType: 'internal', message: { content: 'internal msg' }, timestamp: Date.now() },
      { type: 'user', userType: 'external', isMeta: true, message: { content: 'meta msg' }, timestamp: Date.now() },
      { type: 'user', userType: 'external', message: { content: '<local-command test' }, timestamp: Date.now() },
      { type: 'user', userType: 'external', message: { content: '' }, timestamp: Date.now() },
      { type: 'user', userType: 'external', message: { content: 'second real' }, timestamp: Date.now() },
    ];
    fs.writeFileSync(
      path.join(projectDir, 'session-001.jsonl'),
      messages.map(m => JSON.stringify(m)).join('\n')
    );

    const result = runGsdTools(['extract-messages', 'filter-test', '--path', sessionsDir, '--raw'], tmpDir);
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.messages_extracted, 2, 'should only extract 2 genuine external messages');
  });
});

// ─── profile-questionnaire ────────────────────────────────────────────────────

describe('profile-questionnaire command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns questionnaire structure', () => {
    const result = runGsdTools('profile-questionnaire --raw', tmpDir);
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(out.questions, 'should have questions array');
    assert.ok(out.questions.length > 0, 'should have at least one question');
    assert.ok(out.questions[0].dimension, 'each question should have a dimension');
    assert.ok(out.questions[0].options, 'each question should have options');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-866-profile-pipeline-temp-root.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-866-profile-pipeline-temp-root (consolidation epic #1969 B2 #1971)", () => {
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
  });
}
