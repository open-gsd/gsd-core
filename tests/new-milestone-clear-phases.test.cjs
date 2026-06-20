/**
 * GSD Tools Tests - New Milestone Clear Phases (#1588, #1447)
 *
 * Verifies that `phases clear` removes all phase subdirectories from
 * .planning/phases/, leaving the directory itself intact.
 *
 * Also covers the #1447 uncommitted-changes guard: phases clear must refuse
 * to delete phase directories that contain uncommitted work.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, createTempGitProject, cleanup } = require('./helpers.cjs');

describe('phases clear command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('clears all phase subdirectories from .planning/phases/', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');

    // Simulate phases left over from a previous milestone
    const phase1 = path.join(phasesDir, '01-foundation');
    const phase2 = path.join(phasesDir, '02-api');
    const phase3 = path.join(phasesDir, '03-ui');
    fs.mkdirSync(phase1, { recursive: true });
    fs.mkdirSync(phase2, { recursive: true });
    fs.mkdirSync(phase3, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase2, '02-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 3, 'should report 3 directories cleared');

    // phases/ directory itself must still exist
    assert.ok(fs.existsSync(phasesDir), '.planning/phases/ directory should still exist');

    // all subdirectories must be gone
    const remaining = fs.readdirSync(phasesDir, { withFileTypes: true })
      .filter(e => e.isDirectory());
    assert.strictEqual(remaining.length, 0, 'no phase subdirectories should remain');
  });

  test('succeeds with cleared=0 when phases directory is already empty', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    // createTempProject creates the directory but leaves it empty

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 0, 'should report 0 cleared when already empty');
    assert.ok(fs.existsSync(phasesDir), '.planning/phases/ directory should still exist');
  });

  test('succeeds with cleared=0 when phases directory does not exist', () => {
    // Remove the phases directory entirely
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-test removal to simulate absent phases dir (SUT behavior, not teardown)
    fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 0, 'should report 0 cleared when directory absent');
  });

  test('does not remove files (only directories) at the phases root', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');

    // Put a stray file directly in phases/ (edge case)
    fs.writeFileSync(path.join(phasesDir, 'README.md'), '# Phases');

    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 1, 'should report 1 directory cleared (not the file)');

    // File must survive
    assert.ok(
      fs.existsSync(path.join(phasesDir, 'README.md')),
      'files at phases root should be preserved'
    );
  });

  test('clears nested phase content (recursive delete)', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    const nested = path.join(phase1, 'subdir');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'deep-file.md'), '# Deep');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(!fs.existsSync(phase1), 'phase directory including nested content should be removed');
  });
});

// ─── #1447: uncommitted-changes guard ───────────────────────────────────────

describe('phases clear: uncommitted-changes guard (#1447)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('aborts with error when phase dirs contain uncommitted files', () => {
    // Add a phase directory with an untracked (uncommitted) file
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, 'PLAN.md'), '# Plan (uncommitted)');
    // Do NOT commit — leave as untracked/uncommitted changes

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(!result.success, 'phases clear should fail when uncommitted changes exist');
    assert.ok(
      result.error.includes('uncommitted') || result.error.includes('aborted'),
      `expected error about uncommitted changes, got: ${result.error}`
    );
    // Phase directory must still exist (was not deleted)
    assert.ok(fs.existsSync(phase1), 'phase directory must survive when guard fires');
  });

  test('aborts when phase dirs have staged but uncommitted changes', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, 'PLAN.md'), '# Plan (staged)');
    // Stage the file but do not commit
    execSync('git add .planning/phases/', { cwd: tmpDir, stdio: 'pipe' });

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(!result.success, 'phases clear should fail when staged-but-uncommitted changes exist');
    assert.ok(
      result.error.includes('uncommitted') || result.error.includes('aborted'),
      `expected error about uncommitted changes, got: ${result.error}`
    );
    assert.ok(fs.existsSync(phase1), 'phase directory must survive when guard fires');
  });

  test('--force bypasses the uncommitted-changes guard and deletes anyway', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, 'PLAN.md'), '# Plan (uncommitted)');
    // Do NOT commit

    const result = runGsdTools('phases clear --confirm --force', tmpDir);
    assert.ok(result.success, `--force should bypass guard and succeed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 1, 'should clear 1 phase directory');
    assert.ok(!fs.existsSync(phase1), 'phase directory must be removed when --force is passed');
  });

  test('succeeds without --force when all phase files are committed', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, 'PLAN.md'), '# Plan (committed)');
    // Commit the phase files
    execSync('git add .planning/phases/', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "add phase"', { cwd: tmpDir, stdio: 'pipe' });

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `should succeed when phase files are committed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 1, 'should clear 1 phase directory');
    assert.ok(!fs.existsSync(phase1), 'committed phase directory should be removed');
  });

  test('guard skips gracefully when not in a git repo (no guard, proceeds normally)', () => {
    // Non-git project: createTempProject creates a plain project without git
    const nonGitDir = createTempProject();
    try {
      const phasesDir = path.join(nonGitDir, '.planning', 'phases');
      const phase1 = path.join(phasesDir, '01-foundation');
      fs.mkdirSync(phase1, { recursive: true });
      fs.writeFileSync(path.join(phase1, 'PLAN.md'), '# Plan');

      // Without git, the guard cannot check status — it should skip and proceed
      const result = runGsdTools('phases clear --confirm', nonGitDir);
      assert.ok(result.success, `should succeed in non-git repo: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.cleared, 1, 'should clear 1 phase directory in non-git project');
    } finally {
      cleanup(nonGitDir);
    }
  });
});
