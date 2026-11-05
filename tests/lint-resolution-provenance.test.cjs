'use strict';

/**
 * Tests for scripts/lint-resolution-provenance.cjs — the registry-ratchet CI
 * guard that locks in configured_empty / not_configured contract tests for
 * every registered config-interpreting read verb (ADR-1411 P4 / #1417).
 *
 * Tests the PURE check logic (checkRegistry) directly, injecting fixture
 * content rather than shelling out, so the suite is fast and hermetic.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// Import the exported check function.
const { checkRegistry } = require('../scripts/lint-resolution-provenance.cjs');

/**
 * Run checkRegistry with synthetic content injected as testFileContent so
 * the test never reads from the real repo.  Returns { ok, failures }.
 *
 * @param {object} opts
 * @param {Array<{verb: string, sourceFile: string, testFile: string}>} opts.registry
 * @param {string[]} opts.allowlist
 * @param {string} opts.testFileContent  - text that represents the test file's content
 */
function runCheck({ registry, allowlist, testFileContent }) {
  const failures = [];
  const { ok } = checkRegistry({
    registry,
    allowlist,
    // Inject a content-reader so the test is I/O-free.
    readFile: (_filePath) => testFileContent,
    fail: (msg) => failures.push(msg),
  });
  return { ok, failures };
}

// ── suite ────────────────────────────────────────────────────────────────────

describe('lint-resolution-provenance: checkRegistry pure logic', () => {
  const BOTH_MARKERS = `
    test('configured_empty: agent_skills[X]=[] ...', () => {
      assert.strictEqual(ir.reason, 'configured_empty');
    });
    test('not_configured: agent not in map ...', () => {
      assert.strictEqual(ir.reason, 'not_configured');
    });
  `;

  const MISSING_CONFIGURED_EMPTY = `
    test('not_configured: agent not in map ...', () => {
      assert.strictEqual(ir.reason, 'not_configured');
    });
  `;

  const MISSING_NOT_CONFIGURED = `
    test('configured_empty: agent_skills[X]=[] ...', () => {
      assert.strictEqual(ir.reason, 'configured_empty');
    });
  `;

  const sampleVerb = { verb: 'agent-skills', sourceFile: 'src/init.cts', testFile: 'tests/agent-skills.test.cjs' };

  test('ok: registered verb whose test has both markers passes', () => {
    const { ok, failures } = runCheck({
      registry: [sampleVerb],
      allowlist: [],
      testFileContent: BOTH_MARKERS,
    });
    assert.strictEqual(failures.length, 0, `Unexpected failures: ${failures.join('\n')}`);
    assert.ok(ok);
  });

  test('fail: missing configured_empty marker → fails with actionable message', () => {
    const { ok, failures } = runCheck({
      registry: [sampleVerb],
      allowlist: [],
      testFileContent: MISSING_CONFIGURED_EMPTY,
    });
    assert.ok(!ok);
    assert.ok(failures.length > 0, 'Expected at least one failure');
    assert.match(failures.join('\n'), /configured_empty/);
    assert.match(failures.join('\n'), /agent-skills/);
  });

  test('fail: missing not_configured marker → fails with actionable message', () => {
    const { ok, failures } = runCheck({
      registry: [sampleVerb],
      allowlist: [],
      testFileContent: MISSING_NOT_CONFIGURED,
    });
    assert.ok(!ok);
    assert.ok(failures.length > 0, 'Expected at least one failure');
    assert.match(failures.join('\n'), /not_configured/);
    assert.match(failures.join('\n'), /agent-skills/);
  });

  test('fail: missing both markers → fails mentioning both', () => {
    const { ok, failures } = runCheck({
      registry: [sampleVerb],
      allowlist: [],
      testFileContent: '// no relevant markers here',
    });
    assert.ok(!ok);
    const msg = failures.join('\n');
    assert.match(msg, /configured_empty/);
    assert.match(msg, /not_configured/);
  });

  test('tolerated: allowlisted verb with missing markers is skipped', () => {
    const { ok, failures } = runCheck({
      registry: [sampleVerb],
      allowlist: ['agent-skills'],
      testFileContent: MISSING_CONFIGURED_EMPTY,
    });
    assert.strictEqual(failures.length, 0, `Unexpected failures: ${failures.join('\n')}`);
    assert.ok(ok);
  });

  test('fail: stale allowlist entry (verb now compliant) must be pruned', () => {
    const { ok, failures } = runCheck({
      registry: [sampleVerb],
      allowlist: ['agent-skills'],
      testFileContent: BOTH_MARKERS,
    });
    assert.ok(!ok);
    assert.match(failures.join('\n'), /agent-skills/);
    assert.match(failures.join('\n'), /stale|prune|no longer/i);
  });

  test('ok: empty registry always passes', () => {
    const { ok, failures } = runCheck({
      registry: [],
      allowlist: [],
      testFileContent: '',
    });
    assert.strictEqual(failures.length, 0);
    assert.ok(ok);
  });

  test('ok: multiple verbs all compliant passes', () => {
    const verb2 = { verb: 'config-read', sourceFile: 'src/config.cts', testFile: 'tests/config.test.cjs' };
    const { ok, failures } = runCheck({
      registry: [sampleVerb, verb2],
      allowlist: [],
      testFileContent: BOTH_MARKERS,
    });
    assert.strictEqual(failures.length, 0, `Unexpected failures: ${failures.join('\n')}`);
    assert.ok(ok);
  });
});

describe('lint-resolution-provenance: real repo baseline', () => {
  test('repo baseline passes (real registry vs real agent-skills.test.cjs)', () => {
    // Run the actual check against the real registry and real test file.
    // This is the regression lock: if agent-skills.test.cjs loses its markers
    // the guard catches it here too.
    const { checkRegistry: check, REGISTRY } = require('../scripts/lint-resolution-provenance.cjs');
    const failures = [];
    const { ok } = check({
      registry: REGISTRY,
      allowlist: [],
      readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
      fail: (msg) => failures.push(msg),
    });
    assert.strictEqual(
      failures.length,
      0,
      `Real repo baseline failed:\n${failures.join('\n')}`
    );
    assert.ok(ok);
  });
});
