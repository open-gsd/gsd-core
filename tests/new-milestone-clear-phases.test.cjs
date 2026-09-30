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
const fs = require('fs');
const path = require('path');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { gitOrThrow, throwIfFailed } = require('./helpers/git-fixture.cjs');
const { runGsdTools, createTempProject, createTempGitProject, cleanup, readFileNormalized } = require('./helpers.cjs');
const { writeState } = require('./fixtures/index.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

/** Return the raw text of every ```bash fenced block in `content`. */
function extractBashBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  for (const block of scanFencedBlocks(lines)) {
    if (block.closeLineIdx === -1) continue;
    if ((block.infoString || '').trim() !== 'bash') continue;
    blocks.push(lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n'));
  }
  return blocks;
}

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
    gitOrThrow(['add', '.planning/phases/'], { cwd: tmpDir });

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
    gitOrThrow(['add', '.planning/phases/'], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'add phase'], { cwd: tmpDir });

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

  test('override omitted with no ROADMAP archives under the dated fallback label (#3216: getMilestoneInfo default deleted)', () => {
    // #3216 (ADR-3180 §7.2 Decision, roadmap-parser.cjs:788-791): getMilestoneInfo's
    // plausible-looking {version:'v1.0', name:'milestone'} default — output-identical
    // to a genuine v1.0 project — was deleted. With no ROADMAP.md, getMilestoneInfo
    // now returns {value:null, scope:SCOPE.UNREADABLE}; archivePhaseDirectories only
    // trusts a SCOPE.COMPLETE identity as a directory-name-safe version
    // (milestone.cjs:959-965), so a non-COMPLETE scope falls through to the dated
    // `archived-<YYYYMMDD>` label (milestone.cjs:977-978) instead of 'v1.0'. This
    // was previously misfiled under 'v1.0-phases', which read as a genuine v1.0
    // milestone's archive rather than "no resolvable milestone identity".
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- ensure no ROADMAP.md (SUT fallback path, not teardown)
    fs.rmSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), { recursive: true, force: true });

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases')),
      'no version identity is resolvable — must NOT be misfiled under a plausible-looking v1.0-phases'
    );
    const archive = findPhasesArchive(tmpDir);
    assert.ok(archive, 'a milestones/*-phases/ archive should still be created');
    assert.match(
      path.basename(archive),
      /^archived-\d{8}-phases$/,
      'no resolvable milestone identity — must use the dated archived-<YYYYMMDD> fallback label'
    );
    assert.ok(
      fs.existsSync(path.join(archive, '01-foundation')),
      'the phase directory must still be archived (moved, not deleted) under the dated label'
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
    const result = runGsdTools('milestone complete ../../../gsd-ms-escape --confirm', tmpDir);
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

    const result = runGsdTools('milestone complete v1\\\\..\\\\evil --confirm', tmpDir);
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
    EXECUTE_PHASE.indexOf('name="delegate_post_completion_to_transition"')
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
// #2308 / #2334 follow-up: new-milestone.md must not clobber the shared
// PROJECT.md when a workstream is active, and must propagate ${GSD_WS} to
// downstream routing. Step 1 and Step 6's bash fences are extracted and
// EXECUTED (not grepped) so these tests fail on an inert guard — e.g. the
// step-6 conditional merely being PRESENT (`if [ -n "$GSD_WS" ]`) is not
// enough if GSD_WS was never re-derived and is always empty at runtime.
// ────────────────────────────────────────────────────────────────────────
describe('new-milestone.md: workstream-aware PROJECT.md guard (#2308)', () => {
  // #4456: executed fences below use the runtime-launcher preamble, which
  // resolves gsd-tools.cjs via `${RUNTIME_DIR:-$(git rev-parse --show-toplevel
  // || pwd)}`. Any fence run with an ISOLATED `cwd` (a tmpDir outside the
  // repo, needed once Step 1's fence started performing a real
  // `.gsd-ws-arg` write) has no git repo to discover, and CI benches have no
  // global `gsd_run` on PATH to fall back to — so RUNTIME_DIR must be set
  // explicitly wherever an isolated `cwd` is used, or the preamble fails
  // with "gsd-tools.cjs not found" (a real bench failure this fix hit).
  const REPO_ROOT = path.join(__dirname, '..');
  const runtimeDirEnv = { ...process.env, RUNTIME_DIR: REPO_ROOT };
  const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
  // readFileNormalized() strips \r\n -> \n before either extractor below slices
  // a fence out of `content` — both fences are handed to execFileSync('bash', ...)
  // in runStep1/runStep6Commit, so an un-normalized read on a Windows checkout
  // would break bash mid-script (DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE, #2650).
  const content = readFileNormalized(workflowPath);

  // #2994 fragmentization moved the 7.5 reset-phase-safety section (including
  // its "/gsd:new-milestone --reset-phase-numbers ${GSD_WS}" rerun hint) out
  // of new-milestone.md into gsd-core/workflows/new-milestone/steps/reset-phase-safety.md
  // behind a section marker. Only the routing-interpolation test below needs
  // that moved text, so it reads host + step file combined instead of
  // widening `content` (used for host-only fence extraction elsewhere in
  // this describe block).
  const contentWithSteps = content + '\n' + fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone', 'steps', 'reset-phase-safety.md'),
    'utf8'
  );

  // #2994 final slice: Step 4's "Part A" milestone-state write moved out of
  // new-milestone.md into gsd-core/workflows/new-milestone/steps/
  // project-md-milestone-write.md behind a section marker. The
  // "step 4 scopes the workstream skip" test below asserts on Part A's
  // actual body (GSD_WS mentions, the workstream skip description) — rather
  // than widen `content` for every test in this block, SPLICE the step
  // file's content into the marker's exact position so partAIdx/partBIdx
  // position-sensitive slicing below still works. A non-vacuity check
  // (blank the step file, confirm the splice fails, restore) backs this.
  const PROJECT_MD_STEP_PATH = path.join(
    __dirname, '..', 'gsd-core', 'workflows', 'new-milestone', 'steps', 'project-md-milestone-write.md'
  );
  const PROJECT_MD_MARKER_RE = /<!-- gsd:section id="project-md-milestone-write"[\s\S]*?<!-- \/gsd:section -->/;
  function contentWithProjectMdStepSpliced() {
    const stepBody = fs.readFileSync(PROJECT_MD_STEP_PATH, 'utf8');
    assert.match(content, PROJECT_MD_MARKER_RE, 'project-md-milestone-write marker not found in new-milestone.md');
    return content.replace(PROJECT_MD_MARKER_RE, stepBody);
  }

  // Locate the first ```bash fence strictly between two headings.
  function extractFenceBetween(markdown, startHeading, endHeading) {
    const startIdx = markdown.indexOf(startHeading);
    const endIdx = markdown.indexOf(endHeading);
    assert.ok(startIdx !== -1, `heading not found: ${startHeading}`);
    assert.ok(endIdx !== -1, `heading not found: ${endHeading}`);
    assert.ok(startIdx < endIdx, `${startHeading} must precede ${endHeading}`);
    const section = markdown.slice(startIdx, endIdx);
    const bashBlocks = extractBashBlocks(section);
    assert.ok(bashBlocks.length > 0, `no bash fence found between "${startHeading}" and "${endHeading}"`);
    return bashBlocks[0];
  }

  // Step 6 has multiple ```bash fences; locate the one containing `marker`.
  function extractFenceContaining(markdown, startHeading, endHeading, marker) {
    const startIdx = markdown.indexOf(startHeading);
    const endIdx = markdown.indexOf(endHeading);
    assert.ok(startIdx !== -1 && endIdx !== -1 && startIdx < endIdx, 'headings not found in order');
    const section = markdown.slice(startIdx, endIdx);
    for (const block of extractBashBlocks(section)) {
      if (block.includes(marker)) return block;
    }
    assert.fail(`no bash fence containing "${marker}" found between "${startHeading}" and "${endHeading}"`);
    return null;
  }

  describe('step 1: --ws parsing is real, executable shell (not prose)', () => {
    const step1Fence = extractFenceBetween(content, '## 1. Load Context', '## 2. Gather Milestone Goals');
    let tmpDir;

    beforeEach(() => {
      tmpDir = createTempProject();
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    function runStep1(argumentsValue) {
      const script = `ARGUMENTS=${JSON.stringify(argumentsValue)}\n${step1Fence}\n` +
        'printf \'GSD_WS=[%s]\\nMILESTONE_ARG=[%s]\\n\' "$GSD_WS" "$MILESTONE_ARG"';
      const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir, env: runtimeDirEnv });
      throwIfFailed(r, 'bash <step1 fence>');
      const out = r.stdout;
      return {
        gsdWs: /GSD_WS=\[(.*)\]/.exec(out)[1],
        milestoneArg: /MILESTONE_ARG=\[(.*)\]/.exec(out)[1],
      };
    }

    test('parses --ws <name> into GSD_WS and strips it from the milestone name (finding 6)', () => {
      const { gsdWs, milestoneArg } = runStep1('--ws search v2.0 Search');
      assert.strictEqual(gsdWs, '--ws search');
      assert.strictEqual(milestoneArg, 'v2.0 Search');
    });

    test('leaves GSD_WS empty when --ws is absent, milestone name unaffected', () => {
      const { gsdWs, milestoneArg } = runStep1('v2.0 Search');
      assert.strictEqual(gsdWs, '');
      assert.strictEqual(milestoneArg, 'v2.0 Search');
    });

    // #4456: GSD_WS is persisted to .planning/.gsd-ws-arg so later steps'
    // separate shells can forward it — without this file the fix is inert.
    test('#4456: persists GSD_WS to .planning/.gsd-ws-arg for later steps to read back', () => {
      runStep1('--ws search v2.0 Search');
      const persisted = fs.readFileSync(path.join(tmpDir, '.planning', '.gsd-ws-arg'), 'utf8');
      assert.strictEqual(persisted, '--ws search');
    });

    test('#4456: persists an empty file in flat mode (regression guard)', () => {
      runStep1('v2.0 Search');
      const persisted = fs.readFileSync(path.join(tmpDir, '.planning', '.gsd-ws-arg'), 'utf8');
      assert.strictEqual(persisted, '');
    });
  });

  describe('#4456: new-milestone.md forwards --ws to every downstream gsd_run call', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = createTempProject();
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    /**
     * Stub gsd_run: `query init.new-milestone [--ws <name>]` returns a canned
     * JSON payload keyed by whether --ws was present in ITS OWN argv (so a
     * fence that forgets to forward $GSD_WS_ARG gets caught — the stub
     * doesn't just trust a variable, it inspects the actual call). Every
     * other call is recorded verbatim (gsd_run_call:<argv>) for assertion.
     */
    function stubGsdRun(rootPaths, wsPaths) {
      const rootJson = JSON.stringify(rootPaths).replace(/'/g, "'\\''");
      const wsJson = JSON.stringify(wsPaths).replace(/'/g, "'\\''");
      return [
        'gsd_run() {',
        '  if [ "$1" = "query" ] && [ "$2" = "init.new-milestone" ]; then',
        '    case " $* " in',
        `      *" --ws "*|*" --ws="*) printf '%s' '${wsJson}' ;;`,
        `      *) printf '%s' '${rootJson}' ;;`,
        '    esac',
        '  else',
        '    printf "gsd_run_call:%s\\n" "$*"',
        '  fi',
        '}',
      ].join('\n') + '\n';
    }

    describe('step 5: state.get / state.milestone-switch', () => {
      const step5Fence = extractFenceBetween(content, '## 5. Update STATE.md', '## 6. Cleanup and Commit');

      function runStep5(gsdWsArg) {
        fs.writeFileSync(path.join(tmpDir, '.planning', '.gsd-ws-arg'), gsdWsArg);
        const gsdRunStub = 'gsd_run() { printf "gsd_run_call:%s\\n" "$*"; }\n';
        const r = runHookSeam('-c', [gsdRunStub + step5Fence], { interpreter: 'bash', cwd: tmpDir, env: runtimeDirEnv });
        throwIfFailed(r, 'bash <step5 fence>');
        return r.stdout;
      }

      test('ws mode: forwards --ws to both state.get and state.milestone-switch', () => {
        const out = runStep5('--ws search');
        assert.match(out, /gsd_run_call:query state\.get milestone --raw --ws search/,
          `expected state.get to forward --ws search, got: ${out}`);
        assert.match(out, /gsd_run_call:query state\.milestone-switch --milestone v\[X\.Y\] --name \[Name\] --ws search/,
          `expected state.milestone-switch to forward --ws search, got: ${out}`);
      });

      test('flat mode: no stray --ws tokens on either call', () => {
        const out = runStep5('');
        assert.match(out, /gsd_run_call:query state\.get milestone --raw\s*$/m,
          `expected no trailing tokens after --raw in flat mode, got: ${out}`);
        assert.match(out, /gsd_run_call:query state\.milestone-switch --milestone v\[X\.Y\] --name \[Name\]\s*$/m,
          `expected no trailing tokens on state.milestone-switch in flat mode, got: ${out}`);
      });
    });

    describe('step 6: phases.clear forwards --ws', () => {
      const phasesClearFence = extractFenceContaining(
        content, '## 6. Cleanup and Commit', '## 7. Load Context and Resolve Models', 'phases.clear',
      );

      function runPhasesClearFence(gsdWsArg) {
        fs.writeFileSync(path.join(tmpDir, '.planning', '.gsd-ws-arg'), gsdWsArg);
        const gsdRunStub = 'gsd_run() { printf "gsd_run_call:%s\\n" "$*"; }\n';
        const r = runHookSeam('-c', [gsdRunStub + phasesClearFence], { interpreter: 'bash', cwd: tmpDir, env: runtimeDirEnv });
        throwIfFailed(r, 'bash <phases.clear fence>');
        return r.stdout;
      }

      test('ws mode, no outgoing milestone: forwards --ws to the plain phases.clear branch', () => {
        const out = runPhasesClearFence('--ws search');
        assert.match(out, /gsd_run_call:query phases\.clear --confirm --ws search\s*$/m,
          `expected phases.clear to forward --ws search, got: ${out}`);
      });

      test('ws mode, with outgoing milestone: forwards --ws alongside --archive-version', () => {
        fs.writeFileSync(path.join(tmpDir, '.planning', '.gsd-outgoing-milestone'), 'v1.0');
        const out = runPhasesClearFence('--ws search');
        assert.match(out, /gsd_run_call:query phases\.clear --confirm --archive-version v1\.0 --ws search\s*$/m,
          `expected phases.clear to forward both --archive-version and --ws, got: ${out}`);
      });

      test('flat mode: no stray --ws token', () => {
        const out = runPhasesClearFence('');
        assert.match(out, /gsd_run_call:query phases\.clear --confirm\s*$/m,
          `expected no trailing tokens in flat mode, got: ${out}`);
      });
    });

    describe('step 6: git add stages the resolved (workstream-scoped) archive/phases dirs', () => {
      const gitAddFence = extractFenceContaining(
        content, '## 6. Cleanup and Commit', '## 7. Load Context and Resolve Models', 'git add',
      );

      function runGitAddFence(gsdWsArg, rootPaths, wsPaths) {
        fs.writeFileSync(path.join(tmpDir, '.planning', '.gsd-ws-arg'), gsdWsArg);
        const script = stubGsdRun(rootPaths, wsPaths) + gitAddFence +
          '\necho "GIT_ADD_CALL: git add \\"$ARCHIVE_DIR/\\" \\"$PHASES_DIR/\\""';
        const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir, env: runtimeDirEnv });
        throwIfFailed(r, 'bash <git add fence>');
        return r.stdout;
      }

      test('ws mode: stages the workstream-scoped archive_dir/phases_dir, not root', () => {
        const rootPaths = { archive_dir: '/root/milestones', phases_dir: '/root/phases' };
        const wsPaths = { archive_dir: '/ws/milestones', phases_dir: '/ws/phases' };
        const out = runGitAddFence('--ws search', rootPaths, wsPaths);
        assert.ok(out.includes('GIT_ADD_CALL: git add "/ws/milestones/" "/ws/phases/"'),
          `expected the workstream-scoped dirs to be staged, got: ${out}`);
      });

      test('flat mode: stages the root archive_dir/phases_dir', () => {
        const rootPaths = { archive_dir: '/root/milestones', phases_dir: '/root/phases' };
        const wsPaths = { archive_dir: '/ws/milestones', phases_dir: '/ws/phases' };
        const out = runGitAddFence('', rootPaths, wsPaths);
        assert.ok(out.includes('GIT_ADD_CALL: git add "/root/milestones/" "/root/phases/"'),
          `expected the root dirs to be staged, got: ${out}`);
      });
    });

    describe('step 7: init.new-milestone forwards --ws (round-trip file survives — steps 9/10 still need it)', () => {
      const step7Fence = extractFenceContaining(
        content, '## 7. Load Context and Resolve Models', 'Extract from init JSON', 'init.new-milestone',
      );

      test('ws mode: forwards --ws alongside --reset-phase-numbers', () => {
        fs.writeFileSync(path.join(tmpDir, '.planning', '.gsd-ws-arg'), '--ws search');
        const gsdRunStub = 'gsd_run() { if [ "$1" = "query" ] && [ "$2" = "init.new-milestone" ]; then printf "gsd_run_call:%s\\n" "$*" >&2; echo "{}"; else echo "{}"; fi; }\n';
        const script = `ARGUMENTS="--reset-phase-numbers"\n${gsdRunStub}${step7Fence}`;
        const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir, env: runtimeDirEnv });
        throwIfFailed(r, 'bash <step7 fence>');
        assert.match(r.stderr, /gsd_run_call:query init\.new-milestone --reset-phase-numbers --ws=search\s*$/m,
          `expected --ws to be forwarded alongside --reset-phase-numbers, got: ${r.stderr}`);
      });

      // #4456 code-review finding: Steps 9 and 10 (requirements/roadmap
      // commits) run AFTER step 7 and still need to re-read .gsd-ws-arg —
      // deleting it here (the original implementation) left them with no
      // way to resolve REQUIREMENTS.md/ROADMAP.md/STATE.md under a
      // workstream. See the "step 7 no longer deletes .gsd-ws-arg" test
      // below and the step 10 describe block for the corrected cleanup.
      test('does NOT remove .planning/.gsd-ws-arg — steps 9/10 still need it', () => {
        fs.writeFileSync(path.join(tmpDir, '.planning', '.gsd-ws-arg'), '--ws search');
        const gsdRunStub = 'gsd_run() { echo "{}"; }\n';
        const r = runHookSeam('-c', [gsdRunStub + step7Fence], { interpreter: 'bash', cwd: tmpDir, env: runtimeDirEnv });
        throwIfFailed(r, 'bash <step7 fence>');
        assert.ok(fs.existsSync(path.join(tmpDir, '.planning', '.gsd-ws-arg')),
          '.gsd-ws-arg must survive step 7 — steps 9 and 10 run after it and still need to read the file');
      });
    });

    describe('step 6: commit resolves PROJECT.md/STATE.md through init.new-milestone, not literal paths', () => {
      const step6CommitFence = extractFenceContaining(
        content,
        '## 6. Cleanup and Commit',
        '## 7. Load Context and Resolve Models',
        'docs: start milestone v[X.Y] [Name]'
      );

      function runStep6Commit(gsdWsArg, rootPaths, wsPaths) {
        fs.writeFileSync(path.join(tmpDir, '.planning', '.gsd-ws-arg'), gsdWsArg);
        const script = stubGsdRun(rootPaths, wsPaths) + step6CommitFence;
        const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir, env: runtimeDirEnv });
        throwIfFailed(r, 'bash <step6 commit fence>');
        return r.stdout;
      }

      // PROJECT.md is shared (stays root in both modes, #4455 follow-up);
      // STATE.md is workstream-scoped and must resolve accordingly.
      const rootPaths = { project_path: '/root/PROJECT.md', state_path: '/root/STATE.md' };
      const wsPaths = { project_path: '/root/PROJECT.md', state_path: '/ws/STATE.md' };

      test('ws mode: --files uses the resolved workstream STATE.md, shared root PROJECT.md', () => {
        const out = runStep6Commit('--ws search', rootPaths, wsPaths);
        assert.ok(
          out.includes('gsd_run_call:query commit docs: start milestone v[X.Y] [Name] --files /root/PROJECT.md /ws/STATE.md'),
          `expected the resolved ws-mode paths in --files, got: ${out}`
        );
      });

      test('flat mode: --files uses the resolved root paths for both', () => {
        const out = runStep6Commit('', rootPaths, wsPaths);
        assert.ok(
          out.includes('gsd_run_call:query commit docs: start milestone v[X.Y] [Name] --files /root/PROJECT.md /root/STATE.md'),
          `expected the resolved flat-mode paths in --files, got: ${out}`
        );
      });

      test('does not guard the commit on a bare cross-step GSD_WS variable (regression guard)', () => {
        // Regression guard for the inert-guard trap: GSD_WS is assigned in Step
        // 1's shell, and each step's bash block runs in its own shell. A
        // `[ -n "$GSD_WS" ]` branch here would read an unset variable, always
        // take the flat branch, and only appear to work — the fix instead
        // reads $GSD_WS_ARG back from the persisted file.
        assert.ok(
          !/\[\s*-n\s*"\$GSD_WS"\s*\]/.test(step6CommitFence),
          `step 6 must not branch on a bare cross-step GSD_WS; got fence:\n${step6CommitFence}`
        );
      });
    });

    // #4456 code-review finding: Steps 9 and 10 ALSO commit workstream-scoped
    // files (REQUIREMENTS.md, ROADMAP.md, STATE.md) via literal root paths —
    // the same bug class as Step 6, missed in the first pass. Because these
    // steps run AFTER Step 7 (where .gsd-ws-arg was previously being deleted),
    // fixing them required moving the round-trip file's cleanup to Step 10 —
    // its true last consumer — instead of Step 7.
    describe('step 9: requirements commit resolves REQUIREMENTS.md through init.new-milestone', () => {
      const step9Fence = extractFenceContaining(
        content, '## 9. Define Requirements', '## 10. Create Roadmap', 'docs: define milestone',
      );

      function runStep9(gsdWsArg, rootPaths, wsPaths) {
        fs.writeFileSync(path.join(tmpDir, '.planning', '.gsd-ws-arg'), gsdWsArg);
        const script = stubGsdRun(rootPaths, wsPaths) + step9Fence;
        const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir, env: runtimeDirEnv });
        throwIfFailed(r, 'bash <step9 fence>');
        return r.stdout;
      }

      const rootPaths = { requirements_path: '/root/REQUIREMENTS.md' };
      const wsPaths = { requirements_path: '/ws/REQUIREMENTS.md' };

      test('ws mode: --files uses the resolved workstream REQUIREMENTS.md', () => {
        const out = runStep9('--ws search', rootPaths, wsPaths);
        assert.ok(
          out.includes('gsd_run_call:query commit docs: define milestone v[X.Y] requirements --files /ws/REQUIREMENTS.md'),
          `expected the resolved ws-mode path, got: ${out}`
        );
      });

      test('flat mode: --files uses the resolved root REQUIREMENTS.md', () => {
        const out = runStep9('', rootPaths, wsPaths);
        assert.ok(
          out.includes('gsd_run_call:query commit docs: define milestone v[X.Y] requirements --files /root/REQUIREMENTS.md'),
          `expected the resolved flat-mode path, got: ${out}`
        );
      });
    });

    describe('step 10: roadmap commit resolves ROADMAP/STATE/REQUIREMENTS through init.new-milestone, then cleans up .gsd-ws-arg', () => {
      const step10Fence = extractFenceContaining(
        content, '## 10. Create Roadmap', '## 10.5.', 'docs: create milestone v[X.Y] roadmap',
      );

      function runStep10(gsdWsArg, rootPaths, wsPaths) {
        fs.writeFileSync(path.join(tmpDir, '.planning', '.gsd-ws-arg'), gsdWsArg);
        const script = stubGsdRun(rootPaths, wsPaths) + step10Fence;
        const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: tmpDir, env: runtimeDirEnv });
        throwIfFailed(r, 'bash <step10 fence>');
        return r.stdout;
      }

      const rootPaths = { roadmap_path: '/root/ROADMAP.md', state_path: '/root/STATE.md', requirements_path: '/root/REQUIREMENTS.md' };
      const wsPaths = { roadmap_path: '/ws/ROADMAP.md', state_path: '/ws/STATE.md', requirements_path: '/ws/REQUIREMENTS.md' };

      test('ws mode: --files uses all three resolved workstream paths', () => {
        const out = runStep10('--ws search', rootPaths, wsPaths);
        assert.ok(
          out.includes('gsd_run_call:query commit docs: create milestone v[X.Y] roadmap ([N] phases) --files /ws/ROADMAP.md /ws/STATE.md /ws/REQUIREMENTS.md'),
          `expected the resolved ws-mode paths, got: ${out}`
        );
      });

      test('flat mode: --files uses all three resolved root paths', () => {
        const out = runStep10('', rootPaths, wsPaths);
        assert.ok(
          out.includes('gsd_run_call:query commit docs: create milestone v[X.Y] roadmap ([N] phases) --files /root/ROADMAP.md /root/STATE.md /root/REQUIREMENTS.md'),
          `expected the resolved flat-mode paths, got: ${out}`
        );
      });

      test('removes .planning/.gsd-ws-arg after this commit (the true last consumer, not step 7)', () => {
        runStep10('--ws search', rootPaths, wsPaths);
        assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', '.gsd-ws-arg')),
          '.gsd-ws-arg should be cleaned up here, since steps 9 and 10 still need it after step 7');
      });
    });

    test('step 7 no longer deletes .gsd-ws-arg (steps 9/10 still need it)', () => {
      const step7Fence = extractFenceContaining(
        content, '## 7. Load Context and Resolve Models', 'Extract from init JSON', 'init.new-milestone',
      );
      assert.ok(!step7Fence.includes('rm -f .planning/.gsd-ws-arg'),
        'step 7 must not delete .gsd-ws-arg — steps 9 and 10 run after it and still need to read the file');
    });
  });

  test('routing interpolations still propagate ${GSD_WS} at the documented lines', () => {
    assert.ok(
      contentWithSteps.includes('/gsd:new-milestone --reset-phase-numbers ${GSD_WS}'),
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

  test('step 4 scopes the workstream skip to the milestone-state write only; Evolution repair always runs (finding 2)', () => {
    const splicedContent = contentWithProjectMdStepSpliced();
    const step4Idx = splicedContent.indexOf('## 4. Update PROJECT.md');
    const step5Idx = splicedContent.indexOf('## 5. Update STATE.md');
    assert.ok(step4Idx !== -1 && step5Idx !== -1 && step4Idx < step5Idx, 'steps 4 and 5 should be locatable');
    const step4Body = splicedContent.slice(step4Idx, step5Idx);

    const partAIdx = step4Body.indexOf('Part A');
    const partBIdx = step4Body.indexOf('Part B');
    assert.ok(partAIdx !== -1 && partBIdx !== -1 && partAIdx < partBIdx, 'step 4 should have distinct Part A / Part B sections');

    const partABody = step4Body.slice(partAIdx, partBIdx);
    const partBBody = step4Body.slice(partBIdx);

    assert.match(partABody, /skip/i, 'Part A should describe the workstream skip');
    assert.ok(partABody.includes('GSD_WS'), 'Part A guard should be keyed on GSD_WS');
    assert.match(
      step4Body,
      /shared/i,
      'step 4 should justify the guard by pointing at PROJECT.md being the shared file'
    );

    // The Evolution structural repair must be reachable OUTSIDE Part A's skip,
    // and Part B's own text must state it is unconditional.
    assert.ok(!partABody.includes('## Evolution'), 'Evolution repair must NOT be nested inside the guarded Part A');
    assert.ok(partBBody.includes('## Evolution'), 'Part B must contain the Evolution section template');
    assert.match(partBBody, /always runs/i, 'Part B must state it always runs regardless of GSD_WS');
  });
});
