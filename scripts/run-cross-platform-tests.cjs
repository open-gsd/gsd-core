'use strict';

const { spawnSync } = require('child_process');

const CROSS_PLATFORM_TEST_REASON = Object.freeze({
  PASS: 'pass',
  TEST_FAILURE: 'test_failure',
  INFRA_FAILURE: 'infra_failure',
  UNKNOWN_FAILURE: 'unknown_failure',
});

function classify(exitCode, output) {
  if (exitCode === 0) return CROSS_PLATFORM_TEST_REASON.PASS;
  if (exitCode === 2 || /infrastructure failure|worktree\.Construct/i.test(output)) {
    return CROSS_PLATFORM_TEST_REASON.INFRA_FAILURE;
  }
  if (/\bFAIL\b|\d+\s+failures?\)/i.test(output)) {
    return CROSS_PLATFORM_TEST_REASON.TEST_FAILURE;
  }
  return CROSS_PLATFORM_TEST_REASON.UNKNOWN_FAILURE;
}

function runCrossPlatformTests(options = {}, deps = {}) {
  const {
    base = 'next',
    head = 'HEAD',
    source = '.',
    targets = 'linux,macos',
    cwd = process.cwd(),
  } = options;
  const runner = deps.spawnSync || spawnSync;

  const args = ['--targets', targets, '--base', base, '--head', head, '--source', source];
  const result = runner('gsd-test', args, { cwd, encoding: 'utf8' });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const output = `${stdout}\n${stderr}`;
  const exitCode = Number(result.status ?? 1);
  const reason = classify(exitCode, output);

  return {
    ok: exitCode === 0,
    reason,
    exitCode,
    command: ['gsd-test', ...args].join(' '),
    stdout,
    stderr,
  };
}

if (require.main === module) {
  const result = runCrossPlatformTests();
  const line = `[cross-platform-tests] reason=${result.reason} exit=${result.exitCode}`;
  if (result.ok) {
    process.stdout.write(`${line}\n`);
    process.exit(0);
  }
  process.stderr.write(`${line}\n`);
  process.exit(result.exitCode);
}

module.exports = { CROSS_PLATFORM_TEST_REASON, runCrossPlatformTests };
