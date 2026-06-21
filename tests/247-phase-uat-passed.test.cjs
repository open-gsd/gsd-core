'use strict';

/**
 * Integration tests for `phase uat-passed <N>` CLI command.
 * Issue #247 — phase uat-passed predicate
 *
 * Tests the full dispatch path: gsd-tools → phase-command-router → phase.cmdPhaseUatPassed
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Set up a minimal project with a phase directory and ROADMAP so that
 * findPhaseInternal(cwd, phaseNum) can resolve it.
 * Returns { tmpDir, phaseDir }.
 */
function setupProject(phaseSlug = '01-feature') {
  const tmpDir = createTempProject();
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '- [ ] Phase 1: Feature',
      '',
      '### Phase 1: Feature',
      '**Goal:** Build feature',
      '**Plans:** 1 plans',
      '',
    ].join('\n'),
  );
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  return { tmpDir, phaseDir };
}

function writeUatFile(phaseDir, filename, content) {
  fs.writeFileSync(path.join(phaseDir, filename), content, 'utf-8');
}

function setMtime(filePath, time) {
  fs.utimesSync(filePath, time, time);
}

function makePassingUat() {
  return [
    '---',
    'status: passed',
    '---',
    '',
    '# UAT Results',
    '',
    '### 1. Login works',
    'expected: User logs in successfully',
    'result: passed',
    '',
  ].join('\n');
}

function makePendingUat() {
  return [
    '---',
    'status: partial',
    '---',
    '',
    '# UAT Results',
    '',
    '### 1. Login works',
    'expected: User logs in successfully',
    'result: passed',
    '',
    '### 2. Logout works',
    'expected: User logs out successfully',
    'result: pending',
    '',
  ].join('\n');
}

function makeFencedFalsePositiveUat() {
  // Only "result: passed" lines are inside a fenced block.
  // The real test has result: pending → should evaluate to passed:false.
  return [
    '---',
    'status: partial',
    '---',
    '',
    '# UAT Results',
    '',
    '## Example (do not run)',
    '```',
    '### 1. Test',
    'expected: Example',
    'result: passed',
    '```',
    '',
    '### 1. Real Test',
    'expected: The thing works',
    'result: pending',
    '',
  ].join('\n');
}

// ─── Basic pass/fail cases ─────────────────────────────────────────────────────

describe('phase uat-passed — basic pass/fail', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    ({ tmpDir, phaseDir } = setupProject('01-feature'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('passing UAT → passed:true with correct JSON shape', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePassingUat());
    const result = runGsdTools('phase uat-passed 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, true);
    assert.strictEqual(out.phase, '1');
    assert.ok(Array.isArray(out.uat_files), 'uat_files must be an array');
    assert.ok(Array.isArray(out.verification_files), 'verification_files must be an array');
    assert.ok(Array.isArray(out.checks), 'checks must be an array');
    assert.ok(Array.isArray(out.blockers), 'blockers must be an array');
    assert.ok(out.policy && typeof out.policy.require_verification === 'boolean',
      'policy.require_verification must be a boolean');
    assert.strictEqual(typeof out.no_uat_artifacts, 'boolean', 'no_uat_artifacts must be a boolean');
    assert.strictEqual(out.no_uat_artifacts, false, 'no_uat_artifacts must be false when checks exist');
    assert.strictEqual(out.blockers.length, 0);
  });

  test('pending UAT → passed:false', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePendingUat());
    const result = runGsdTools('phase uat-passed 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false);
    assert.strictEqual(out.phase, '1');
    assert.ok(out.blockers.length > 0, 'Should have blockers for pending test');
  });

  test('false-positive only (fenced block) → passed:false', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makeFencedFalsePositiveUat());
    const result = runGsdTools('phase uat-passed 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false,
      'result:passed inside a fenced block must not flip the predicate to passed');
  });

  test('no UAT files → passed:false + no_uat_artifacts:true (fail-closed, no vacuous pass)', () => {
    // Phase directory exists but has no UAT files — fail-closed: absence is NOT a pass
    const result = runGsdTools('phase uat-passed 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false,
      'Phase with no UAT files must NOT vacuously pass — fail-closed predicate');
    assert.strictEqual(out.no_uat_artifacts, true,
      'no_uat_artifacts must be true when no UAT items found');
    assert.deepStrictEqual(out.uat_files, []);
  });
});

// ─── --require-verification flag ──────────────────────────────────────────────

describe('phase uat-passed — --require-verification flag', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    ({ tmpDir, phaseDir } = setupProject('01-feature'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('--require-verification with no verification file → passed:false', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePassingUat());
    const result = runGsdTools('phase uat-passed 1 --require-verification', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false,
      'require-verification with no verification file should fail');
    assert.strictEqual(out.policy.require_verification, true);
    assert.ok(out.blockers.some(b => /verification required/i.test(b)),
      `Expected verification-required blocker, got: ${JSON.stringify(out.blockers)}`);
  });

  test('--require-verification with passing verification → passed:true', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePassingUat());
    writeUatFile(phaseDir, 'feature-VERIFICATION.md', '---\nstatus: passed\n---\n\nVerified OK.');
    const result = runGsdTools('phase uat-passed 1 --require-verification', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, true);
    assert.strictEqual(out.policy.require_verification, true);
  });

  test('--require-verification with stale passed verification → passed:false', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePassingUat());
    const verificationPath = path.join(phaseDir, 'feature-VERIFICATION.md');
    const summaryPath = path.join(phaseDir, 'feature-SUMMARY.md');
    writeUatFile(phaseDir, 'feature-VERIFICATION.md', '---\nstatus: passed\n---\n\nVerified OK.');
    writeUatFile(phaseDir, 'feature-SUMMARY.md', '# Summary\n\nImplementation changed after verification.\n');
    const now = new Date();
    setMtime(verificationPath, new Date(now.getTime() - 60_000));
    setMtime(summaryPath, now);

    const result = runGsdTools('phase uat-passed 1 --require-verification', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false);
    assert.ok(
      out.blockers.some(b => /verification status=stale/i.test(b)),
      `Expected stale-verification blocker, got: ${JSON.stringify(out.blockers)}`,
    );
  });

  test('--require-verification with non-canonical complete verification → passed:false', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePassingUat());
    writeUatFile(phaseDir, 'feature-VERIFICATION.md', '---\nstatus: complete\n---\n\nLegacy OK.');
    const result = runGsdTools('phase uat-passed 1 --require-verification', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false);
    assert.ok(out.blockers.some(b => /verification required/i.test(b)),
      `Expected verification-required blocker, got: ${JSON.stringify(out.blockers)}`);
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('phase uat-passed — error cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Write a minimal ROADMAP so phase 1 exists
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '### Phase 1: Feature',
        '**Goal:** Build feature',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-feature'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing phase number → error message', () => {
    const result = runGsdTools('phase uat-passed', tmpDir);
    assert.ok(!result.success, 'Should fail with no phase number');
    assert.ok(
      result.error.includes('phase number required') ||
      result.error.includes('Available:'),
      `Expected phase-number-required error, got: ${result.error}`,
    );
  });

  test('unknown phase number → error message', () => {
    const result = runGsdTools('phase uat-passed 99', tmpDir);
    assert.ok(!result.success, 'Should fail for unknown phase');
    assert.ok(
      result.error.includes('not found') || result.error.includes('99'),
      `Expected not-found error, got: ${result.error}`,
    );
  });

  test('unknown flag (typo --require-verifcation) → InvalidArgs error, not silent pass', () => {
    const result = runGsdTools('phase uat-passed 1 --require-verifcation', tmpDir);
    assert.ok(!result.success,
      'Unknown flag must cause an error, not silently pass');
    assert.ok(
      result.error.includes('--require-verifcation') ||
      result.error.includes('does not support') ||
      result.error.includes('invalid'),
      `Expected unknown-flag error, got: ${result.error}`,
    );
  });
});
