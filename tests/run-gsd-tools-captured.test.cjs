'use strict';

/**
 * #6334 (ADR-6315 item 16): `runGsdToolsCaptured` runs a command in this
 * process and returns what a process would have left behind: the exit code,
 * stdout and stderr, each as the command wrote it.
 *
 * `runGsdTools` cannot serve a test that asserts on stderr, because it keeps
 * stderr only for a failed command. Those tests used to spawn `node
 * gsd-tools.cjs` for it. This helper is what they call instead; that the
 * in-process result equals the spawned one, command by command, is held by
 * tests/cli-parity.process.test.cjs.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, runGsdToolsCaptured, createTempProject, cleanup } = require('./helpers.cjs');

describe('runGsdToolsCaptured (#6334)', () => {
  const made = [];
  afterEach(() => {
    while (made.length) cleanup(made.pop());
  });

  function project() {
    const dir = createTempProject();
    made.push(dir);
    return dir;
  }

  /** A STATE.md whose `Last session` value wraps onto a second line, so `state record-session` warns on stderr and still exits 0. */
  function seedWrappedSession(dir) {
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), [
      '---', 'gsd_state_version: 1.0', 'status: executing', '---', '',
      '# Project State', '', '## Session Continuity', '',
      'Last session: archived milestone v1.0 and moved its files',
      'to .planning/milestones/, all phase directories archived.',
      'Stopped at: Phase 2 complete',
      'Resume file: None', '',
    ].join('\n'));
  }

  test('returns stderr of a command that succeeds', () => {
    const dir = project();
    seedWrappedSession(dir);
    const result = runGsdToolsCaptured(['state', 'record-session', '--stopped-at', 'Phase 3 plan 1 done'], dir);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).updated, ['Stopped At']);
    assert.match(result.stderr, /left Last session unchanged/);
  });

  test('returns the exit code and stderr of a command that fails, without throwing', () => {
    const dir = project();
    const result = runGsdToolsCaptured(['state', 'no-such-subcommand'], dir);
    assert.notEqual(result.exitCode, 0);
    assert.notEqual(result.stderr, '');
  });

  test('returns the same stdout runGsdTools trims, untrimmed', () => {
    const dir = project();
    const captured = runGsdToolsCaptured(['config-get', 'model_profile', '--raw'], dir);
    const trimmed = runGsdTools(['config-get', 'model_profile', '--raw'], dir);
    assert.equal(captured.exitCode, 0, captured.stderr);
    assert.ok(captured.stdout.length > 0);
    assert.equal(captured.stdout.trim(), trimmed.output);
  });

  test('passes an environment override to the command', () => {
    const dir = project();
    const withHome = runGsdToolsCaptured(['config-get', 'model_profile', '--raw'], dir, { HOME: dir });
    assert.equal(withHome.exitCode, 0, withHome.stderr);
  });

  test('refuses a working directory that does not exist, and names the process helper', () => {
    const missing = path.join(project(), 'not-there');
    assert.throws(
      () => runGsdToolsCaptured(['state', 'load'], missing),
      /not a directory.*runGsdToolsProcess/s,
    );
  });
});
