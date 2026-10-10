'use strict';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const { computeMigrationPlan, applyMigration, rewriteRoadmapLines } = require('../gsd-core/bin/lib/roadmap-upgrade.cjs');

/**
 * Build a git project whose `.planning/` is GITIGNORED (commit_docs:false) —
 * the condition under which the old `git reset --hard` + `git clean -fd`
 * rollback restored nothing yet still reported "rolled back". #1542.
 */
function makeGitignoredPlanningProject() {
  const dir = createTempDir('m3-rollback-');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.planning/\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# tracked\n');
  const git = (argv) => gitOrThrow(argv, { cwd: dir });
  git(['init']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial']);

  // .planning created AFTER the commit → untracked + gitignored.
  const planning = path.join(dir, '.planning');
  fs.mkdirSync(path.join(planning, 'phases', '01-foo'), { recursive: true });
  fs.mkdirSync(path.join(planning, 'phases', '02-bar'), { recursive: true });
  fs.writeFileSync(path.join(planning, 'phases', '01-foo', 'PLAN.md'), 'foo plan\n');
  fs.writeFileSync(path.join(planning, 'phases', '02-bar', 'PLAN.md'), 'bar plan\n');
  fs.writeFileSync(
    path.join(planning, 'ROADMAP.md'),
    ['## v1.0: First Milestone', '', '### Phase 1: Foo', '', '### Phase 2: Bar', ''].join('\n'),
  );
  return dir;
}

function snapshotPlanning(dir) {
  const planning = path.join(dir, '.planning');
  return {
    phases: fs.readdirSync(path.join(planning, 'phases')).sort(),
    roadmap: fs.readFileSync(path.join(planning, 'ROADMAP.md'), 'utf8'),
    hasConfig: fs.existsSync(path.join(planning, 'config.json')),
  };
}

describe('roadmap upgrade rollback (#1542)', () => {
  test('a mid-migration failure restores .planning even when it is gitignored', (t) => {
    const dir = makeGitignoredPlanningProject();
    t.after(() => cleanup(dir));

    const plan = computeMigrationPlan(dir);
    assert.equal(plan.alreadyMigrated, false);
    assert.ok(plan.phases.length >= 1, 'fixture must produce phase renames');
    assert.ok(plan.roadmapEdits.length >= 1, 'fixture must produce roadmap edits');

    const before = snapshotPlanning(dir);
    assert.equal(before.hasConfig, false, 'precondition: no config.json yet');

    // Inject a failure on the LAST mutation step (the config.json write) so the
    // phase renames AND the ROADMAP rewrite have already happened when rollback
    // fires — exactly the half-migrated state the old git rollback could not undo.
    const realWrite = fs.writeFileSync;
    const writeMock = mock.method(fs, 'writeFileSync', function (target, data, opts) {
      if (String(target).endsWith('config.json')) {
        const err = new Error('EIO: simulated write failure');
        err.code = 'EIO';
        throw err;
      }
      return realWrite.call(fs, target, data, opts);
    });
    t.after(() => writeMock.mock.restore());

    assert.throws(() => applyMigration(dir, plan, { dryRun: false }), /Migration failed/);

    // The rollback must have actually restored the workspace — not just claimed to.
    const after = snapshotPlanning(dir);
    assert.deepEqual(after.phases, before.phases, 'phase dirs must be restored to their original names');
    assert.equal(after.roadmap, before.roadmap, 'ROADMAP.md must be restored to its original content');
    assert.equal(after.hasConfig, false, 'config.json created during migration must be removed on rollback');
  });

  test('a successful migration still applies (renames + roadmap rewrite + config), no rollback', (t) => {
    const dir = makeGitignoredPlanningProject();
    t.after(() => cleanup(dir));

    const plan = computeMigrationPlan(dir);
    const before = snapshotPlanning(dir);

    const result = applyMigration(dir, plan, { dryRun: false });

    assert.equal(result.applied, true);
    const after = snapshotPlanning(dir);
    assert.notDeepEqual(after.phases, before.phases, 'phase dirs renamed on success');
    assert.equal(after.hasConfig, true, 'config.json written on success');
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
    assert.equal(config.phase_id_convention, 'milestone-prefixed');
  });
});

// #4698 Blocker 1: `applyMigration` stamped `phase_id_convention` only when
// `plan.phases.length > 0` — but `phases` holds DIRECTORY renames, not
// converted HEADINGS. The historical milestone-prefixed target shares this
// exact `applyMigration` function with the bracket target, so it carried the
// identical latent defect: a roadmap with recognizable legacy headings and
// zero phase directories on disk got its headings rewritten while config
// stayed unset. Fixed by activating on `roadmapEdits.length > 0 ||
// phases.length > 0` for both targets.
function makeGitignoredPlanningRepo(dir) {
  fs.writeFileSync(path.join(dir, '.gitignore'), '.planning/\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# tracked\n');
  const git = (argv) => gitOrThrow(argv, { cwd: dir });
  git(['init']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial']);
}

describe('roadmap upgrade config activation (#4698 Blocker 1)', () => {
  test('milestone-prefixed target: headings convert and config is stamped even with zero phase directories', (t) => {
    const dir = createTempDir('m1-headings-only-');
    t.after(() => cleanup(dir));
    makeGitignoredPlanningRepo(dir);
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'ROADMAP.md'),
      ['## v1.0: First Milestone', '', '### Phase 1: Foo', '', '### Phase 2: Bar', ''].join('\n'),
    );

    const plan = computeMigrationPlan(dir);
    assert.equal(plan.alreadyMigrated, false);
    assert.equal(plan.phases.length, 0, 'no phase directories exist on disk to rename');
    assert.ok(plan.roadmapEdits.length >= 1, 'headings must still be converted');

    const result = applyMigration(dir, plan, { dryRun: false });

    assert.equal(result.applied, true);
    const roadmap = fs.readFileSync(path.join(dir, '.planning', 'ROADMAP.md'), 'utf8');
    assert.match(roadmap, /### Phase 1-01: Foo/);
    assert.match(roadmap, /### Phase 1-02: Bar/);
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
    assert.equal(
      config.phase_id_convention,
      'milestone-prefixed',
      'config must be stamped once headings convert, even though zero directories were renamed',
    );
  });

  test('milestone-prefixed target: an empty plan still writes nothing (regression guard)', (t) => {
    const dir = createTempDir('m1-empty-plan-');
    t.after(() => cleanup(dir));
    makeGitignoredPlanningRepo(dir);
    const configPath = path.join(dir, '.planning', 'config.json');
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ phase_id_convention: null }, null, 2) + '\n');

    const emptyPlan = { alreadyMigrated: false, phases: [], roadmapEdits: [], crossRefEdits: [] };
    const result = applyMigration(dir, emptyPlan, { dryRun: false });

    assert.equal(result.applied, true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.phase_id_convention, null, 'config must be untouched when the plan converted zero phases');
  });
});

// ADR-5057 §6 (Phase 13, #5217): every planning-artifact write the migration
// makes goes through its seam — headings/bullets through the sectionizer,
// PROJECT.md prose through PlanningDoc, STATE.md through its own write seam.
describe('roadmap upgrade writes through the planning seams (#5217)', () => {
  const ROADMAP = ['## v1.0: First Milestone', '', '### Phase 1: Foo', '', '### Phase 2: Bar', ''].join('\n');

  function setup(prefix, roadmap) {
    const dir = createTempDir(prefix);
    makeGitignoredPlanningRepo(dir);
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), roadmap);
    return dir;
  }

  test('PROJECT.md and STATE.md prose references are rewritten; a reference inside a fenced block is not', (t) => {
    const dir = setup('m13-crossref-', ROADMAP);
    t.after(() => cleanup(dir));
    const project = path.join(dir, '.planning', 'PROJECT.md');
    const state = path.join(dir, '.planning', 'STATE.md');
    fs.writeFileSync(project, 'Phase 1: Foo shipped.\n```\nPhase 2: Bar in a fence\n```\n');
    fs.writeFileSync(state, '# Project State\n\n**Current Phase:** Phase 2: Bar\n');

    const plan = computeMigrationPlan(dir);
    const result = applyMigration(dir, plan, { dryRun: false });

    assert.equal(result.applied, true);
    assert.ok(result.editedFiles.includes('PROJECT.md'));
    assert.ok(result.editedFiles.includes('STATE.md'));
    assert.equal(
      fs.readFileSync(project, 'utf8'),
      'Phase 1-01: Foo shipped.\n```\nPhase 2: Bar in a fence\n```\n',
    );
    const stateAfter = fs.readFileSync(state, 'utf8');
    assert.ok(stateAfter.includes('**Current Phase:** Phase 1-02: Bar'), 'STATE.md body reference rewritten');
    assert.ok(!stateAfter.includes('Phase 2: Bar'), 'no legacy reference left in STATE.md');
  });

  test('a CRLF PROJECT.md round-trips with every terminator intact', (t) => {
    const dir = setup('m13-crlf-project-', ROADMAP);
    t.after(() => cleanup(dir));
    const project = path.join(dir, '.planning', 'PROJECT.md');
    fs.writeFileSync(project, 'Phase 1: Foo shipped.\r\nbody\r\n');

    applyMigration(dir, computeMigrationPlan(dir), { dryRun: false });

    assert.equal(fs.readFileSync(project, 'utf8'), 'Phase 1-01: Foo shipped.\r\nbody\r\n');
  });

  test('a STATE.md with frontmatter keeps its frontmatter fields while the body reference is rewritten', (t) => {
    const dir = setup('m13-state-fm-', ROADMAP);
    t.after(() => cleanup(dir));
    const state = path.join(dir, '.planning', 'STATE.md');
    fs.writeFileSync(state, '---\nstatus: executing\n---\n\n# Project State\n\n**Current Phase:** Phase 2: Bar\n');

    applyMigration(dir, computeMigrationPlan(dir), { dryRun: false });

    const after = fs.readFileSync(state, 'utf8');
    assert.ok(after.startsWith('---\n'), 'frontmatter fence kept');
    assert.ok(after.includes('status: executing'), 'frontmatter field kept');
    assert.ok(after.includes('**Current Phase:** Phase 1-02: Bar'), 'body reference rewritten');
  });

  for (const target of ['PROJECT.md', 'STATE.md']) {
    test(`an unreadable ${target} (unterminated frontmatter) refuses the migration and rolls everything back`, (t) => {
      const dir = setup(`m13-unreadable-${target.slice(0, 3).toLowerCase()}-`, ROADMAP);
      t.after(() => cleanup(dir));
      const file = path.join(dir, '.planning', target);
      const unreadable = '---\ntitle: never closed\nPhase 1: Foo\n';
      fs.writeFileSync(file, unreadable);
      const before = fs.readFileSync(path.join(dir, '.planning', 'ROADMAP.md'), 'utf8');

      const plan = computeMigrationPlan(dir);
      assert.ok(plan.crossRefEdits.some((edit) => edit.file === target), `precondition: ${target} has planned edits`);

      assert.throws(() => applyMigration(dir, plan, { dryRun: false }), /Migration failed and rolled back/);
      assert.equal(fs.readFileSync(path.join(dir, '.planning', 'ROADMAP.md'), 'utf8'), before);
      assert.equal(fs.readFileSync(file, 'utf8'), unreadable);
      assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false);
    });
  }

  test('rewriteRoadmapLines: identical headings in two milestones stay distinct by line index; heading, checklist and fenced edits', () => {
    const lines = [
      '## v1.0: A', // 0
      '### Phase 1: Same', // 1
      '- [ ] Phase 1: Same', // 2
      '## v2.0: B', // 3
      '### Phase 1: Same', // 4
      '```', // 5
      '### Phase 1: Same', // 6 (fenced example)
      '- [ ] Phase 1: Same', // 7 (fenced example)
      '```', // 8
    ];
    const edits = [
      { lineIndex: 1, from: '### Phase 1: Same', to: '### Phase 1-01: Same' },
      { lineIndex: 2, from: '- [ ] Phase 1: Same', to: '- [ ] Phase 1-01: Same' },
      { lineIndex: 4, from: '### Phase 1: Same', to: '### Phase 2-01: Same' },
      { lineIndex: 6, from: '### Phase 1: Same', to: '### FENCED-MUST-NOT-APPEAR' },
      { lineIndex: 7, from: '- [ ] Phase 1: Same', to: '- [ ] FENCED-MUST-NOT-APPEAR' },
    ];

    const out = rewriteRoadmapLines(lines.join('\n'), edits).split('\n');

    assert.equal(out[1], '### Phase 1-01: Same');
    assert.equal(out[2], '- [ ] Phase 1-01: Same');
    assert.equal(out[4], '### Phase 2-01: Same');
    assert.deepEqual(out.slice(5), lines.slice(5), 'fenced example block is byte-identical');
    assert.equal(out.length, lines.length);
  });

  test('rewriteRoadmapLines: a CRLF roadmap keeps every terminator, converted lines included', () => {
    const content = '## v1.0: A\r\n### Phase 1: Foo\r\n- [x] Phase 1: Foo\r\ntext';
    const edits = [
      { lineIndex: 1, from: '### Phase 1: Foo\r', to: '### Phase 1-01: Foo\r' },
      { lineIndex: 2, from: '- [x] Phase 1: Foo\r', to: '- [x] Phase 1-01: Foo\r' },
    ];
    assert.equal(
      rewriteRoadmapLines(content, edits),
      '## v1.0: A\r\n### Phase 1-01: Foo\r\n- [x] Phase 1-01: Foo\r\ntext',
    );
  });

  test('a planned heading edit the seam cannot rewrite throws and rolls everything back', (t) => {
    // `###Phase 1:` has no space after the hashes, so it is not a CommonMark
    // heading: the planner's own regex reads it, the sectionizer does not.
    const dir = setup('m13-refused-', ['## v1.0: First Milestone', '', '###Phase 1: Foo', ''].join('\n'));
    t.after(() => cleanup(dir));
    const before = fs.readFileSync(path.join(dir, '.planning', 'ROADMAP.md'), 'utf8');

    const plan = computeMigrationPlan(dir);
    assert.ok(plan.roadmapEdits.length >= 1, 'precondition: the planner plans an edit for the heading');

    assert.throws(() => applyMigration(dir, plan, { dryRun: false }), /Migration failed and rolled back/);
    assert.equal(fs.readFileSync(path.join(dir, '.planning', 'ROADMAP.md'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false);
  });

  test('a plan file edited after the plan was computed is refused, never clobbered, and the rename rolls back', (t) => {
    const dir = setup('m13-stale-plan-', ROADMAP);
    t.after(() => cleanup(dir));
    const oldDir = path.join(dir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(oldDir, { recursive: true });
    const planFile = path.join(oldDir, '01-01-PLAN.md');
    fs.writeFileSync(planFile, 'edited after planning\n');

    const plan = {
      alreadyMigrated: false,
      phases: [
        {
          oldId: '1',
          newId: '1-01',
          oldDir: '01-foo',
          newDir: '1-01-foo',
          dependsOnRewrites: [
            { oldName: '01-01-PLAN.md', finalName: '01-01-PLAN.md', from: 'content at plan time\n', to: 'rewritten\n' },
          ],
        },
      ],
      roadmapEdits: [],
      crossRefEdits: [],
    };

    assert.throws(() => applyMigration(dir, plan, { dryRun: false }), /changed since the migration plan was computed/);
    assert.equal(fs.readFileSync(planFile, 'utf8'), 'edited after planning\n');
    assert.equal(fs.existsSync(path.join(dir, '.planning', 'phases', '1-01-foo')), false, 'rename rolled back');
  });
});

/**
 * #5048 — applyMigration's clean-tree check moved from a bare `execSync` to the
 * shared `execGit` seam, which is what gets GIT_OPTIONAL_LOCKS=0 there. The
 * trade is that `execGit` reports a timeout, a signal or a spawn failure as
 * `timedOut` / `signal` / `error` with `status ?? 1` and an empty stderr,
 * where `execSync` put the cause on the error it threw. Without branching on
 * those first, every one of them collapses into "git exited 1" and the reason
 * the migration could not start is gone. These rows pin the message per
 * cause; the env half of #5048 is covered in
 * tests/git-optional-locks-parity.test.cjs.
 */
describe('roadmap-upgrade clean-tree failure reports its cause (#5048)', () => {
  const EMPTY_PLAN = { alreadyMigrated: false, phases: [], roadmapEdits: [], crossRefEdits: [] };

  /**
   * Drive applyMigration with spawnSync faked to return `result`, and return
   * the error it threw. Patching the `node:child_process` module object (rather
   * than injecting) is what the tsc CommonJS emit allows: the compiled seam
   * holds the module and reads `.spawnSync` at CALL time.
   */
  function statusFailureThrows(t, result) {
    const childProcess = require('node:child_process');
    const dir = createTempDir('m3-status-fail-');
    t.after(() => {
      childProcess.spawnSync = realSpawnSync;
      cleanup(dir);
    });
    const realSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = () => result;
    let thrown;
    try {
      applyMigration(dir, EMPTY_PLAN, { dryRun: false });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'applyMigration resolved despite a failing git status');
    return thrown;
  }

  test('a timed-out status says so, with the bound it exceeded', (t) => {
    const err = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const thrown = statusFailureThrows(t, { status: null, stdout: '', stderr: '', signal: 'SIGTERM', error: err });
    assert.match(thrown.message, /^git status failed: git status timed out after 10000 ms$/);
  });

  test('a signalled status names the signal instead of reporting exit 1', (t) => {
    const thrown = statusFailureThrows(t, { status: null, stdout: '', stderr: '', signal: 'SIGKILL', error: null });
    assert.match(thrown.message, /^git status failed: git status was killed by SIGKILL$/);
  });

  test('a maxBuffer overflow reports the buffer cause, not a spawn failure and not "killed by SIGTERM"', (t) => {
    // spawnSync shape for stdout over maxBuffer: status null, signal SIGTERM,
    // error.code ENOBUFS. error must win over signal or the cause is dropped,
    // and the message must not claim git never started — it did run and was
    // killed for producing more output than the buffer holds.
    const err = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
    const thrown = statusFailureThrows(t, { status: null, stdout: '', stderr: '', signal: 'SIGTERM', error: err });
    assert.match(thrown.message, /^git status failed: spawnSync git ENOBUFS \(output exceeded the buffer\)$/);
  });

  test('a git binary that is missing reports the spawn failure, not a bare exit code', (t) => {
    const err = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
    const thrown = statusFailureThrows(t, { status: null, stdout: '', stderr: 'git: not found', signal: null, error: err });
    // The code is already in the message, so it is not repeated.
    assert.match(thrown.message, /^git status failed: spawnSync git ENOENT$/);
  });

  test('an EPERM kill on kill reports the code, not a claim that git never started', (t) => {
    // EPERM reaches the error branch with the process already started too, so
    // it must read the same way ENOBUFS does.
    const err = Object.assign(new Error('spawnSync git EPERM'), { code: 'EPERM' });
    const thrown = statusFailureThrows(t, { status: null, stdout: '', stderr: '', signal: 'SIGTERM', error: err });
    assert.match(thrown.message, /^git status failed: spawnSync git EPERM$/);
  });

  test('a genuine non-zero exit still surfaces git stderr verbatim', (t) => {
    const thrown = statusFailureThrows(t, { status: 128, stdout: '', stderr: 'fatal: detected dubious ownership', signal: null, error: null });
    assert.match(thrown.message, /^git status failed: fatal: detected dubious ownership$/);
  });

  test('a non-zero exit with no stderr falls back to the exit code', (t) => {
    const thrown = statusFailureThrows(t, { status: 2, stdout: '', stderr: '', signal: null, error: null });
    assert.match(thrown.message, /^git status failed: git exited 2$/);
  });
});
