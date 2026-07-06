/**
 * GSD Tools Tests - New Milestone Clear Phases (#1588)
 *
 * Verifies that `phases clear` removes phase subdirectories from
 * .planning/phases/ only when archive parity is proven or an explicit
 * `--confirm --force` override is given. Backlog `999.x` directories are
 * preserved.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function writeMilestones(tmpDir, version) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'MILESTONES.md'),
    `# Milestones\n\n## ${version} Release (Shipped: 2025-01-01)\n\n---\n\n`,
  );
}

function mirrorDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const srcPath = path.join(source, entry.name);
    const tgtPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      mirrorDir(srcPath, tgtPath);
    } else {
      fs.copyFileSync(srcPath, tgtPath);
    }
  }
}

describe('phases clear command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('clears phase dirs when archive parity matches', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases');

    const phase1 = path.join(phasesDir, '01-foundation');
    const phase2 = path.join(phasesDir, '02-api');
    fs.mkdirSync(phase1, { recursive: true });
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase2, '02-01-SUMMARY.md'), '# Summary');

    // Create identical archive copies
    mirrorDir(phase1, path.join(archiveDir, '01-foundation'));
    mirrorDir(phase2, path.join(archiveDir, '02-api'));

    writeMilestones(tmpDir, 'v1.0');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 2, 'should report 2 directories cleared');

    assert.ok(fs.existsSync(phasesDir), '.planning/phases/ directory should still exist');
    assert.ok(!fs.existsSync(phase1), 'active phase1 should be removed');
    assert.ok(!fs.existsSync(phase2), 'active phase2 should be removed');
    assert.ok(fs.existsSync(path.join(archiveDir, '01-foundation')), 'archive phase1 should remain');
    assert.ok(fs.existsSync(path.join(archiveDir, '02-api')), 'archive phase2 should remain');
  });

  test('rejects when MILESTONES.md has no shipped entry and leaves dirs intact', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(!result.success, 'should fail without shipped milestone entry');
    assert.ok(result.error.includes('no shipped milestone entry'), `error should mention missing shipped entry; got: ${result.error}`);
    assert.ok(fs.existsSync(phase1), 'active dir must remain untouched');
  });

  test('rejects when archive dir is missing and leaves dirs intact', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    writeMilestones(tmpDir, 'v1.0');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(!result.success, 'should fail when archive dir is missing');
    assert.ok(result.error.includes('.planning/milestones/v1.0-phases/'), `error should mention archive path; got: ${result.error}`);
    assert.ok(fs.existsSync(phase1), 'active dir must remain untouched');
  });

  test('rejects when active dir has no archived counterpart and leaves dirs intact', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    const phase2 = path.join(phasesDir, '02-api');
    fs.mkdirSync(phase1, { recursive: true });
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase2, '02-01-PLAN.md'), '# Plan');

    // Archive only phase1
    mirrorDir(phase1, path.join(archiveDir, '01-foundation'));

    writeMilestones(tmpDir, 'v1.0');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(!result.success, 'should fail when archive dir is missing for phase2');
    assert.ok(result.error.includes('archive parity failed for 02-api'), `error should mention parity failure; got: ${result.error}`);
    assert.ok(fs.existsSync(phase1), 'active dirs must remain untouched');
    assert.ok(fs.existsSync(phase2), 'active dirs must remain untouched');
  });

  test('rejects when active and archived dir contents differ and leaves dirs intact', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Active Plan');

    const archived = path.join(archiveDir, '01-foundation');
    fs.mkdirSync(archived, { recursive: true });
    fs.writeFileSync(path.join(archived, '01-01-PLAN.md'), '# Archived Plan');

    writeMilestones(tmpDir, 'v1.0');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(!result.success, 'should fail when archive differs');
    assert.ok(result.error.includes('archive parity failed for 01-foundation'), `error should mention parity failure; got: ${result.error}`);
    assert.ok(fs.existsSync(phase1), 'active dir must remain untouched');
  });

  test('succeeds with cleared=0 when phases directory is already empty', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 0, 'should report 0 cleared when already empty');
    assert.ok(fs.existsSync(phasesDir), '.planning/phases/ directory should still exist');
  });

  test('succeeds with cleared=0 when phases directory does not exist', () => {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-test removal to simulate absent phases dir (SUT behavior, not teardown)
    fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 0, 'should report 0 cleared when directory absent');
  });

  test('does not remove files (only directories) at the phases root with --force', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.writeFileSync(path.join(phasesDir, 'README.md'), '# Phases');

    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools(['phases', 'clear', '--confirm', '--force'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 1, 'should report 1 directory cleared (not the file)');
    assert.ok(fs.existsSync(path.join(phasesDir, 'README.md')), 'files at phases root should be preserved');
  });

  test('clears nested phase content with --confirm --force', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    const nested = path.join(phase1, 'subdir');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'deep-file.md'), '# Deep');

    const result = runGsdTools(['phases', 'clear', '--confirm', '--force'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(!fs.existsSync(phase1), 'phase directory including nested content should be removed');
  });

  test('new-milestone workflow no longer instructs raw find-mv archival or --force clear', () => {
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
    assert.ok(fs.existsSync(workflowPath), 'new-milestone.md should exist');
    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes('fail-closed'), 'workflow should mention fail-closed archive parity');
    assert.ok(!content.includes('phases.clear --confirm --force'), 'workflow must not embed the force clear command');
    assert.ok(
      !content.includes('find .planning/phases -mindepth 1 -maxdepth 1 -type d -exec mv'),
      'workflow must not contain the raw find-mv archival command',
    );
  });
});
