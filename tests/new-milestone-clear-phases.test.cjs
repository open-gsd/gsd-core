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
const { writeState } = require('./fixtures/index.cjs');

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

  test('archives nested phase content (moved, not deleted) (#1871)', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    const nested = path.join(phase1, 'subdir');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'deep-file.md'), '# Deep');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Source is cleared (moved away)...
    assert.ok(!fs.existsSync(phase1), 'phase directory should be moved out of .planning/phases/');
    // ...but the nested content SURVIVES in the archive (not destroyed).
    const archive = findPhasesArchive(tmpDir);
    assert.ok(archive, 'an archive dir milestones/*-phases/ should exist');
    assert.ok(
      fs.existsSync(path.join(archive, '01-foundation', 'subdir', 'deep-file.md')),
      'nested phase content must be preserved in the archive, not deleted',
    );
  });
});

// Locate the `milestones/<version>-phases/` archive directory created by phases clear.
function findPhasesArchive(tmpDir) {
  const milestonesDir = path.join(tmpDir, '.planning', 'milestones');
  try {
    for (const entry of fs.readdirSync(milestonesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /-phases$/.test(entry.name)) {
        return path.join(milestonesDir, entry.name);
      }
    }
  } catch {
    /* no milestones dir */
  }
  return null;
}

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
    // #1871: a committed phase dir is ARCHIVED (moved to milestones/*-phases/), not destroyed.
    assert.ok(!fs.existsSync(phase1), 'committed phase directory should be moved out of .planning/phases/');
    const archive = findPhasesArchive(tmpDir);
    assert.ok(archive, 'a milestones/*-phases/ archive should be created for committed phase dirs');
    assert.ok(
      fs.existsSync(path.join(archive, '01-foundation', 'PLAN.md')),
      'committed phase content must be preserved in the archive, not hard-deleted',
    );
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

// ─── #2288: --archive-version override ──────────────────────────────────────

describe('phases clear: archive-version override (#2288)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('override wins over live milestone state (new-milestone switches STATE before phases.clear)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v2.0 — Active Milestone\n'
    );
    writeState(tmpDir, '---\nmilestone: v2.0\n---\n\n# State\n');

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm --archive-version v1.0', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 1, 'should report 1 directory cleared');

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation')),
      'phase history should archive under the OLD (override) version'
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v2.0-phases')),
      'phase history must NOT be misfiled under the live-read NEW version'
    );
  });

  test('no override falls back to live milestone version (no behavior change)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v2.0 — Active Milestone\n'
    );
    writeState(tmpDir, '---\nmilestone: v2.0\n---\n\n# State\n');

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v2.0-phases', '01-foundation')),
      'without an override, the live-read milestone version should still be used'
    );
  });

  test('override with unchanged version (boundary: old === new)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v3.0 — Active Milestone\n'
    );
    writeState(tmpDir, '---\nmilestone: v3.0\n---\n\n# State\n');

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm --archive-version v3.0', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v3.0-phases', '01-foundation')),
      'override equal to the live version should archive normally'
    );
  });

  test('override omitted with no ROADMAP uses getMilestoneInfo default (no-override path unchanged)', () => {
    // createTempProject writes no ROADMAP.md, so getMilestoneInfo does NOT throw —
    // it returns its documented default version ('v1.0'). The dated `archived-*`
    // label is only reached if no safe version label is resolvable at all, which
    // this common case is not. This pins the no-override path to its pre-#2288
    // behavior (getMilestoneInfo-derived label), not a dated fallback.
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- ensure no ROADMAP.md (SUT fallback path, not teardown)
    fs.rmSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), { recursive: true, force: true });

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation')),
      'no override + no ROADMAP archives under getMilestoneInfo default (v1.0), unchanged from pre-#2288'
    );
  });

  test('rejects an --archive-version containing path traversal (no phase dir escapes .planning) (#2288 security)', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    // A traversal payload as the archive-version must be rejected outright — the
    // value becomes a MOVED directory name, so accepting it would relocate phase
    // history outside .planning/milestones/.
    const result = runGsdTools(
      'phases clear --confirm --archive-version ../../../gsd-poc-escape',
      tmpDir,
    );
    assert.ok(!result.success, 'phases clear must FAIL on a path-traversal --archive-version');

    // The phase directory must NOT have moved anywhere — it stays put.
    assert.ok(
      fs.existsSync(phase1),
      'phase dir must remain in place when the archive-version is rejected',
    );
    // Nothing may have been created outside the project's milestones dir.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '..', 'gsd-poc-escape-phases')),
      'no directory may be created outside the project via traversal',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones')),
      'no archive dir should be created at all when the override is rejected',
    );
  });

  test('rejects backslash path separators in --archive-version (#2288 security)', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    // Starts with an alphanumeric so it clears the leading-char anchor — this
    // proves the backslash (Windows path separator) itself is rejected, not just
    // a leading-dot traversal.
    const result = runGsdTools(
      'phases clear --confirm --archive-version v1\\\\..\\\\evil',
      tmpDir,
    );
    assert.ok(!result.success, 'phases clear must FAIL on a backslash-separator --archive-version');
    assert.ok(fs.existsSync(phase1), 'phase dir must remain in place');
  });

  test('errors when --archive-version is present but its value is missing (does not silently drop the override) (#2288)', () => {
    // A truncated invocation must fail loud, not fall through to the live read
    // (which would silently re-file under the new milestone — the #2288 bug).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v2.0 — Active Milestone\n'
    );
    writeState(tmpDir, '---\nmilestone: v2.0\n---\n\n# State\n');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    // --archive-version as the final token with no value following it.
    const result = runGsdTools('phases clear --confirm --archive-version', tmpDir);
    assert.ok(!result.success, 'a value-less --archive-version must be an error, not a silent fallback');
    assert.ok(fs.existsSync(phase1), 'phase dir must remain in place when the flag is rejected');
  });
});

// ─── #2288: sibling sink — `milestone complete <version>` path safety ───────

describe('milestone complete: version path-traversal guard (#2288 security)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('rejects a milestone-complete version containing path traversal (no write/move escapes .planning)', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    // `version` is interpolated into `${version}-ROADMAP.md`, `${version}-phases`,
    // etc. as a MOVED/written path component — a traversal value must be rejected
    // before any filesystem mutation.
    const result = runGsdTools('milestone complete ../../../gsd-ms-escape', tmpDir);
    assert.ok(!result.success, 'milestone complete must FAIL on a path-traversal version');

    // No artifact created outside the project via traversal.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '..', 'gsd-ms-escape-phases')),
      'no directory may be created outside the project via a traversal version',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '..', 'gsd-ms-escape-ROADMAP.md')),
      'no file may be written outside the project via a traversal version',
    );
    // Phase dir untouched.
    assert.ok(fs.existsSync(phase1), 'phase dir must remain in place when the version is rejected');
  });

  test('rejects a backslash-separator milestone-complete version (#2288 security)', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('milestone complete v1\\\\..\\\\evil', tmpDir);
    assert.ok(!result.success, 'milestone complete must FAIL on a backslash-separator version');
    assert.ok(fs.existsSync(phase1), 'phase dir must remain in place');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2433-todo-phase-linking.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2433-todo-phase-linking (consolidation epic #1969 B4 #1973)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #2433)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Tests for gsd-new-milestone todo-to-phase linking (#2433).
 * Verifies the workflow text contains the correct linking and auto-close steps.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const NEW_MILESTONE = fs.readFileSync(
  path.join(ROOT, 'gsd-core/workflows/new-milestone.md'), 'utf-8'
);
const EXECUTE_PHASE = fs.readFileSync(
  path.join(ROOT, 'gsd-core/workflows/execute-phase.md'), 'utf-8'
);

test('new-milestone.md: step 10.5 links pending todos to roadmap phases', () => {
  assert.ok(NEW_MILESTONE.includes('10.5'), 'step 10.5 should exist');
  assert.ok(NEW_MILESTONE.includes('resolves_phase'), 'should reference resolves_phase field');
  assert.ok(NEW_MILESTONE.includes('.planning/todos/pending'), 'should scan pending todos directory');
});

test('new-milestone.md: todo linking runs after roadmap commit', () => {
  const roadmapCommitIdx = NEW_MILESTONE.indexOf('docs: create milestone v[X.Y] roadmap');
  const step105Idx = NEW_MILESTONE.indexOf('10.5. Link Pending Todos');
  const step11Idx = NEW_MILESTONE.indexOf('## 11. Done');
  assert.ok(roadmapCommitIdx < step105Idx, 'step 10.5 should come after roadmap commit');
  assert.ok(step105Idx < step11Idx, 'step 10.5 should come before step 11');
});

test('new-milestone.md: todo linking is best-effort and leaves unmatched todos unmodified', () => {
  assert.ok(NEW_MILESTONE.includes('best-effort'), 'should describe best-effort matching');
  assert.ok(NEW_MILESTONE.includes('unmatched'), 'should mention leaving unmatched todos alone');
  assert.ok(NEW_MILESTONE.includes('confident match'), 'should gate on confident match');
});

test('new-milestone.md: step 10.5 commits tagged todos', () => {
  // After #3797 architectural fix, callsites use gsd_run
  assert.ok(NEW_MILESTONE.includes('gsd_run query commit'), 'should commit tagged todos');
  assert.ok(NEW_MILESTONE.includes('resolves_phase after milestone'), 'commit message should mention resolves_phase');
});

test('new-milestone.md: success_criteria includes todo linking', () => {
  assert.ok(NEW_MILESTONE.includes('resolves_phase: N'), 'success_criteria should mention resolves_phase tagging');
});

test('execute-phase.md: close_phase_todos step exists', () => {
  assert.ok(EXECUTE_PHASE.includes('close_phase_todos'), 'close_phase_todos step should exist');
  assert.ok(EXECUTE_PHASE.includes('resolves_phase'), 'should check resolves_phase in todos');
});

test('execute-phase.md: auto-close moves todos to completed directory', () => {
  assert.ok(EXECUTE_PHASE.includes('.planning/todos/completed'), 'should move to completed dir');
  assert.ok(EXECUTE_PHASE.includes('.planning/todos/pending'), 'should scan pending dir');
  assert.ok(EXECUTE_PHASE.includes('mv "$TODO_FILE" "$COMPLETED_DIR/"'), 'should use mv to move files');
});

test('execute-phase.md: close_phase_todos runs after update_roadmap', () => {
  const updateRoadmapIdx = EXECUTE_PHASE.indexOf('name="update_roadmap"');
  const closeTodosIdx = EXECUTE_PHASE.indexOf('name="close_phase_todos"');
  assert.ok(updateRoadmapIdx < closeTodosIdx, 'close_phase_todos should run after update_roadmap');
});

test('execute-phase.md: auto-close never blocks phase completion', () => {
  const closeTodosSection = EXECUTE_PHASE.slice(
    EXECUTE_PHASE.indexOf('name="close_phase_todos"'),
    EXECUTE_PHASE.indexOf('name="update_project_md"')
  );
  assert.ok(
    closeTodosSection.includes('never blocks') || closeTodosSection.includes('additive'),
    'close_phase_todos should be non-blocking'
  );
});

test('execute-phase.md: awk extracts resolves_phase from YAML frontmatter', () => {
  assert.ok(EXECUTE_PHASE.includes('awk'), 'should use awk for frontmatter extraction');
  assert.ok(EXECUTE_PHASE.includes('resolves_phase:'), 'awk pattern should match resolves_phase key');
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #2308: new-milestone.md must not clobber the shared PROJECT.md when a
// workstream is active, and must propagate ${GSD_WS} to downstream routing.
// ────────────────────────────────────────────────────────────────────────
describe('new-milestone.md: workstream-aware PROJECT.md guard (#2308)', () => {
  const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
  const content = fs.readFileSync(workflowPath, 'utf8');

  test('step 1 parses --ws into GSD_WS using the established grep idiom', () => {
    assert.ok(content.includes('GSD_WS=""'), 'should initialize GSD_WS to empty string');
    assert.ok(
      content.includes("grep -qE -- '--ws[[:space:]]+[^[:space:]]+'"),
      'should test for the --ws flag using the established idiom (see verify-work.md)'
    );
    assert.ok(
      content.includes('GSD_WS=$(echo "$ARGUMENTS" | grep -oE -- \'--ws[[:space:]]+[^[:space:]]+\')'),
      'should extract the --ws value into GSD_WS using the established idiom'
    );
  });

  test('step 4 carries a workstream skip-guard keyed on GSD_WS', () => {
    const step4Idx = content.indexOf('## 4. Update PROJECT.md');
    const step5Idx = content.indexOf('## 5. Update STATE.md');
    assert.ok(step4Idx !== -1 && step5Idx !== -1 && step4Idx < step5Idx, 'steps 4 and 5 should be locatable');
    const step4Body = content.slice(step4Idx, step5Idx);

    assert.match(
      step4Body,
      /Skip this entire step if a workstream is active/i,
      'step 4 should describe a whole-step skip guard'
    );
    assert.ok(step4Body.includes('GSD_WS'), 'step 4 guard should be keyed on GSD_WS');
    assert.ok(step4Body.includes('#2308'), 'step 4 should reference the originating issue');
    assert.ok(
      step4Body.includes('Shared'),
      'step 4 should justify the guard by pointing at PROJECT.md being the shared file'
    );
  });

  test('step 6 commit does not stage PROJECT.md unconditionally', () => {
    const step6Idx = content.indexOf('## 6. Cleanup and Commit');
    const step7Idx = content.indexOf('## 7. Load Context and Resolve Models');
    assert.ok(step6Idx !== -1 && step7Idx !== -1 && step6Idx < step7Idx, 'steps 6 and 7 should be locatable');
    const step6Body = content.slice(step6Idx, step7Idx);

    assert.ok(step6Body.includes('if [ -n "$GSD_WS" ]'), 'step 6 commit must branch on GSD_WS');
    assert.ok(
      step6Body.includes('--files .planning/STATE.md') &&
        step6Body.includes('--files .planning/PROJECT.md .planning/STATE.md'),
      'step 6 should have a workstream-mode branch (STATE.md only) and a flat-mode branch (PROJECT.md + STATE.md)'
    );
    // The bare, unconditional two-file commit form from before the fix must be gone.
    const bareForm = 'gsd_run query commit "docs: start milestone v[X.Y] [Name]" --files .planning/PROJECT.md .planning/STATE.md\n```';
    assert.ok(
      !content.includes(bareForm),
      'the pre-fix unconditional commit staging PROJECT.md must no longer appear bare'
    );
  });

  test('routing interpolations still propagate ${GSD_WS} at the documented lines', () => {
    assert.ok(
      content.includes('/gsd:new-milestone --reset-phase-numbers ${GSD_WS}'),
      'reset-phase-numbers rerun hint should propagate ${GSD_WS}'
    );
    assert.ok(
      content.includes('/gsd:discuss-phase [N] ${GSD_WS}'),
      'discuss-phase routing hint should propagate ${GSD_WS}'
    );
    assert.ok(
      content.includes('/gsd:plan-phase [N] ${GSD_WS}'),
      'plan-phase routing hint should propagate ${GSD_WS}'
    );
  });

  test('success criteria reflects PROJECT.md update is skipped in workstream mode', () => {
    assert.match(
      content,
      /PROJECT\.md updated with Current Milestone section.*skipped.*workstream/i,
      'success criteria should note the PROJECT.md step is skipped in workstream mode'
    );
  });
});
