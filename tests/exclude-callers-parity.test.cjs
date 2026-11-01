'use strict';

/**
 * Parity between the two callers of the shared `excludeFromGit` writer (#5505, #5551):
 * the state.json publisher and the milestone claim. Each must respect the user's decision
 * about the file (a negation, in any spelling git reads as naming it), and the publisher
 * must edit only a repo that owns the project.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { publishStateContract } = require('../gsd-core/bin/lib/state-contract.cjs');
const { excludeFromGit } = require('../gsd-core/bin/lib/git-info-exclude.cjs');
const { claimMilestonePhase } = require('../gsd-core/bin/lib/milestone-lock.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const git = (cwd, ...args) => gitOrThrow(args, { cwd });
const excludeOf = (cwd) => path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'info/exclude').trim());
const planningDirOf = (cwd) => path.join(cwd, '.planning');
const fixedDeps = () => ({ now: () => 1_700_000_000_000 });

describe('excludeFromGit callers agree (#5505, #5551)', () => {
  const spellings = ['!state.json', '!.planning/state.json', '!/.planning/state.json'];

  for (const spelling of spellings) {
    test(`anyNegationSpellingOfTheFileIsRespected:${spelling}`, (t) => {
      const tmpDir = createTempGitProject();
      t.after(() => cleanup(tmpDir));
      const exclude = excludeOf(tmpDir);
      fs.appendFileSync(exclude, `${spelling}\n`);
      const before = fs.readFileSync(exclude, 'utf8');
      publishStateContract(tmpDir, fixedDeps());
      assert.strictEqual(fs.readFileSync(exclude, 'utf8'), before, 'publish');
      excludeFromGit(planningDirOf(tmpDir), 'state.json');
      assert.strictEqual(fs.readFileSync(exclude, 'utf8'), before, 'excludeFromGit');
    });

    test(`anyNegationSpellingOfTheLockIsRespected:${spelling.replace('state.json', 'milestone.lock')}`, (t) => {
      const tmpDir = createTempGitProject();
      t.after(() => cleanup(tmpDir));
      const exclude = excludeOf(tmpDir);
      fs.appendFileSync(exclude, `${spelling.replace('state.json', 'milestone.lock')}\n`);
      const before = fs.readFileSync(exclude, 'utf8');
      claimMilestonePhase(tmpDir, '1');
      assert.strictEqual(fs.readFileSync(exclude, 'utf8'), before);
    });
  }

  test('aNegationOfAnotherFileNeverSuppressesTheEntry', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    fs.appendFileSync(excludeOf(tmpDir), '!other.json\n!*.log\n');
    publishStateContract(tmpDir, fixedDeps());
    assert.ok(splitLines(fs.readFileSync(excludeOf(tmpDir), 'utf8')).includes('/.planning/state.json'));
  });

  test('anEnclosingRepoThatTracksNothingUnderTheProjectIsLeftAlone', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(planningDirOf(sub), { recursive: true });
    const exclude = excludeOf(tmpDir);
    const before = fs.readFileSync(exclude, 'utf8');
    assert.strictEqual(publishStateContract(sub, fixedDeps()).published, true);
    assert.strictEqual(fs.readFileSync(exclude, 'utf8'), before);
  });

  test('aProjectNestedInAnEnclosingRepoThatTracksItGetsTheEntry', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(planningDirOf(sub), { recursive: true });
    fs.writeFileSync(path.join(sub, 'tracked.txt'), 'x');
    git(tmpDir, 'add', '--', path.join(sub, 'tracked.txt'));
    publishStateContract(sub, fixedDeps());
    assert.ok(splitLines(fs.readFileSync(excludeOf(tmpDir), 'utf8')).includes('/sub/.planning/state.json'));
  });

  test('aProjectRootWithItsOwnGitDirGetsTheEntry', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(planningDirOf(sub), { recursive: true });
    git(sub, 'init', '-q');
    publishStateContract(sub, fixedDeps());
    assert.ok(splitLines(fs.readFileSync(excludeOf(sub), 'utf8')).includes('/.planning/state.json'));
  });

  // Pins the docs: the claim's exclude entry is written whatever commit_docs says.
  test('aMilestoneClaimExcludesTheLockEvenWithCommitDocsFalse', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(planningDirOf(tmpDir), 'config.json'), JSON.stringify({ planning: { commit_docs: false } }));
    claimMilestonePhase(tmpDir, '1');
    assert.ok(splitLines(fs.readFileSync(excludeOf(tmpDir), 'utf8')).includes('/.planning/milestone.lock'));
  });
});
