'use strict';

/**
 * #6820 (Phase 2a of #6044 / epic #4908, ADR-4908): the resolver consumers take
 * the ProjectContext. Failing-first suite (matrix: T1-T12).
 *
 * Fixtures are real directories in mkdtemp dirs (realpath'd so macOS
 * /var -> /private/var never skews an equality), cleaned with t.after.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup, runGsdTools } = require('./helpers.cjs');

const { resolveProjectContext } = require('../gsd-core/bin/lib/project-context.cjs');
const projectRootModule = require('../gsd-core/bin/lib/project-root.cjs');
const verification = require('../gsd-core/bin/lib/verification.cjs');

function mkTmp(t, prefix = 'gsd-6820-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => cleanup(dir));
  return dir;
}

function write(file, body = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const UAT_BODY = '---\nstatus: testing\n---\n\n## Current Test\n\nnumber: 1\nname: Login\nexpected: user sees the dashboard\n';
const PHASE = '01-x';

/** repo/.planning is a symlink to ../repo-planning, which holds the phase + UAT file. */
function mkSymlinkedPlanning(t) {
  const base = mkTmp(t);
  const repo = path.join(base, 'repo');
  const store = path.join(base, 'repo-planning');
  fs.mkdirSync(repo, { recursive: true });
  write(path.join(store, 'phases', PHASE, `${PHASE}-UAT.md`), UAT_BODY);
  fs.symlinkSync(store, path.join(repo, '.planning'), 'dir');
  return { base, repo, store };
}

describe('uat render-checkpoint containment for planning artifacts (B9)', () => {
  test('renderCheckpointAcceptsUatFileUnderSymlinkedPlanningStore', (t) => {
    const { repo } = mkSymlinkedPlanning(t);
    const r = runGsdTools(['uat', 'render-checkpoint', '--file', `.planning/phases/${PHASE}/${PHASE}-UAT.md`], repo);
    assert.equal(r.success, true, r.error);
    assert.match(r.output, /Login/);
  });

  test('renderCheckpointStillWorksWithARealPlanningDirectory', (t) => {
    const repo = path.join(mkTmp(t), 'repo');
    write(path.join(repo, '.planning', 'phases', PHASE, `${PHASE}-UAT.md`), UAT_BODY);
    const r = runGsdTools(['uat', 'render-checkpoint', '--file', `.planning/phases/${PHASE}/${PHASE}-UAT.md`], repo);
    assert.equal(r.success, true, r.error);
    assert.match(r.output, /Login/);
  });

  test('renderCheckpointRefusesSiblingDirectorySharingThePlanningStorePrefix', (t) => {
    const { base, repo } = mkSymlinkedPlanning(t);
    const evil = path.join(base, 'repo-planning-evil', 'x-UAT.md');
    write(evil, UAT_BODY);
    const r = runGsdTools(['uat', 'render-checkpoint', '--file', evil], repo);
    assert.equal(r.success, false);
    assert.match(r.error, /validation failed|escapes/i);
  });

  test('renderCheckpointRefusesTraversalOutOfTheProject', (t) => {
    const { base, repo } = mkSymlinkedPlanning(t);
    write(path.join(base, 'outside', 'UAT.md'), UAT_BODY);
    const r = runGsdTools(['uat', 'render-checkpoint', '--file', '../outside/UAT.md'], repo);
    assert.equal(r.success, false);
    assert.match(r.error, /validation failed|escapes/i);
  });

  test('renderCheckpointRefusesSymlinkLeavingBothRoots', (t) => {
    const { base, repo, store } = mkSymlinkedPlanning(t);
    const target = path.join(base, 'outside', 'UAT.md');
    write(target, UAT_BODY);
    fs.symlinkSync(target, path.join(store, 'phases', PHASE, 'link-UAT.md'), 'file');
    const r = runGsdTools(['uat', 'render-checkpoint', '--file', `.planning/phases/${PHASE}/link-UAT.md`], repo);
    assert.equal(r.success, false);
    assert.match(r.error, /validation failed|escapes/i);
  });
});

describe('verification takes the context root, not a walk-up from the phase directory (B1-B3)', () => {
  function mkProject(root, withFile) {
    write(path.join(root, '.planning', 'PROJECT.md'), '# p\n');
    if (withFile) write(path.join(root, 'src', 'a.txt'), 'alpha\n');
  }

  /** Phase dir lives under A; the report's digest is taken over project B's files. */
  function mkTwoProjects(t, { aHasFile }) {
    const base = mkTmp(t);
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    mkProject(a, aHasFile);
    mkProject(b, true);
    const phaseDir = path.join(a, '.planning', 'phases', PHASE);
    const digest = verification.computeCoveredDigest(b, ['src/a.txt'], 4, { phaseDir });
    assert.equal(typeof digest, 'string', 'fixture digest must compute over project B');
    write(
      path.join(phaseDir, `${PHASE}-VERIFICATION.md`),
      `---\nstatus: passed\ncovered_files:\n  - src/a.txt\ncovered_digest: ${digest}\n---\n\n# Verification\n`,
    );
    return { a, b, phaseDir };
  }

  test('verificationReadsTheContextRootNotAWalkUpFromThePhaseDir', (t) => {
    const { b, phaseDir } = mkTwoProjects(t, { aHasFile: false });
    const ctx = resolveProjectContext(b, { explicit: b });
    const result = verification.readVerificationStatus(phaseDir, { ctx });
    assert.equal(result.status, 'passed');
  });

  test('verificationFailsClosedWhenTheContextRootDoesNotHoldTheCoveredFiles', (t) => {
    const { a, phaseDir } = mkTwoProjects(t, { aHasFile: false });
    const ctx = resolveProjectContext(a, { explicit: a });
    const result = verification.readVerificationStatus(phaseDir, { ctx });
    assert.equal(result.status, 'stale');
  });

  test('verificationWithoutContextResolvesThroughTheSeam', (t) => {
    const { a, phaseDir } = mkTwoProjects(t, { aHasFile: true });
    const viaSeam = verification.readVerificationStatus(phaseDir, { ctx: resolveProjectContext(a) });
    const bare = verification.readVerificationStatus(phaseDir);
    assert.equal(bare.status, viaSeam.status);
  });

  test('fingerprintHonorsProjectDirFromAnyCwd', (t) => {
    const base = mkTmp(t);
    const p = path.join(base, 'p');
    const elsewhere = path.join(base, 'elsewhere');
    mkProject(p, true);
    fs.mkdirSync(elsewhere, { recursive: true });
    const phaseDir = path.join(p, '.planning', 'phases', PHASE);
    fs.mkdirSync(phaseDir, { recursive: true });
    const args = ['verification', 'fingerprint', phaseDir, 'src/a.txt'];
    const fromElsewhere = runGsdTools([...args, '--project-dir', p], elsewhere);
    const fromInside = runGsdTools(args, p);
    assert.equal(fromElsewhere.success, true, fromElsewhere.error);
    assert.equal(fromInside.success, true, fromInside.error);
    assert.deepEqual(JSON.parse(fromElsewhere.output), JSON.parse(fromInside.output));
  });

  test('noExplicitRootLeaksBetweenResolutions', (t) => {
    const base = mkTmp(t);
    const p = path.join(base, 'p');
    const q = path.join(base, 'q');
    mkProject(p, false);
    mkProject(q, false);
    const first = resolveProjectContext(q, { explicit: p });
    const second = resolveProjectContext(q);
    assert.equal(first.provenance.source, 'explicit');
    assert.equal(first.projectRoot, p);
    assert.equal(second.provenance.source, 'ancestor');
    assert.equal(second.projectRoot, q);
  });
});

describe('the retired root resolvers (B6, B10)', () => {
  test('retiredRootResolversAreNotExported', () => {
    const exported = Object.keys(projectRootModule).sort();
    assert.deepEqual(exported, ['consentProjectRoot']);
  });

  test('consentProjectRootKeyIsStableAcrossSubdirectories', (t) => {
    const repo = path.join(mkTmp(t), 'repo');
    write(path.join(repo, '.planning', 'PROJECT.md'), '# p\n');
    const sub = path.join(repo, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(projectRootModule.consentProjectRoot(sub), fs.realpathSync.native(repo));
    assert.equal(projectRootModule.consentProjectRoot(repo), fs.realpathSync.native(repo));

    const linked = mkSymlinkedPlanning(t);
    assert.equal(projectRootModule.consentProjectRoot(linked.repo), fs.realpathSync.native(linked.repo));

    const bare = mkTmp(t);
    assert.equal(projectRootModule.consentProjectRoot(bare), bare);
  });
});
