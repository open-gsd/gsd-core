'use strict';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const { computeMigrationPlan, applyMigration, rewriteRoadmapLines } = require('../gsd-core/bin/lib/roadmap-upgrade.cjs');
const { normalizeContent } = require('../gsd-core/bin/lib/shell-command-projection.cjs');

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

  // #5120: the rollback restored STATE.md with a raw `fs.writeFileSync`, outside
  // the STATE.md lock, so a concurrent writer could interleave with the restore
  // (the #500/#905/#1230 lost-update family). Reaching the restore needs a
  // failure AFTER the STATE.md rewrite: a directory at config.json fails step 4.
  test('a failure after the STATE.md rewrite restores STATE.md through the seam, under the STATE.md lock', (t) => {
    const dir = setup('m13-state-restore-', ROADMAP);
    t.after(() => cleanup(dir));
    const state = path.join(dir, '.planning', 'STATE.md');
    const original = '---\r\nstatus: executing\r\nlast_updated: "2020-01-01T00:00:00.000Z"\r\n---\r\n\r\n# Project State\r\n\r\n**Current Phase:** Phase 2: Bar\r\n';
    fs.writeFileSync(state, original);
    const plan = computeMigrationPlan(dir);
    assert.ok(plan.crossRefEdits.some((edit) => edit.file === 'STATE.md'), 'precondition: STATE.md has planned edits');
    fs.mkdirSync(path.join(dir, '.planning', 'config.json'));

    const writesOntoState = [];
    const record = (destination) => {
      if (path.resolve(String(destination)) === path.resolve(state)) {
        writesOntoState.push({ lockHeld: fs.existsSync(`${state}.lock`) });
      }
    };
    const realWrite = fs.writeFileSync;
    const realRename = fs.renameSync;
    mock.method(fs, 'writeFileSync', function (file, ...rest) { record(file); return realWrite.call(this, file, ...rest); });
    mock.method(fs, 'renameSync', function (from, to) { record(to); return realRename.call(this, from, to); });
    t.after(() => mock.restoreAll());

    // #5759 made the config.json step refuse a non-regular file by name (EISDIR); the directory still fails step 4.
    assert.throws(() => applyMigration(dir, plan, { dryRun: false }), /Migration failed and rolled back: config\.json cannot be updated/);
    mock.restoreAll();

    assert.equal(writesOntoState.length, 2, 'the forward rewrite and the restore each land one write on STATE.md');
    assert.deepEqual(writesOntoState, [{ lockHeld: true }, { lockHeld: true }], 'every write onto STATE.md holds the STATE.md lock');
    // The restore goes through the seam's byte-exact primitive (platformRestoreFileSync,
    // #5831), so the CRLF backup comes back as it was, not in the seam's normalized form.
    assert.notEqual(normalizeContent(state, original).content, original, 'precondition: the CRLF fixture is one platformWriteSync would normalize');
    assert.equal(fs.readFileSync(state, 'utf8'), original, 'STATE.md restored to the backup, byte for byte');
    assert.equal(fs.existsSync(`${state}.lock`), false, 'the lock is released after the restore');
  });

  test('a STATE.md restore that cannot take the lock is named, never reported as rolled back', (t) => {
    const dir = setup('m13-state-restore-nolock-', ROADMAP);
    t.after(() => cleanup(dir));
    const state = path.join(dir, '.planning', 'STATE.md');
    fs.writeFileSync(state, '# Project State\n\n**Current Phase:** Phase 2: Bar\n');
    const plan = computeMigrationPlan(dir);
    fs.mkdirSync(path.join(dir, '.planning', 'config.json'));

    // The forward rewrite takes the lock first; the restore's acquisition fails
    // with an errno acquireStateLock does not retry.
    let lockOpens = 0;
    const realOpen = fs.openSync;
    mock.method(fs, 'openSync', function (file, ...rest) {
      if (String(file) === `${state}.lock` && ++lockOpens === 2) {
        throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      }
      return realOpen.call(this, file, ...rest);
    });
    t.after(() => mock.restoreAll());

    assert.throws(
      () => applyMigration(dir, plan, { dryRun: false }),
      (err) => err.message.startsWith(`Migration failed and was NOT fully rolled back (not restored: ${state}): config.json cannot be updated`),
    );
    mock.restoreAll();
    assert.equal(lockOpens, 2, 'the restore attempted the lock');
    assert.ok(fs.readFileSync(state, 'utf8').includes('Phase 1-02: Bar'), 'STATE.md still holds the migrated text the error names');
  });

  // #5120 review (M4): the rollback restores STATE.md only while it still holds what
  // this migration wrote. A writer that landed between the forward write and the
  // failing step keeps its content, and the error says so.
  test('a STATE.md another writer changed after the migration wrote it is left as found by the rollback', (t) => {
    const dir = setup('m13-state-other-writer-', ROADMAP);
    t.after(() => cleanup(dir));
    const state = path.join(dir, '.planning', 'STATE.md');
    fs.writeFileSync(state, '# Project State\n\n**Current Phase:** Phase 2: Bar\n');
    const plan = computeMigrationPlan(dir);
    assert.ok(plan.crossRefEdits.some((edit) => edit.file === 'STATE.md'), 'precondition: STATE.md has planned edits');
    fs.mkdirSync(path.join(dir, '.planning', 'config.json'));

    // The other writer lands while the migration is at its next step (the config.json
    // read that fails), after the forward STATE.md write and its read-back: the first
    // config.json access made once STATE.md no longer holds its original content
    // (config.json is also consulted before step 3, which must not trigger it).
    const configPath = path.join(dir, '.planning', 'config.json');
    const original = fs.readFileSync(state, 'utf8');
    const otherWriter = '# Project State\n\n**Current Phase:** Phase 9: Other writer\n';
    let injected = false;
    const realWrite = fs.writeFileSync;
    const realOpen = fs.openSync;
    const realRead = fs.readFileSync;
    const realStat = fs.statSync;
    const inject = (file) => {
      if (!injected && String(file) === configPath && realRead.call(fs, state, 'utf8') !== original) {
        injected = true;
        realWrite.call(fs, state, otherWriter);
      }
    };
    mock.method(fs, 'openSync', function (file, ...rest) { inject(file); return realOpen.call(this, file, ...rest); });
    mock.method(fs, 'readFileSync', function (file, ...rest) { inject(file); return realRead.call(this, file, ...rest); });
    mock.method(fs, 'statSync', function (file, ...rest) { inject(file); return realStat.call(this, file, ...rest); });
    t.after(() => mock.restoreAll());

    assert.throws(
      () => applyMigration(dir, plan, { dryRun: false }),
      (err) => err.message.startsWith('Migration failed and rolled back, except STATE.md: another writer changed it after this migration wrote it, so it is left as found: config.json cannot be updated'),
    );
    mock.restoreAll();
    assert.equal(injected, true, 'precondition: the other writer ran');
    assert.equal(fs.readFileSync(state, 'utf8'), otherWriter, 'the other writer\'s STATE.md is not overwritten by the rollback');
    assert.equal(fs.existsSync(`${state}.lock`), false, 'the lock is released');
  });

  test('a STATE.md the migration never wrote is left alone by the rollback (#5120 review)', (t) => {
    const dir = setup('m13-state-untouched-', ROADMAP);
    t.after(() => cleanup(dir));
    const state = path.join(dir, '.planning', 'STATE.md');
    const original = '# Project State\n\n**Current Phase:** Phase 2: Bar\n';
    fs.writeFileSync(state, original);
    const plan = computeMigrationPlan(dir);

    // The forward STATE.md write cannot take the lock, so it changes nothing and
    // fails the migration; a restore here could only overwrite another writer.
    let lockOpens = 0;
    const realOpen = fs.openSync;
    mock.method(fs, 'openSync', function (file, ...rest) {
      if (String(file) === `${state}.lock`) {
        lockOpens++;
        throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      }
      return realOpen.call(this, file, ...rest);
    });
    t.after(() => mock.restoreAll());

    assert.throws(() => applyMigration(dir, plan, { dryRun: false }), /^Error: Migration failed and rolled back: /);
    mock.restoreAll();
    assert.equal(lockOpens, 1, 'only the forward write asked for the lock; the rollback did not restore STATE.md');
    assert.equal(fs.readFileSync(state, 'utf8'), original);
  });

  // #5120 review (m1): the forward STATE.md write is the seam's atomic mode
  // (atomicWrite, the prune precedent #5831), so a write that fails leaves
  // STATE.md's previous bytes in place and dropping its snapshot is safe. Without
  // it, a temp file that cannot be written or renamed falls back to an in-place
  // write that truncates first; a failure there (ENOSPC) whose own restore also
  // fails left STATE.md truncated while the migration reported "rolled back".
  test('a forward STATE.md write that fails mid-write leaves STATE.md as it was, and the rollback says so truthfully (#5120 review)', (t) => {
    const dir = setup('m13-state-enospc-', ROADMAP);
    t.after(() => cleanup(dir));
    const state = path.join(dir, '.planning', 'STATE.md');
    const original = '# Project State\n\n**Current Phase:** Phase 2: Bar\n';
    fs.writeFileSync(state, original);
    const plan = computeMigrationPlan(dir);
    assert.ok(plan.crossRefEdits.some((edit) => edit.file === 'STATE.md'), 'precondition: STATE.md has planned edits');

    // Every descriptor opened on STATE.md or a STATE.md temp file fails its writes
    // with ENOSPC, and a rename onto STATE.md fails with EXDEV.
    const stateFds = new Set();
    const isStatePath = (p) => String(p) === state || String(p).startsWith(`${state}.tmp.`);
    const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const realOpen = fs.openSync;
    const realWrite = fs.writeFileSync;
    const realWriteSync = fs.writeSync;
    const realRename = fs.renameSync;
    let failedWrites = 0;
    mock.method(fs, 'openSync', function (file, ...rest) {
      const fd = realOpen.call(this, file, ...rest);
      if (isStatePath(file)) stateFds.add(fd);
      return fd;
    });
    mock.method(fs, 'writeFileSync', function (target, ...rest) {
      if (typeof target === 'number' && stateFds.has(target)) { failedWrites++; throw enospc(); }
      return realWrite.call(this, target, ...rest);
    });
    mock.method(fs, 'writeSync', function (fd, ...rest) {
      if (stateFds.has(fd)) { failedWrites++; throw enospc(); }
      return realWriteSync.call(this, fd, ...rest);
    });
    mock.method(fs, 'renameSync', function (from, to) {
      if (String(to) === state) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      return realRename.call(this, from, to);
    });
    t.after(() => mock.restoreAll());

    assert.throws(() => applyMigration(dir, plan, { dryRun: false }), /^Error: Migration failed and rolled back: ENOSPC/);
    mock.restoreAll();
    assert.ok(failedWrites >= 1, 'precondition: the injected ENOSPC was hit');
    assert.equal(fs.readFileSync(state, 'utf8'), original, 'STATE.md holds its previous bytes, as "rolled back" claims');
    assert.equal(fs.existsSync(`${state}.lock`), false, 'the lock is released');
  });

  // #5120 review (m2): the STATE.md snapshot is held as bytes, not decoded text,
  // so a byte sequence that is not valid UTF-8 comes back unchanged.
  test('the rollback restores a STATE.md holding invalid UTF-8 byte for byte (#5120 review)', (t) => {
    const dir = setup('m13-state-bytes-', ROADMAP);
    t.after(() => cleanup(dir));
    const state = path.join(dir, '.planning', 'STATE.md');
    const original = Buffer.concat([
      Buffer.from('# Project State\n\n**Current Phase:** Phase 2: Bar\n\nLegacy note: '),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from('\n'),
    ]);
    fs.writeFileSync(state, original);
    assert.notDeepEqual(Buffer.from(original.toString('utf8'), 'utf8'), original, 'precondition: the bytes do not survive a UTF-8 round-trip');
    const plan = computeMigrationPlan(dir);
    assert.ok(plan.crossRefEdits.some((edit) => edit.file === 'STATE.md'), 'precondition: STATE.md has planned edits');
    fs.mkdirSync(path.join(dir, '.planning', 'config.json'));

    assert.throws(() => applyMigration(dir, plan, { dryRun: false }), /^Error: Migration failed and rolled back: config\.json cannot be updated/);
    assert.ok(fs.readFileSync(state).equals(original), 'STATE.md restored to the snapshot bytes exactly');
  });

  // #5120 review (N3): STATE.md is reported as edited only when this migration
  // wrote it. A writer that applied the same edit first makes the transform a
  // no-op under the lock, so nothing is written and STATE.md is not listed.
  test('editedFiles names STATE.md only when the migration wrote it (#5120 review)', (t) => {
    // The other writer's STATE.md: what this migration itself would leave behind.
    const twin = setup('m13-state-twin-', ROADMAP);
    t.after(() => cleanup(twin));
    const original = '# Project State\n\n**Current Phase:** Phase 2: Bar\n';
    fs.writeFileSync(path.join(twin, '.planning', 'STATE.md'), original);
    const twinResult = applyMigration(twin, computeMigrationPlan(twin), { dryRun: false });
    assert.ok(twinResult.editedFiles.includes('STATE.md'), 'precondition: a migration that writes STATE.md lists it');
    const migrated = fs.readFileSync(path.join(twin, '.planning', 'STATE.md'), 'utf8');

    const dir = setup('m13-state-noop-', ROADMAP);
    t.after(() => cleanup(dir));
    const state = path.join(dir, '.planning', 'STATE.md');
    fs.writeFileSync(state, original);
    const plan = computeMigrationPlan(dir);
    // The other writer lands just before this migration takes the STATE.md lock.
    let injected = false;
    const realOpen = fs.openSync;
    const realWrite = fs.writeFileSync;
    mock.method(fs, 'openSync', function (file, ...rest) {
      if (!injected && String(file) === `${state}.lock`) {
        injected = true;
        realWrite.call(fs, state, migrated);
      }
      return realOpen.call(this, file, ...rest);
    });
    t.after(() => mock.restoreAll());

    const result = applyMigration(dir, plan, { dryRun: false });
    mock.restoreAll();
    assert.equal(injected, true, 'precondition: the other writer ran');
    assert.equal(result.applied, true);
    assert.equal(result.editedFiles.includes('STATE.md'), false, 'STATE.md is not reported as edited by this migration');
    assert.equal(fs.readFileSync(state, 'utf8'), migrated, 'the other writer\'s STATE.md is untouched');
  });

  // #5120 re-review (Major-1): the STATE.md snapshot is taken under the STATE.md
  // lock, from the file the migration actually rewrites. Taken before the lock, a
  // writer that landed while the migration waited for the lock was missing from the
  // snapshot, so the rollback put the older bytes back over that writer's content
  // and still reported "rolled back".
  test('a writer that lands while the migration waits for the STATE.md lock survives the rollback (#5120 re-review)', (t) => {
    const dir = setup('m13-state-wait-writer-', ROADMAP);
    t.after(() => cleanup(dir));
    const state = path.join(dir, '.planning', 'STATE.md');
    const original = '# Project State\n\n**Current Phase:** Phase 2: Bar\n';
    fs.writeFileSync(state, original);
    const plan = computeMigrationPlan(dir);
    assert.ok(plan.crossRefEdits.some((edit) => edit.file === 'STATE.md'), 'precondition: STATE.md has planned edits');
    fs.mkdirSync(path.join(dir, '.planning', 'config.json')); // a later step fails, so the rollback runs

    // The other writer appends its note just before this migration's first lock
    // open: it held the lock and released it while the migration was waiting.
    const withNote = `${original}\nOther writer note: keep me\n`;
    let injected = false;
    const realOpen = fs.openSync;
    const realWrite = fs.writeFileSync;
    mock.method(fs, 'openSync', function (file, ...rest) {
      if (!injected && String(file) === `${state}.lock`) {
        injected = true;
        realWrite.call(fs, state, withNote);
      }
      return realOpen.call(this, file, ...rest);
    });
    t.after(() => mock.restoreAll());

    assert.throws(() => applyMigration(dir, plan, { dryRun: false }), /^Error: Migration failed and rolled back: config\.json cannot be updated/);
    mock.restoreAll();
    assert.equal(injected, true, 'precondition: the other writer ran');
    assert.equal(fs.readFileSync(state, 'utf8'), withNote, 'the rollback restores the STATE.md the migration rewrote, the other writer\'s note included');
  });

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

  // #5048 review (Minor 8): production never compares elapsed time against the
  // bound, so a stub that models spawnSync's own timeout contract only tests the
  // stub. What carries information is that the bound handed to git is the bound
  // the message names.
  test('a timed-out status says so, and names the bound the seam handed to git', (t) => {
    const childProcess = require('node:child_process');
    const dir = createTempDir('m3-status-bound-');
    const realSpawnSync = childProcess.spawnSync;
    let passedTimeout;
    t.after(() => {
      childProcess.spawnSync = realSpawnSync;
      cleanup(dir);
    });
    childProcess.spawnSync = (_cmd, _args, opts) => {
      passedTimeout = opts.timeout;
      return {
        status: null,
        stdout: '',
        stderr: '',
        signal: 'SIGTERM',
        error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      };
    };
    let thrown;
    try {
      applyMigration(dir, EMPTY_PLAN, { dryRun: false });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'applyMigration resolved despite a failing git status');
    assert.match(thrown.message, /^git status failed: git status timed out after 10000 ms$/);
    assert.equal(String(passedTimeout), /after (\d+) ms/.exec(thrown.message)[1], 'the reported bound must be the one handed to git');
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
