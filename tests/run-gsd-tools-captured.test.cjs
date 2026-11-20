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
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Unknown state subcommand: "no-such-subcommand"/);
    assert.equal(result.stdout, '');
  });

  test('returns the same stdout runGsdTools trims, untrimmed', () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ model_profile: 'balanced' }));
    const captured = runGsdToolsCaptured(['config-get', 'model_profile', '--raw'], dir);
    const trimmed = runGsdTools(['config-get', 'model_profile', '--raw'], dir);
    assert.equal(captured.exitCode, 0, captured.stderr);
    assert.equal(captured.stdout.trim(), 'balanced');
    assert.equal(captured.stdout.trim(), trimmed.output);
  });

  test('passes an environment override to the command', () => {
    const dir = project();
    const state = (status) => `---\ngsd_state_version: 1.0\nstatus: ${status}\n---\n# State\n`;
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}\n');
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), state('executing'));
    const workstream = path.join(dir, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(workstream, { recursive: true });
    fs.writeFileSync(path.join(workstream, 'config.json'), '{}\n');
    fs.writeFileSync(path.join(workstream, 'STATE.md'), state('paused'));

    const scoped = runGsdToolsCaptured(['state', 'json'], dir, { GSD_WORKSTREAM: 'alpha' });
    const root = runGsdToolsCaptured(['state', 'json'], dir);
    assert.equal(JSON.parse(scoped.stdout).status, 'paused');
    assert.equal(JSON.parse(root.stdout).status, 'executing');
  });

  test('refuses a working directory that does not exist, and names the process helper', () => {
    const missing = path.join(project(), 'not-there');
    assert.throws(
      () => runGsdToolsCaptured(['state', 'load'], missing),
      /not a directory.*runGsdToolsProcess/s,
    );
  });
});
