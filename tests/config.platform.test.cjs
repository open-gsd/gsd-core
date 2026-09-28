'use strict';

/**
 * Platform-sensitive tests split out of tests/config.test.cjs (#5074).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. The tests below carry the platform signal, so
 * they live here; tests/config.test.cjs stays signal-free and runs on Linux only.
 * Linux lanes run both files. Add a new platform-sensitive test HERE, not in the
 * base file — the generator fails if a split base regains a platform signal.
 *
 * Moved tests and why each needs a real OS:
 * - "detects Brave Search from file-based key" — reads brave_api_key from the
 *   sandboxed home directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "detects Tavily Search from env var" — asserts TAVILY_API_KEY detection resolved
 *   against the sandboxed home directory (windows-env-var)
 * - "tavily_search is false when env var absent and no key file" — asserts absence
 *   against the sandboxed home — on Windows only USERPROFILE keeps a real key file
 *   from leaking in (windows-env-var)
 * - "detects Tavily Search from file-based key" — reads tavily_api_key from the
 *   sandboxed home directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "detects Ref Search from env var" — asserts REF_API_KEY detection resolved
 *   against the sandboxed home directory (windows-env-var)
 * - "ref_search is false when env var absent and no key file" — asserts absence
 *   against the sandboxed home — on Windows only USERPROFILE keeps a real key file
 *   from leaking in (windows-env-var)
 * - "detects Ref Search from file-based key" — reads ref_api_key from the sandboxed
 *   home directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "detects Perplexity from env var" — asserts PERPLEXITY_API_KEY detection resolved
 *   against the sandboxed home directory (windows-env-var)
 * - "perplexity is false when env var absent and no key file" — asserts absence
 *   against the sandboxed home — on Windows only USERPROFILE keeps a real key file
 *   from leaking in (windows-env-var)
 * - "detects Perplexity from file-based key" — reads perplexity_api_key from the
 *   sandboxed home directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "detects Jina from env var" — asserts JINA_API_KEY detection resolved against
 *   the sandboxed home directory (windows-env-var)
 * - "jina is false when env var absent and no key file" — asserts absence against
 *   the sandboxed home — on Windows only USERPROFILE keeps a real key file from
 *   leaking in (windows-env-var)
 * - "detects Jina from file-based key" — reads jina_api_key from the sandboxed home
 *   directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "merges user defaults from defaults.json" — reads defaults.json from the
 *   sandboxed home directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "merges nested workflow keys from defaults.json preserving unset keys" — same
 *   defaults.json read from the sandboxed home directory, resolved via USERPROFILE
 *   on Windows (windows-env-var)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ─── config-ensure-section (home-resolved API-key / defaults.json tests) ──────

describe('config-ensure-section command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('detects Brave Search from file-based key', () => {
    // runGsdTools sandboxes HOME=tmpDir, so brave_api_key is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'brave_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.brave_search, true);
  });

  test('detects Tavily Search from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, true);
  });

  test('tavily_search is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, false);
  });

  test('detects Tavily Search from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'tavily_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, true);
  });

  test('detects Ref Search from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, true);
  });

  test('ref_search is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, false);
  });

  test('detects Ref Search from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'ref_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, true);
  });

  test('detects Perplexity from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, true);
  });

  test('perplexity is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, false);
  });

  test('detects Perplexity from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'perplexity_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, true);
  });

  test('detects Jina from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, true);
  });

  test('jina is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, false);
  });

  test('detects Jina from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'jina_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, true);
  });

  test('merges user defaults from defaults.json', () => {
    // runGsdTools sandboxes HOME=tmpDir, so defaults.json is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({
      model_profile: 'quality',
      commit_docs: false,
    }), 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality', 'model_profile should be overridden');
    assert.strictEqual(config.commit_docs, false, 'commit_docs should be overridden');
    assert.ok(config.git && typeof config.git === 'object', 'git should be an object');
    assert.strictEqual(typeof config.git.branching_strategy, 'string', 'git.branching_strategy should be a string');
  });

  test('merges nested workflow keys from defaults.json preserving unset keys', () => {
    // runGsdTools sandboxes HOME=tmpDir, so defaults.json is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({
      workflow: { research: false },
    }), 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false, 'research should be overridden');
    assert.strictEqual(typeof config.workflow.plan_check, 'boolean', 'plan_check should be a boolean');
    assert.strictEqual(typeof config.workflow.verifier, 'boolean', 'verifier should be a boolean');
  });
});

