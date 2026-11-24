'use strict';

/**
 * #6530 (part 1): `/gsd-quick resume <slug>` runs `gsd-tools query init.quick
 * --resume "<slug>"` as a shell command and stops on its exit status. These
 * cases spawn the real `gsd-tools` binary because the exit status of a real
 * process, through the `query` dispatch the command file uses, is what they
 * test. The input matrix runs in-process in tests/quick-resume.test.cjs.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdToolsProcess, createTempProject, cleanup } = require('./helpers.cjs');

function makeTask(dir, name) {
  const taskDir = path.join(dir, '.planning', 'quick', name);
  fs.mkdirSync(taskDir, { recursive: true });
  return taskDir;
}

describe('#6530 query init.quick --resume through the spawned gsd-tools binary', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-quick-resume-proc-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('process exits 0 and prints the task\'s own ids when exactly one task matches', () => {
    makeTask(tmpDir, '260101-abc-fix-login');
    const r = runGsdToolsProcess(['query', 'init.quick', '--resume', 'fix-login'], tmpDir);
    assert.equal(r.exitCode, 0, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out.quick_id, '260101-abc');
    assert.equal(out.slug, 'fix-login');
    // The child's cwd may resolve through a symlinked temp root, so compare the task's own directory name.
    assert.equal(path.posix.basename(out.task_dir), '260101-abc-fix-login');
  });

  test('process exits 1 with the ambiguity reason and every candidate when two tasks match', () => {
    makeTask(tmpDir, '260101-abc-fix-login');
    makeTask(tmpDir, '20250101-fix-login');
    const r = runGsdToolsProcess(['query', 'init.quick', '--resume', 'fix-login', '--json-errors'], tmpDir);
    assert.equal(r.exitCode, 1);
    const err = JSON.parse(r.error.trim().split('\n').pop());
    assert.equal(err.reason, 'quick_resume_ambiguous');
    assert.deepEqual(err.matches, ['20250101-fix-login', '260101-abc-fix-login']);
  });

  test('process exits 1 with the not-found reason when no task has the slug', () => {
    const r = runGsdToolsProcess(['query', 'init.quick', '--resume', 'fix-login', '--json-errors'], tmpDir);
    assert.equal(r.exitCode, 1);
    assert.equal(JSON.parse(r.error.trim().split('\n').pop()).reason, 'quick_resume_not_found');
  });
});
