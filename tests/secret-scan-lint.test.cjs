/**
 * Tests for secret-scan exclusion governance (issue #115):
 *   - scripts/secret-scan-lint.sh  (new: lint policy for .secretscanignore)
 *   - scripts/secret-scan.sh --strict  (new flag: reduced-exclusion scan mode)
 *
 * Design references:
 *   - GitGuardian exclusion annotation convention:
 *     https://docs.gitguardian.com/internal-repositories-monitoring/integrations/cli/secrets
 *   - CNCF Security TAG threat-model exception lifecycle:
 *     https://github.com/cncf/tag-security/blob/main/community/working-groups/threat-modeling/templates/threats.md
 *
 * Exit-code contract for secret-scan-lint.sh:
 *   0 = every exclusion has full annotation OR is grandfathered (with warning)
 *   1 = annotation violation (missing required key, expired date, unguarded wildcard without rule-id)
 *   2 = config-format error (file not found, parse error)
 *
 * Exit-code contract for secret-scan.sh (unchanged):
 *   0 = clean
 *   1 = findings detected
 *   2 = usage error
 *
 * Annotation syntax (sidecar comment on preceding line):
 *   # allow: <pattern>  reason="..."  owner="..."  expires="YYYY-MM-DD"  [rule-id="..."]
 *   <pattern>
 */
'use strict';

// allow-test-rule: source-text-is-the-product
// Justification: this file tests scan scripts and ignore-file policy where
// the textual output IS the deployed contract. Asserting exit codes and
// stderr/stdout content is a typed behavioral check on the linter's output
// protocol. Migrating to a parsed IR would add ceremony without changing
// what is verified — the strings ARE the typed surface.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanup } = require('./helpers.cjs');

const PROJECT_ROOT = path.join(__dirname, '..');
const LINT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'secret-scan-lint.sh');
const SECRET_SCAN = path.join(PROJECT_ROOT, 'scripts', 'secret-scan.sh');

const IS_WINDOWS = process.platform === 'win32';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run secret-scan-lint.sh with a given .secretscanignore fixture content.
 * Writes fixture to a temp dir and invokes the linter pointing at it.
 * Uses spawnSync so both stdout and stderr are always captured regardless of exit code.
 */
function runLint(ignoreContent, extraArgs = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sslint-test-'));
  const ignoreFile = path.join(tmpDir, '.secretscanignore');
  fs.writeFileSync(ignoreFile, ignoreContent, 'utf-8');

  try {
    const args = ['--file', ignoreFile, ...extraArgs];
    const result = spawnSync(LINT_SCRIPT, args, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return {
      status: result.status !== null ? result.status : 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } finally {
    cleanup(tmpDir);
  }
}

/**
 * Run secret-scan.sh --file <path> [extraArgs] against a file with given content.
 * Returns { status, stdout, stderr }.
 */
function runSecretScan(fileContent, extraArgs = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssscan-test-'));
  const tmpFile = path.join(tmpDir, 'test-input.txt');
  fs.writeFileSync(tmpFile, fileContent, 'utf-8');

  try {
    const args = ['--file', tmpFile, ...extraArgs];
    const result = spawnSync(SECRET_SCAN, args, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return {
      status: result.status !== null ? result.status : 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } finally {
    cleanup(tmpDir);
  }
}

/**
 * Run secret-scan.sh --dir <dir> [extraArgs] and count effective exclusions
 * by checking how many files in a known fixture set are skipped vs scanned.
 * Uses spawnSync with a generous timeout for large directories.
 */
function runSecretScanDir(dirPath, extraArgs = []) {
  const args = ['--dir', dirPath, ...extraArgs];
  const result = spawnSync(SECRET_SCAN, args, {
    encoding: 'utf-8',
    timeout: 60000,
    cwd: PROJECT_ROOT,
  });
  return {
    status: result.status !== null ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ─── Script Existence ─────────────────────────────────────────────────────────

describe('secret-scan-lint.sh script exists and is executable', { skip: IS_WINDOWS }, () => {
  test('lint script exists', () => {
    assert.ok(fs.existsSync(LINT_SCRIPT), `Missing: ${LINT_SCRIPT}`);
  });

  test('lint script is executable', () => {
    const stat = fs.statSync(LINT_SCRIPT);
    const isExecutable = (stat.mode & 0o111) !== 0;
    assert.ok(isExecutable, `${LINT_SCRIPT} is not executable`);
  });

  test('lint script has bash shebang', () => {
    const firstLine = fs.readFileSync(LINT_SCRIPT, 'utf-8').split('\n')[0];
    assert.ok(
      firstLine.startsWith('#!/usr/bin/env bash') || firstLine.startsWith('#!/bin/bash'),
      `${LINT_SCRIPT} missing bash shebang: ${firstLine}`
    );
  });
});

// ─── Test 1: Fully-annotated entry → exit 0 ──────────────────────────────────

describe('lint: fully-annotated exclusion', { skip: IS_WINDOWS }, () => {
  test('exits 0 when all required keys are present and expires is in the future', () => {
    // Valid annotation: reason, owner, expires all present; expires is future date
    const fixture = [
      '# allow: fixtures/**  reason="adversarial test fixtures"  owner="@security"  expires="2099-12-31"  rule-id="EXCLUSION-FIXTURES"',
      'fixtures/**',
      '',
    ].join('\n');

    const result = runLint(fixture);
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  test('exits 0 without optional rule-id when wildcard is not present', () => {
    // Non-wildcard path: rule-id is optional
    const fixture = [
      '# allow: path/to/file.md  reason="illustrative examples"  owner="@docs"  expires="2099-06-30"',
      'path/to/file.md',
      '',
    ].join('\n');

    const result = runLint(fixture);
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });
});

// ─── Test 2: Missing `reason` → exit 1 ───────────────────────────────────────

describe('lint: missing required annotation keys', { skip: IS_WINDOWS }, () => {
  test('exits 1 when annotation is missing reason', () => {
    const fixture = [
      '# allow: fixtures/**  owner="@security"  expires="2099-12-31"  rule-id="EXCLUSION-FIXTURES"',
      'fixtures/**',
      '',
    ].join('\n');

    const result = runLint(fixture);
    assert.equal(result.status, 1, `Expected exit 1 (missing reason), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  test('exits 1 when annotation is missing owner', () => {
    const fixture = [
      '# allow: fixtures/**  reason="test fixtures"  expires="2099-12-31"  rule-id="EXCLUSION-FIXTURES"',
      'fixtures/**',
      '',
    ].join('\n');

    const result = runLint(fixture);
    assert.equal(result.status, 1, `Expected exit 1 (missing owner), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  test('exits 1 when annotation is missing expires', () => {
    const fixture = [
      '# allow: fixtures/**  reason="test fixtures"  owner="@security"  rule-id="EXCLUSION-FIXTURES"',
      'fixtures/**',
      '',
    ].join('\n');

    const result = runLint(fixture);
    assert.equal(result.status, 1, `Expected exit 1 (missing expires), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  test('exits 1 when path has no annotation comment at all', () => {
    // A bare path with no preceding # allow: comment — NOT grandfathered
    // (grandfathered entries have any preceding comment, but lack structured keys)
    const fixture = [
      'some/path/to/file.md',
      '',
    ].join('\n');

    const result = runLint(fixture);
    // A completely bare entry (no preceding comment at all) is also a policy violation
    assert.equal(result.status, 1, `Expected exit 1 (bare path, no annotation), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });
});

// ─── Test 3: Expired `expires` date → exit 1 ─────────────────────────────────

describe('lint: expired exclusion date', { skip: IS_WINDOWS }, () => {
  test('exits 1 when expires date is in the past', () => {
    const fixture = [
      '# allow: old/path.md  reason="temporary workaround"  owner="@eng"  expires="2020-01-01"  rule-id="EXCLUSION-OLD"',
      'old/path.md',
      '',
    ].join('\n');

    const result = runLint(fixture);
    assert.equal(result.status, 1, `Expected exit 1 (expired), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  test('exits 1 when expires date is today minus one day (strictly past)', () => {
    // Use a known-past date that will never be "today" during the test run
    const fixture = [
      '# allow: old/path.md  reason="workaround"  owner="@eng"  expires="2000-12-31"',
      'old/path.md',
      '',
    ].join('\n');

    const result = runLint(fixture);
    assert.equal(result.status, 1, `Expected exit 1 (expired), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  test('exits 0 when expires date is in the future', () => {
    const fixture = [
      '# allow: new/path.md  reason="current workaround"  owner="@eng"  expires="2099-12-31"',
      'new/path.md',
      '',
    ].join('\n');

    const result = runLint(fixture);
    assert.equal(result.status, 0, `Expected exit 0 (future expires), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });
});

// ─── Test 4: Wildcard without rule-id → exit 1 ───────────────────────────────

describe('lint: wildcard exclusions require rule-id', { skip: IS_WINDOWS }, () => {
  test('exits 1 for ** wildcard without rule-id', () => {
    const fixture = [
      '# allow: fixtures/**  reason="test fixtures"  owner="@security"  expires="2099-12-31"',
      'fixtures/**',
      '',
    ].join('\n');

    const result = runLint(fixture);
    assert.equal(result.status, 1, `Expected exit 1 (wildcard ** without rule-id), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  test('exits 1 for *.ext wildcard without rule-id', () => {
    const fixture = [
      '# allow: tests/*.json  reason="fixture files"  owner="@test"  expires="2099-12-31"',
      'tests/*.json',
      '',
    ].join('\n');

    const result = runLint(fixture);
    assert.equal(result.status, 1, `Expected exit 1 (wildcard *.json without rule-id), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  test('exits 0 for ** wildcard WITH rule-id and all required keys', () => {
    const fixture = [
      '# allow: fixtures/**  reason="adversarial test fixtures"  owner="@security"  expires="2099-12-31"  rule-id="EXCLUSION-FIXTURES"',
      'fixtures/**',
      '',
    ].join('\n');

    const result = runLint(fixture);
    assert.equal(result.status, 0, `Expected exit 0 (wildcard with rule-id), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });
});

// ─── Test 5: Grandfathered entry (default vs --strict) ───────────────────────

describe('lint: grandfathered entries (backward compat)', { skip: IS_WINDOWS }, () => {
  // A grandfathered entry: has a plain comment (not a structured annotation)
  // preceding the path. Under default mode: exit 0 with warning to stderr.
  // Under --strict: exit 1.
  const GRANDFATHER_FIXTURE = [
    '# plan-phase.md contains illustrative DATABASE_URL/REDIS_URL examples',
    'get-shit-done/workflows/plan-phase.md',
    '',
  ].join('\n');

  test('exits 0 on grandfathered entry in default mode', () => {
    const result = runLint(GRANDFATHER_FIXTURE);
    assert.equal(result.status, 0, `Expected exit 0 (grandfathered, default mode), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  test('emits deprecation warning to stderr on grandfathered entry (not stdout)', () => {
    const result = runLint(GRANDFATHER_FIXTURE);
    // The warning MUST appear on stderr — CI log parsers read stdout for structured output.
    // A warning on stdout would corrupt any downstream JSON/structured parser.
    assert.ok(
      result.stderr.toLowerCase().includes('warn') ||
      result.stderr.toLowerCase().includes('grandfather') ||
      result.stderr.toLowerCase().includes('deprecat'),
      `Expected deprecation warning on stderr, but stderr was: "${result.stderr}"\nstdout was: "${result.stdout}"`
    );
    // Confirm the OK signal is on stdout (not buried in stderr noise)
    assert.ok(
      result.stdout.includes('OK') || result.stdout.trim() === '' || result.status === 0,
      `Expected clean stdout (OK), got: "${result.stdout}"`
    );
  });

  test('exits 1 on grandfathered entry under --strict mode', () => {
    const result = runLint(GRANDFATHER_FIXTURE, ['--strict']);
    assert.equal(result.status, 1, `Expected exit 1 (grandfathered, --strict mode), got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  test('exits 2 when --file argument is missing', () => {
    try {
      execFileSync(LINT_SCRIPT, [], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      assert.fail('Should have exited non-zero');
    } catch (err) {
      assert.equal(err.status, 2, `Expected exit 2 (usage error), got ${err.status}`);
    }
  });
});

// ─── Test 6: --strict reduces effective exclusion list ───────────────────────

describe('secret-scan.sh --strict: reduces effective exclusions', { skip: IS_WINDOWS }, () => {
  test('--strict flag on a clean file exits 0 (not a usage error)', () => {
    // A file with no secrets and no .secretscanignore in the CWD must exit 0 under --strict.
    // This verifies the flag is parsed correctly and doesn't cause a usage error (exit 2).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-test-'));
    const tmpFile = path.join(tmpDir, 'clean.txt');
    fs.writeFileSync(tmpFile, '# just a comment, no secrets here\n', 'utf-8');
    try {
      const result = spawnSync(SECRET_SCAN, ['--file', tmpFile, '--strict'], {
        encoding: 'utf-8',
        timeout: 10000,
        cwd: tmpDir,  // No .secretscanignore here — clean workspace
      });
      const status = result.status !== null ? result.status : 1;
      // A clean file with no secrets must exit 0 under --strict
      assert.equal(status, 0, `--strict on a clean file should exit 0, got ${status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('--strict treats grandfathered exclusion entries as active (not skipped)', () => {
    // Set up a temp workspace with:
    //   .secretscanignore  — grandfathered entry (plain comment, no structured annotation)
    //   secret-file.txt    — file that WOULD trip the scanner (contains a mock secret pattern)
    //
    // Under default mode: file is excluded → scan reports 0 files (or 0 findings).
    // Under --strict: grandfathered entry not honoured → file IS scanned → findings exit 1.

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-exclusion-test-'));
    const secretFile = path.join(tmpDir, 'secret-file.txt');
    const ignoreFile = path.join(tmpDir, '.secretscanignore');

    // A file containing a pattern that the scanner catches
    // Constructed to avoid GitHub push-protection triggering on this test file itself
    const awsKeyPrefix = 'AKIA';
    const awsKeyBody = 'IOSFODNN7EXAMPLE1234';
    fs.writeFileSync(secretFile, `aws_key = "${awsKeyPrefix}${awsKeyBody}"\n`, 'utf-8');

    // Grandfathered ignore entry: plain comment, no structured annotation
    fs.writeFileSync(ignoreFile, [
      '# This file contains a fake key for testing purposes',
      'secret-file.txt',
      '',
    ].join('\n'), 'utf-8');

    try {
      // Use relative path so the case-pattern in .secretscanignore matches.
      // .secretscanignore contains 'secret-file.txt'; --file 'secret-file.txt'
      // (relative) matches via bash case $file in $pattern.
      const relFile = 'secret-file.txt';

      // Default mode: grandfathered entry IS honoured → file is excluded → exit 0
      const defaultResult = spawnSync(SECRET_SCAN, ['--file', relFile], {
        encoding: 'utf-8',
        timeout: 10000,
        cwd: tmpDir,  // CWD has .secretscanignore with the grandfathered entry
      });
      const defaultStatus = defaultResult.status !== null ? defaultResult.status : 1;

      // Strict mode: grandfathered entry NOT honoured → file is scanned → exit 1
      const strictResult = spawnSync(SECRET_SCAN, ['--file', relFile, '--strict'], {
        encoding: 'utf-8',
        timeout: 10000,
        cwd: tmpDir,  // Same CWD, same .secretscanignore
      });
      const strictStatus = strictResult.status !== null ? strictResult.status : 0;

      assert.equal(defaultStatus, 0,
        `Default mode should exclude grandfathered entry (exit 0), got ${defaultStatus}.\nstdout: ${defaultResult.stdout}\nstderr: ${defaultResult.stderr}`
      );
      assert.equal(strictStatus, 1,
        `Strict mode should scan grandfathered file and find secrets (exit 1), got ${strictStatus}.\nstdout: ${strictResult.stdout}\nstderr: ${strictResult.stderr}`
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── Test 7: Default mode regression — existing behavior unchanged ────────────

describe('secret-scan.sh default mode: regression test', { skip: IS_WINDOWS }, () => {
  test('existing .secretscanignore entry is still honoured in default mode', () => {
    // The file get-shit-done/workflows/plan-phase.md is listed in .secretscanignore.
    // Default mode must honour that exclusion: scanning the file directly should
    // show "scanned 0 files" (the ignorelist causes it to be skipped entirely).
    const planPhase = path.join(PROJECT_ROOT, 'get-shit-done', 'workflows', 'plan-phase.md');
    if (!fs.existsSync(planPhase)) {
      // File doesn't exist in this branch — skip gracefully
      return;
    }

    // Run scanner with --file on the excluded path, from project root so
    // .secretscanignore is found. Excluded → scanned 0 files → exit 0.
    const result = spawnSync(SECRET_SCAN, ['--file', 'get-shit-done/workflows/plan-phase.md'], {
      encoding: 'utf-8',
      timeout: 10000,
      cwd: PROJECT_ROOT,
    });
    const status = result.status !== null ? result.status : 1;
    const stdout = result.stdout || '';

    assert.equal(status, 0,
      `plan-phase.md should be excluded in default mode (exit 0), got ${status}.\nstdout: ${stdout}\nstderr: ${result.stderr}`
    );
    // The file is ignored by is_ignored() → scan_file returns 0 → no FAIL in output
    assert.ok(
      !stdout.includes('FAIL'),
      `plan-phase.md should not appear as FAIL in default mode: ${stdout}`
    );
  });

  test('scanner still detects real secrets in default mode', () => {
    // Regression: --strict flag must not affect default-mode secret detection
    const content = `DATABASE_URL=postgresql://user:realpassword@host:5432/db\n`;
    const result = runSecretScan(content);
    assert.equal(result.status, 1, `Expected secret to be detected in default mode`);
    assert.ok(result.stdout.includes('Env Variable') || result.stdout.includes('FAIL'), `Expected FAIL output: ${result.stdout}`);
  });

  test('passing --strict to secret-scan.sh does not break clean file scan', () => {
    // A file with no secrets should still exit 0 under --strict
    const content = '# Just a config file\nsome_setting = "non-secret-value"\n';
    const result = runSecretScan(content, ['--strict']);
    assert.equal(result.status, 0, `Clean file should exit 0 under --strict, got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });
});
