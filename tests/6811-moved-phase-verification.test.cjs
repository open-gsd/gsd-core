'use strict';

// 6811-moved-phase-verification.test.cjs — a `passed` VERIFICATION report
// keeps reading `passed` after its phase directory is moved with no byte
// changed (#6811). The movers are `milestone complete` (flat and `--ws`),
// `phases clear` (with its `.N` collision suffix), `workstream complete` and a
// plain `mv` (the cleanup workflow's). One changed covered byte after the move
// still reads `stale`, and `moved_files` does not name a file that was only
// renamed. Every v5 report here is written from the built CLI's own
// `verification fingerprint` output; v1-v4 digests come from the built
// `computeCoveredDigest` at that version, over the same covered set.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  runGsdTools,
  createTempGitProject,
  createTempProject,
  createTempDir,
  cleanup,
  scrubConfigLocationEnv,
} = require('./helpers.cjs');
const { withHome } = require('./helpers/isolated-env.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { computeCoveredDigest, parseFingerprintVersion } = require('../gsd-core/bin/lib/verification.cjs');

const PHASE = '01-foo';
const REPORT = '01-VERIFICATION.md';
const VERSIONS = [1, 2, 3, 4, 5];

// Fixed clocks: covered inputs, then the report, both before any commit this
// test makes; an edit after the move is dated after every commit.
const INPUTS_AT = new Date('2001-01-01T00:00:00Z');
const REPORT_AT = new Date('2001-01-01T00:01:00Z');
const EDITED_AT = new Date('2100-01-01T00:00:00Z');

// The issue's ROADMAP: after `milestone complete`, phase 1 resolves to its archive.
const ROADMAP = '# Roadmap\n\n## v1.0\n\n- [x] Phase 1: Foo\n';

const SYMLINK_SKIP = process.platform === 'win32' ? 'symlink creation needs elevated privilege on Windows' : false;

// One HOME sandbox and one config-location scrub per test context.
const ISOLATED = new WeakSet();
function isolate(t) {
  if (ISOLATED.has(t)) return;
  ISOLATED.add(t);
  const home = createTempDir('gsd-6811-home-');
  t.after(() => cleanup(home));
  withHome(t, home);
  t.after(scrubConfigLocationEnv());
}

const posixRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

function git(root, args) {
  return gitOrThrow(args, { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
}

function commitAll(root, message) {
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', message]);
}

function writeFile(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

/**
 * A git project with one completed phase `01-foo`, flat under `.planning/` or
 * inside workstream `ws`. The base holds the ROADMAP, REQUIREMENTS and STATE
 * the movers read.
 */
function project(t, { ws = null } = {}) {
  isolate(t);
  const root = createTempGitProject('gsd-6811-');
  t.after(() => cleanup(root));
  const planning = path.join(root, '.planning');
  const base = ws ? path.join(planning, 'workstreams', ws) : planning;
  const phaseDir = path.join(base, 'phases', PHASE);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(planning, 'config.json'), '{}\n');
  fs.writeFileSync(path.join(base, 'ROADMAP.md'), ROADMAP);
  fs.writeFileSync(path.join(base, 'REQUIREMENTS.md'), '# Requirements\n\n- [x] FOO-01\n');
  fs.writeFileSync(path.join(base, 'STATE.md'), '---\nmilestone: v1.0\n---\n# State\n');
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), `---\nphase: ${PHASE}\nplan: 01\n---\n# plan\n`);
  fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), `---\nphase: ${PHASE}\nplan: 01\n---\n# summary\n`);
  writeFile(root, 'src/a.js', 'export const a = 1;\n');
  return {
    root,
    planning,
    base,
    phaseDir,
    roadmapRel: posixRel(root, path.join(base, 'ROADMAP.md')),
    requirementsRel: posixRel(root, path.join(base, 'REQUIREMENTS.md')),
  };
}

function writeReport(phaseDir, coveredFiles, digest, reportStatus = 'passed') {
  fs.writeFileSync(
    path.join(phaseDir, REPORT),
    [
      '---', `phase: ${PHASE}`, `status: ${reportStatus}`,
      'covered_files:', ...coveredFiles.map((f) => `  - "${f}"`),
      `covered_digest: "${digest}"`, '---', '# Verification', '',
    ].join('\n'),
  );
}

function fingerprint(root, phaseDir, declared, extraArgs = []) {
  const res = runGsdTools(['verification', 'fingerprint', phaseDir, ...declared, ...extraArgs], root);
  assert.equal(res.success, true, `fingerprint should succeed: ${res.output}${res.error}`);
  return JSON.parse(res.output);
}

/** A digest of `version` over the CLI's covered set: v5 is the CLI's own output. */
function digestAt(root, phaseDir, fp, version) {
  const digest = version === 5 ? fp.covered_digest : computeCoveredDigest(root, fp.covered_files, version, { phaseDir });
  assert.equal(parseFingerprintVersion(digest), version);
  assert.equal(digest.length, `v${version}:sha256:`.length + 64);
  return digest;
}

/**
 * Fingerprint through the built CLI and write the report from its output.
 * `omitArtifacts` declares only the files passed in, as a hand-written report
 * may: the v3+ digest still covers the phase's own plans and summaries.
 */
function verify(root, phaseDir, declared, { reportStatus = 'passed', omitArtifacts = false, version = 5 } = {}) {
  const fp = fingerprint(root, phaseDir, declared);
  writeReport(phaseDir, omitArtifacts ? declared : fp.covered_files, digestAt(root, phaseDir, fp, version), reportStatus);
  return fp;
}

function status(root, phaseDir, extraArgs = []) {
  const res = runGsdTools(['verification', 'status', phaseDir, ...extraArgs], root);
  assert.equal(res.success, true, `verification status should run: ${res.error}`);
  return JSON.parse(res.output);
}

/**
 * Pin every covered file's clock before the move, and the report's after
 * them. A rename keeps mtimes, so only a file written after the move can be
 * newer than the report.
 */
function stampTimes(root, phaseDir, extra = []) {
  for (const name of fs.readdirSync(phaseDir)) fs.utimesSync(path.join(phaseDir, name), INPUTS_AT, INPUTS_AT);
  for (const rel of ['src/a.js', ...extra]) fs.utimesSync(path.join(root, rel), INPUTS_AT, INPUTS_AT);
  fs.utimesSync(path.join(phaseDir, REPORT), REPORT_AT, REPORT_AT);
}

/** Write a file and date it after every commit, so the moved-files clock is unambiguous. */
function editLater(file, content) {
  fs.writeFileSync(file, content);
  fs.utimesSync(file, EDITED_AT, EDITED_AT);
}

/**
 * A verified, committed phase: fingerprinted by the CLI and reading its
 * report's status where it lives. `extra` names more root-relative files to
 * create and declare.
 */
function verifiedProject(t, {
  ws = null,
  declareRoadmap = true,
  declareRequirements = false,
  extra = [],
  version = 5,
  reportStatus = 'passed',
  omitArtifacts = false,
} = {}) {
  const p = project(t, { ws });
  for (const rel of extra) writeFile(p.root, rel, `${rel}\n`);
  const declared = [
    'src/a.js',
    ...(declareRoadmap ? [p.roadmapRel] : []),
    ...(declareRequirements ? [p.requirementsRel] : []),
    ...extra,
  ];
  verify(p.root, p.phaseDir, declared, { reportStatus, omitArtifacts, version });
  stampTimes(p.root, p.phaseDir, extra);
  commitAll(p.root, 'verified');
  assert.equal(status(p.root, p.phaseDir).status, reportStatus, 'precondition: the report reads its own status before the move');
  return p;
}

function completeMilestone(root, extraArgs = []) {
  const res = runGsdTools(['milestone', 'complete', 'v1.0', '--name', 'Foo', ...extraArgs, '--confirm'], root);
  assert.equal(res.success, true, res.error);
}

/** `workstream complete ws`; returns the archive directory. */
function completeWorkstream(root) {
  const res = runGsdTools(['workstream', 'complete', 'ws', '--raw'], root);
  assert.equal(res.success, true, res.error);
  const out = JSON.parse(res.output);
  assert.equal(out.completed, true);
  return path.join(root, out.archived_to);
}

const archivedPhase = (base) => path.join(base, 'milestones', 'v1.0-phases', PHASE);

function assertStatus(root, phaseDir, expected) {
  assert.equal(fs.existsSync(path.join(phaseDir, REPORT)), true, `the report moved to ${phaseDir}`);
  assert.equal(status(root, phaseDir).status, expected);
}

const assertPassed = (root, phaseDir) => assertStatus(root, phaseDir, 'passed');

describe('#6811: a moved phase directory keeps its passed verification', () => {
  test('milestone complete: the archived phase reads passed, and init verify-work reports it complete', (t) => {
    const p = verifiedProject(t);
    completeMilestone(p.root);
    assert.equal(fs.existsSync(p.phaseDir), false, 'the phase left .planning/phases/');
    assertPassed(p.root, archivedPhase(p.planning));

    const init = runGsdTools(['init', 'verify-work', '1'], p.root);
    assert.equal(init.success, true, init.error);
    const completion = JSON.parse(init.output).phase_completion;
    assert.equal(typeof completion, 'object');
    assert.notEqual(completion, null);
    assert.equal(completion.verification_status, 'passed');
    assert.equal(completion.phase_complete, true);
  });

  test('a committed plain mv into milestones/<v>-phases/ (the cleanup workflow shape) reads passed', (t) => {
    const p = verifiedProject(t);
    const dest = archivedPhase(p.planning);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(p.phaseDir, dest);
    commitAll(p.root, 'archive');
    assertPassed(p.root, dest);
  });

  test('phases clear onto a same-named archive entry: the .N directory reads passed', (t) => {
    const p = verifiedProject(t);
    const archiveDir = path.dirname(archivedPhase(p.planning));
    // An earlier archive of a same-named phase forces the collision suffix.
    writeFile(p.root, posixRel(p.root, path.join(archiveDir, PHASE, '01-01-PLAN.md')), '# an older phase 1\n');
    // The outgoing version, as new-milestone passes it.
    const res = runGsdTools(['phases', 'clear', '--confirm', '--archive-version', 'v1.0'], p.root);
    assert.equal(res.success, true, res.error);
    const suffixed = path.join(archiveDir, `${PHASE}.1`);
    assert.equal(fs.existsSync(suffixed), true, 'phases clear suffixed the colliding name');
    assertPassed(p.root, suffixed);
  });

  test('milestone complete --ws: the archived workstream phase reads passed and its ROADMAP stays shared', (t) => {
    const p = verifiedProject(t, { ws: 'ws' });
    completeMilestone(p.root, ['--ws', 'ws']);
    assert.equal(fs.existsSync(p.phaseDir), false, 'the phase left the workstream phases/');
    assertPassed(p.root, archivedPhase(p.base));

    fs.appendFileSync(path.join(p.base, 'ROADMAP.md'), '\n- [ ] Phase 2: Next\n');
    assertPassed(p.root, archivedPhase(p.base));
  });

  test('workstream complete: the phase inside the archived workstream reads passed, its declared ROADMAP moved with it', (t) => {
    const p = verifiedProject(t, { ws: 'ws' });
    const archive = completeWorkstream(p.root);
    assert.equal(fs.existsSync(p.base), false, 'the workstream directory is gone');
    assertPassed(p.root, path.join(archive, 'phases', PHASE));
  });

  test('milestone complete --ws, then workstream complete: the twice-moved phase reads passed', (t) => {
    const p = verifiedProject(t, { ws: 'ws' });
    completeMilestone(p.root, ['--ws', 'ws']);
    assertPassed(p.root, archivedPhase(completeWorkstream(p.root)));
  });

  test('a report fingerprinted inside a workstream milestone archive reads passed after workstream complete', (t) => {
    const p = project(t, { ws: 'ws' });
    completeMilestone(p.root, ['--ws', 'ws']);
    verify(p.root, archivedPhase(p.base), ['src/a.js', p.roadmapRel]);
    assertPassed(p.root, archivedPhase(p.base));
    assertPassed(p.root, archivedPhase(completeWorkstream(p.root)));
  });

  test('a report that declares none of the phase\'s own plans and summaries reads passed after the move', (t) => {
    const p = verifiedProject(t, { omitArtifacts: true });
    completeMilestone(p.root);
    assertPassed(p.root, archivedPhase(p.planning));
  });

  test('an archived gaps_found report keeps reading gaps_found', (t) => {
    const p = verifiedProject(t, { reportStatus: 'gaps_found' });
    completeMilestone(p.root);
    assertStatus(p.root, archivedPhase(p.planning), 'gaps_found');
  });

  test('a fresh fingerprint of an archived workstream phase keeps the workstream ROADMAP shared', (t) => {
    const p = project(t, { ws: 'ws' });
    const archived = archivedPhase(p.base);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(p.phaseDir, archived);
    verify(p.root, archived, ['src/a.js', p.roadmapRel]);
    assertPassed(p.root, archived);
    fs.appendFileSync(path.join(p.base, 'ROADMAP.md'), '\n- [ ] Phase 2: Next\n');
    assert.equal(status(p.root, archived).status, 'passed', 'a ROADMAP edit is not a covered-input change');
  });

  test('.planning symlinked to an external store (#4894): an archived workstream phase addressed by its real path keeps the ROADMAP shared', (t) => {
    isolate(t);
    const base = fs.realpathSync(createTempDir('gsd-6811-store-'));
    t.after(() => cleanup(base));
    const root = path.join(base, 'proj');
    const store = path.join(base, 'store');
    const realPhase = path.join(store, 'workstreams', 'ws', 'milestones', 'v1.0-phases', PHASE);
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(store, '.git'), { recursive: true });
    fs.mkdirSync(realPhase, { recursive: true });
    fs.writeFileSync(path.join(store, 'config.json'), '{}\n');
    fs.writeFileSync(path.join(store, 'workstreams', 'ws', 'ROADMAP.md'), ROADMAP);
    fs.writeFileSync(path.join(realPhase, '01-01-PLAN.md'), '# plan\n');
    fs.writeFileSync(path.join(realPhase, '01-01-SUMMARY.md'), '# summary\n');
    writeFile(root, 'src/a.js', 'export const a = 1;\n');
    fs.symlinkSync(store, path.join(root, '.planning'), process.platform === 'win32' ? 'junction' : 'dir');
    const scope = ['--project-dir', root];
    const fp = fingerprint(base, realPhase, ['src/a.js', '.planning/workstreams/ws/ROADMAP.md'], scope);
    writeReport(realPhase, fp.covered_files, fp.covered_digest);
    assert.equal(status(base, realPhase, scope).status, 'passed');
    fs.appendFileSync(path.join(store, 'workstreams', 'ws', 'ROADMAP.md'), '\n- [ ] Phase 2: Next\n');
    assert.equal(status(base, realPhase, scope).status, 'passed', 'a ROADMAP edit is not a covered-input change');
  });

  test('a declared file of a same-prefixed sibling phase is read in place after the phase moves', (t) => {
    const sibling = `.planning/phases/${PHASE}2/01-NOTES.md`;
    const p = verifiedProject(t, { extra: [sibling] });
    const dest = archivedPhase(p.planning);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(p.phaseDir, dest);
    commitAll(p.root, 'archive');
    assert.equal(fs.existsSync(path.join(p.root, sibling)), true, 'the sibling phase did not move');
    assertPassed(p.root, dest);
  });

  test('a declared file replaced by an in-repo symlink to identical bytes reads its target, as before the move', { skip: SYMLINK_SKIP }, (t) => {
    const context = `.planning/phases/${PHASE}/01-CONTEXT.md`;
    const p = verifiedProject(t, { extra: [context] });
    completeMilestone(p.root);
    const archived = path.join(archivedPhase(p.planning), '01-CONTEXT.md');
    writeFile(p.root, 'notes/context.md', fs.readFileSync(archived));
    fs.unlinkSync(archived);
    fs.symlinkSync(path.join(p.root, 'notes', 'context.md'), archived);
    assertPassed(p.root, archivedPhase(p.planning));
  });
});

describe('#6811: a planning document the complete-milestone workflow deletes is read from its archived copy', () => {
  // The workflow runs `git rm` on REQUIREMENTS.md after `milestone complete`
  // copies it to `milestones/<v>-REQUIREMENTS.md`.
  test('milestone complete, then git rm REQUIREMENTS.md: passed', (t) => {
    const p = verifiedProject(t, { declareRequirements: true });
    completeMilestone(p.root);
    git(p.root, ['rm', '-q', p.requirementsRel]);
    assertPassed(p.root, archivedPhase(p.planning));
  });

  test('milestone complete --no-archive-phases, phases clear onto a .N name, then git rm REQUIREMENTS.md: passed', (t) => {
    const p = verifiedProject(t, { declareRequirements: true });
    completeMilestone(p.root, ['--no-archive-phases']);
    assert.equal(fs.existsSync(p.phaseDir), true, 'the phase stayed in .planning/phases/');
    const archiveDir = path.dirname(archivedPhase(p.planning));
    writeFile(p.root, posixRel(p.root, path.join(archiveDir, PHASE, '01-01-PLAN.md')), '# an older phase 1\n');
    const res = runGsdTools(['phases', 'clear', '--confirm', '--archive-version', 'v1.0'], p.root);
    assert.equal(res.success, true, res.error);
    git(p.root, ['rm', '-q', p.requirementsRel]);
    assertPassed(p.root, path.join(archiveDir, `${PHASE}.1`));
  });

  test('milestone complete --ws, git rm of the workstream REQUIREMENTS.md, then workstream complete: passed', (t) => {
    const p = verifiedProject(t, { ws: 'ws', declareRequirements: true });
    completeMilestone(p.root, ['--ws', 'ws']);
    git(p.root, ['rm', '-q', p.requirementsRel]);
    assertPassed(p.root, archivedPhase(completeWorkstream(p.root)));
  });

  test('a REQUIREMENTS.md deleted with no archived copy: stale', (t) => {
    const p = verifiedProject(t, { declareRequirements: true });
    const dest = archivedPhase(p.planning);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(p.phaseDir, dest);
    fs.unlinkSync(path.join(p.root, p.requirementsRel));
    assertStatus(p.root, dest, 'stale');
  });

  test('v1 hashes the archived copy, so its archive header reads stale', (t) => {
    const p = verifiedProject(t, { declareRoadmap: false, declareRequirements: true, version: 1 });
    completeMilestone(p.root);
    git(p.root, ['rm', '-q', p.requirementsRel]);
    assertStatus(p.root, archivedPhase(p.planning), 'stale');
  });

  test('a v1 report that declares both REQUIREMENTS.md and its archived copy names the copy once', (t) => {
    const copy = '.planning/milestones/v1.0-REQUIREMENTS.md';
    const p = verifiedProject(t, { declareRoadmap: false, declareRequirements: true, extra: [copy], version: 1 });
    completeMilestone(p.root);
    git(p.root, ['rm', '-q', p.requirementsRel]);
    commitAll(p.root, 'archive');
    editLater(path.join(p.root, copy), '# edited\n');
    const r = status(p.root, archivedPhase(p.planning));
    assert.equal(r.status, 'stale');
    assert.deepEqual(r.moved_files, [copy]);
  });
});

describe('#6811: a changed byte after the move still reads stale', () => {
  function archivedProject(t, options) {
    const p = verifiedProject(t, options);
    completeMilestone(p.root);
    return { ...p, archived: archivedPhase(p.planning) };
  }

  for (const version of VERSIONS) {
    test(`v${version}: a covered source file edited after the move: stale, moved_files names only that file`, (t) => {
      // v1 hashes the ROADMAP, which milestone complete may rewrite.
      const p = archivedProject(t, { version, declareRoadmap: version !== 1 });
      editLater(path.join(p.root, 'src', 'a.js'), 'export const a = 2;\n');
      const r = status(p.root, p.archived);
      assert.equal(r.status, 'stale');
      assert.deepEqual(r.moved_files, ['src/a.js']);
    });
  }

  test('the moved SUMMARY edited after the committed move: stale, moved_files names it where it lives now', (t) => {
    const p = archivedProject(t);
    commitAll(p.root, 'archive');
    const summary = path.join(p.archived, '01-01-SUMMARY.md');
    editLater(summary, `${fs.readFileSync(summary, 'utf8')}one more line\n`);
    const r = status(p.root, p.archived);
    assert.equal(r.status, 'stale');
    assert.deepEqual(r.moved_files, [posixRel(p.root, summary)]);
  });

  test('before the move is committed, moved_files also names a file committed after the report\'s mtime', (t) => {
    // The report is timed by its mtime until the move is committed, as any
    // uncommitted report is; `src/a.js` was committed after it.
    const p = archivedProject(t);
    const summary = path.join(p.archived, '01-01-SUMMARY.md');
    editLater(summary, `${fs.readFileSync(summary, 'utf8')}one more line\n`);
    const r = status(p.root, p.archived);
    assert.equal(r.status, 'stale');
    assert.deepEqual(r.moved_files, [posixRel(p.root, summary), 'src/a.js']);
  });

  test('v2: a plan added after the move: stale, uncovered_artifacts names it', (t) => {
    const p = archivedProject(t, { version: 2 });
    fs.writeFileSync(path.join(p.archived, '01-02-PLAN.md'), `---\nphase: ${PHASE}\nplan: 02\n---\n# plan 2\n`);
    const r = status(p.root, p.archived);
    assert.equal(r.status, 'stale');
    assert.deepEqual(r.uncovered_artifacts, ['01-02-PLAN.md']);
  });

  test('a declared file deleted from the moved directory reads stale', (t) => {
    const p = archivedProject(t);
    fs.unlinkSync(path.join(p.archived, '01-01-PLAN.md'));
    assert.equal(status(p.root, p.archived).status, 'stale');
  });

  test('a declared file replaced by a symlink out of the project, identical bytes: stale', { skip: SYMLINK_SKIP }, (t) => {
    const p = archivedProject(t, { extra: [`.planning/phases/${PHASE}/01-CONTEXT.md`] });
    const archived = path.join(p.archived, '01-CONTEXT.md');
    const outside = createTempDir('gsd-6811-outside-');
    t.after(() => cleanup(outside));
    fs.writeFileSync(path.join(outside, 'context.md'), fs.readFileSync(archived));
    fs.unlinkSync(archived);
    fs.symlinkSync(path.join(outside, 'context.md'), archived);
    assert.equal(status(p.root, p.archived).status, 'stale');
  });

  test('a source byte changed while a same-named phase exists at the old spelling: stale', (t) => {
    const p = archivedProject(t);
    fs.cpSync(p.archived, p.phaseDir, { recursive: true });
    fs.unlinkSync(path.join(p.phaseDir, REPORT));
    editLater(path.join(p.root, 'src', 'a.js'), 'export const a = 2;\n');
    assert.equal(status(p.root, p.archived).status, 'stale');
  });

  test('a decimal phase copied from its parent is not a .N archive collision: stale', (t) => {
    // `phases clear` suffixes `.N` only inside a milestone archive, so `02.1`
    // in phases/ is never recomputed as `02`.
    const p = project(t);
    const phase = path.join(p.planning, 'phases', '02');
    fs.renameSync(p.phaseDir, phase);
    verify(p.root, phase, ['src/a.js']);
    fs.renameSync(path.join(phase, REPORT), path.join(phase, '02-VERIFICATION.md'));
    assert.equal(status(p.root, phase).status, 'passed', 'precondition: the parent reads passed');
    const decimal = path.join(p.planning, 'phases', '02.1');
    fs.cpSync(phase, decimal, { recursive: true });
    fs.renameSync(path.join(decimal, '02-VERIFICATION.md'), path.join(decimal, '02.1-VERIFICATION.md'));
    assert.equal(status(p.root, decimal).status, 'stale');
  });
});

describe('#6811: moved_files after workstream complete names files where they live now', () => {
  for (const version of [4, 5]) {
    test(`v${version}: the declared ROADMAP and a source file edited: only the source file is named`, (t) => {
      const p = verifiedProject(t, { ws: 'ws', version });
      const archive = completeWorkstream(p.root);
      editLater(path.join(archive, 'ROADMAP.md'), '# Roadmap\n\n## v2.0\n');
      editLater(path.join(p.root, 'src', 'a.js'), 'export const a = 2;\n');
      const r = status(p.root, path.join(archive, 'phases', PHASE));
      assert.equal(r.status, 'stale');
      assert.deepEqual(r.moved_files, ['src/a.js']);
    });
  }

  test('twice moved, a source file edited: only the source file is named', (t) => {
    const p = verifiedProject(t, { ws: 'ws' });
    completeMilestone(p.root, ['--ws', 'ws']);
    const archived = archivedPhase(completeWorkstream(p.root));
    editLater(path.join(p.root, 'src', 'a.js'), 'export const a = 2;\n');
    const r = status(p.root, archived);
    assert.equal(r.status, 'stale');
    assert.deepEqual(r.moved_files, ['src/a.js']);
  });

  test('names sort by where the files live now', (t) => {
    const research = '.planning/research/x.md';
    const p = verifiedProject(t, { ws: 'ws', extra: [research] });
    const archive = completeWorkstream(p.root);
    commitAll(p.root, 'archive');
    const summary = path.join(archive, 'phases', PHASE, '01-01-SUMMARY.md');
    editLater(summary, '# summary, edited\n');
    editLater(path.join(p.root, research), '# research, edited\n');
    const r = status(p.root, path.join(archive, 'phases', PHASE));
    assert.equal(r.status, 'stale');
    // Declared, the research note sorted first; moved, the summary does.
    assert.deepEqual(r.moved_files, [posixRel(p.root, summary), research]);
  });
});

describe('#6811: a same-named phase created at the old spelling after the move', () => {
  // `new-milestone --reset-phase-numbers` archives the phases and starts again
  // at 1, so a new phase can take the archived one's directory name.
  for (const [label, plan] of [
    ['byte-identical plan', null],
    ['different plan', '---\nphase: 01-foo\nplan: 01\n---\n# a new milestone\'s plan\n'],
  ]) {
    test(`${label}: the archived report still reads passed`, (t) => {
      const p = verifiedProject(t);
      completeMilestone(p.root);
      const archived = archivedPhase(p.planning);
      fs.mkdirSync(p.phaseDir, { recursive: true });
      fs.copyFileSync(path.join(archived, '01-01-PLAN.md'), path.join(p.phaseDir, '01-01-PLAN.md'));
      if (plan !== null) fs.writeFileSync(path.join(p.phaseDir, '01-01-PLAN.md'), plan);
      assertPassed(p.root, archived);
    });
  }

  test('a workstream of the same name created after workstream complete: the archived phase still reads passed', (t) => {
    const p = verifiedProject(t, { ws: 'ws' });
    const archive = completeWorkstream(p.root);
    fs.mkdirSync(path.join(p.base, 'phases', PHASE), { recursive: true });
    fs.writeFileSync(path.join(p.base, 'ROADMAP.md'), '# Roadmap\n\n## v2.0\n');
    fs.writeFileSync(path.join(p.base, 'phases', PHASE, '01-01-PLAN.md'), '# the new workstream\'s plan\n');
    assertPassed(p.root, path.join(archive, 'phases', PHASE));
  });
});

describe('#6811: what each fingerprint version hashes is pinned', () => {
  // The v1-v4 digests were pinned from the build before #6811, which changes
  // no v1-v4 input; the v5 digests pin the new version. In the workstream
  // archive only v5 treats the workstream ROADMAP as a shared document.
  const PINNED = {
    '.planning/phases/01-foo': {
      roadmap: '.planning/ROADMAP.md',
      digests: [
        'v1:sha256:082c6834198525bff1699b0c394cad905cf4322b43f29435f42ab79592ec09e3',
        'v2:sha256:cc863b9ea30946e29f68352363b02130ae11fe3feb4a509f84c0ec6522966f84',
        'v3:sha256:bc6f689813c6b0b1e7e036d32df0b75d575f20d3f4111847ed70422730ac7056',
        'v4:sha256:17d7868a610abff9617c7689aaf6d4955848f79524e2a59e841c88dd6d115f40',
        'v5:sha256:abc4106dcda80d32635ad28bac9634331b11329fb29bc5c40476e0750001a57a',
      ],
    },
    '.planning/workstreams/ws/milestones/v1.0-phases/01-foo': {
      roadmap: '.planning/workstreams/ws/ROADMAP.md',
      digests: [
        'v1:sha256:80128d808eb0c3ccdf8799631ad8e33d14bb264453b3e0e5f243b12cc1950df7',
        'v2:sha256:df61054a5ff132aff95740d5ec0bddebccfae560d59b6d37ee92932ece9a1542',
        'v3:sha256:1f9d1ad15cf1dc31b18e7ba6bf860d58398aee7b2e438393cd781e0c3b1d710d',
        'v4:sha256:c7194a1e7df5ba48aced527e196761892716362ee7098895951f376d77a4388f',
        'v5:sha256:b8a3a58649467a170b745a586d4a00d28de58f44109867c00a4df930da9f3a55',
      ],
    },
  };

  for (const [phaseRel, { roadmap: roadmapRel, digests }] of Object.entries(PINNED)) {
    test(`${phaseRel}: v1-v5 digests`, (t) => {
      const root = createTempDir('gsd-6811-pin-');
      t.after(() => cleanup(root));
      const files = {
        [`${phaseRel}/01-01-PLAN.md`]: 'plan\n',
        [`${phaseRel}/01-01-SUMMARY.md`]: 'summary\r\n',
        'src/a.js': 'a\r\nb\n',
        [roadmapRel]: 'roadmap\n',
      };
      for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
      const phaseDir = path.join(root, phaseRel);
      digests.forEach((expected, i) => {
        assert.equal(computeCoveredDigest(root, Object.keys(files), i + 1, { phaseDir }), expected, `v${i + 1}`);
      });
    });
  }
});

describe('#6811: property — a directory move never changes the recomputed digest', () => {
  const SHAPES = ['milestone', 'collision', 'project-milestone', 'ws-milestone', 'ws-complete', 'ws-complete-suffix'];
  const EXTRAS = ['01-CONTEXT.md', 'plans/01-02-PLAN.md', 'notes/deep/01-NOTES.md'];

  /** The planning scope a shape's phase starts in, relative to `.planning/`. */
  const scopeOf = (shape) => {
    if (shape.startsWith('ws-')) return path.join('workstreams', 'ws');
    return shape === 'project-milestone' ? 'proj' : '';
  };

  /**
   * Move the phase the way one of the movers does. Returns its new path and
   * the directory prefix that moved, before and after: `workstream complete`
   * moves the whole workstream directory, ROADMAP included, suffixing `-N`
   * when an archive of that name and date exists.
   */
  function move(root, shape, base, phaseDir) {
    const planning = path.join(root, '.planning');
    if (shape.startsWith('ws-complete')) {
      const archives = path.join(planning, 'milestones');
      let dest = path.join(archives, 'ws-ws-2026-01-01');
      if (shape === 'ws-complete-suffix') {
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'ROADMAP.md'), '# an earlier ws\n');
        dest = `${dest}-1`;
      }
      fs.mkdirSync(archives, { recursive: true });
      fs.renameSync(base, dest);
      fs.rmdirSync(path.join(planning, 'workstreams'));
      return { moved: path.join(dest, 'phases', PHASE), from: base, to: dest };
    }
    const archiveDir = path.join(base, 'milestones', 'v1.0-phases');
    let dest = path.join(archiveDir, PHASE);
    if (shape === 'collision') {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, '01-01-PLAN.md'), '# an older phase 1\n');
      dest = `${dest}.1`;
    }
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(phaseDir, dest);
    return { moved: dest, from: phaseDir, to: dest };
  }

  for (const version of VERSIONS) {
    for (const shape of SHAPES) {
      test(`v${version}, ${shape}: passed after the move, stale after one changed byte`, async (t) => {
        isolate(t);
        await fc.assert(fc.property(
          fc.subarray(EXTRAS),
          fc.boolean(),
          // One buffer per file: up to five phase files, the ROADMAP, the source file.
          fc.array(fc.uint8Array({ maxLength: 48 }), { minLength: 7, maxLength: 7 }),
          fc.nat(),
          (extras, declareRoadmap, contents, pick) => {
            const root = createTempProject('gsd-6811-prop-');
            t.after(() => cleanup(root));
            const base = path.join(root, '.planning', scopeOf(shape));
            const phaseDir = path.join(base, 'phases', PHASE);
            const phaseFiles = ['01-01-PLAN.md', '01-01-SUMMARY.md', ...extras];
            phaseFiles.forEach((name, i) => writeFile(root, posixRel(root, path.join(phaseDir, name)), Buffer.from(contents[i])));
            fs.writeFileSync(path.join(base, 'ROADMAP.md'), Buffer.from(contents[5]));
            writeFile(root, 'src/a.bin', Buffer.from(contents[6]));
            const roadmapRel = posixRel(root, path.join(base, 'ROADMAP.md'));

            const declared = [
              'src/a.bin',
              ...phaseFiles.map((name) => posixRel(root, path.join(phaseDir, name))),
              ...(declareRoadmap ? [roadmapRel] : []),
            ];
            const fp = fingerprint(root, phaseDir, declared);
            writeReport(phaseDir, fp.covered_files, digestAt(root, phaseDir, fp, version));
            assert.equal(status(root, phaseDir).status, 'passed', 'precondition: passed before the move');

            const { moved, from, to } = move(root, shape, base, phaseDir);
            assert.equal(status(root, moved).status, 'passed', 'a pure move keeps passed');

            // One changed byte in a hashed covered file (v2+ never hash the ROADMAP).
            const hashed = fp.covered_files.filter((f) => version === 1 || f !== roadmapRel);
            const victimRel = hashed[pick % hashed.length];
            const oldPrefix = posixRel(root, from);
            const newPrefix = posixRel(root, to);
            const victim = path.join(root, victimRel.startsWith(`${oldPrefix}/`) ? newPrefix + victimRel.slice(oldPrefix.length) : victimRel);
            const bytes = fs.readFileSync(victim);
            if (bytes.length === 0) fs.writeFileSync(victim, Buffer.from('x'));
            else {
              const i = pick % bytes.length;
              bytes[i] = bytes[i] === 0x78 ? 0x79 : 0x78;
              fs.writeFileSync(victim, bytes);
            }
            assert.equal(status(root, moved).status, 'stale', `${victimRel} changed`);
          },
        ), { numRuns: 3 });
      });
    }
  }
});
