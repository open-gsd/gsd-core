/**
 * Process contract of scripts/check-env.cjs (#117, #6375): exit codes, the
 * `--json` document on stdout, and which stream an error goes to.
 *
 * Each test spawns the real script. The child's PATH holds a stand-in `npm`
 * and no directory with the real one: a cold real npm on a Windows runner
 * outlasted the spawn limit and failed an unrelated PR (#6375). The stand-in
 * logs its arguments, and the tests read that log to prove it answered.
 *
 * The checks themselves are tested in-process in tests/check-env.test.cjs.
 */

'use strict';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { isolatedEnv, isolatedPath } = require('./helpers/isolated-env.cjs');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-env.cjs');
const ACTIVE_MAJOR = process.version.replace(/^v/, '').split('.')[0];

describe('check-env.cjs as a spawned process, with a stand-in npm on PATH', () => {
  let root;
  let npmLog;
  let env;
  let runs = 0;
  let nodeBinDir;
  const dirs = {};

  function project(name, { engines, packageJson = true }) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    if (packageJson) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', engines }));
      fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name, lockfileVersion: 3 }));
      fs.writeFileSync(path.join(dir, '.nvmrc'), `${ACTIVE_MAJOR}\n`);
    }
    dirs[name] = dir;
  }

  before(() => {
    root = createTempDir('gsd-check-env-proc-');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'npm'),
      '#!/bin/sh\necho "$*" >> "$CHECK_ENV_NPM_LOG"\nif [ "$1" = "--version" ]; then echo 11.0.0; fi\nexit 0\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, 'npm.cmd'),
      '@echo off\r\necho %*>> "%CHECK_ENV_NPM_LOG%"\r\nif "%1"=="--version" echo 11.0.0\r\nexit /b 0\r\n',
    );

    const hostPath = isolatedPath({ without: ['npm', 'npm.cmd'] });
    nodeBinDir = hostPath.nodeBinDir;
    env = isolatedEnv({
      home: root,
      path: `${bin}${path.delimiter}${hostPath.path}`,
      override: { CI: '' },
    });

    project('good', { engines: { node: '>=22.0.0', npm: '>=9.0.0' } });
    project('old-node-only', { engines: { node: '<14.0.0' } });
    project('no-package-json', { packageJson: false });
  });

  // A log of its own for each test, so a test reads only its own npm calls.
  beforeEach(() => {
    npmLog = path.join(root, `npm-calls-${++runs}.log`);
    env.CHECK_ENV_NPM_LOG = npmLog;
  });
  after(() => {
    if (nodeBinDir) cleanup(nodeBinDir);
    cleanup(root);
  });

  const run = (name, args = []) => runNode([SCRIPT, ...args], { cwd: dirs[name], env });
  const npmCalls = () => fs.readFileSync(npmLog, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  /** Every test that runs the checks ends with this: the stand-in, not a real npm, took both calls. */
  const assertStandInAnswered = () => assert.deepEqual(npmCalls(), ['--version', 'ci --dry-run --ignore-scripts']);

  test('exits 0 when every check passes', () => {
    const r = run('good');
    assert.equal(r.exitCode, 0, r.summary);
    assertStandInAnswered();
  });

  test('exits 1 when a check fails', () => {
    assert.equal(run('old-node-only').exitCode, 1);
    assertStandInAnswered();
  });

  test('--json prints one JSON document with pass and checks, and exits 0 on a pass', () => {
    const r = run('good', ['--json']);
    assert.equal(r.exitCode, 0, r.summary);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed), ['pass', 'checks']);
    assert.equal(parsed.pass, true);
    assert.deepEqual(
      parsed.checks.map((c) => [c.name, c.status]),
      [
        ['node-version', 'pass'],
        ['npm-version', 'pass'],
        ['lockfile-present', 'pass'],
        ['lockfile-sync', 'pass'],
        ['version-manager-pin', 'pass'],
      ],
    );
    for (const row of parsed.checks) assert.deepEqual(Object.keys(row), ['name', 'status', 'message']);
    assertStandInAnswered();
  });

  test('--json reports pass:false and exits 1 when a check fails', () => {
    const r = run('old-node-only', ['--json']);
    assert.equal(r.exitCode, 1, r.summary);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.pass, false);
    assert.equal(parsed.checks.find((c) => c.name === 'node-version').status, 'fail');
    assertStandInAnswered();
  });

  test('--help exits 0, writes to stdout only and does not call npm', () => {
    const r = run('good', ['--help']);
    assert.equal(r.exitCode, 0, r.summary);
    assert.ok(r.stdout.length > 0);
    assert.equal(r.stderr, '');
    assert.equal(fs.existsSync(npmLog), false);
  });

  test('an unknown option exits 2, writes to stderr only and does not call npm', () => {
    const r = run('good', ['--bogus']);
    assert.equal(r.exitCode, 2, r.summary);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.length > 0);
    assert.equal(fs.existsSync(npmLog), false);
  });

  test('a directory with no package.json exits 2, writes to stderr only and does not call npm', () => {
    const r = run('no-package-json');
    assert.equal(r.exitCode, 2, r.summary);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.length > 0);
    assert.equal(fs.existsSync(npmLog), false);
  });
});
