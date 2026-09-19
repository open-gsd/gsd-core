'use strict';

/**
 * ADR-612 PR-3 bracket migrator acceptance tests.
 *
 * These tests copy committed real-layout fixture trees into temporary Git
 * repositories and drive the compiled gsd-tools command. The router and the
 * migrator are intentionally not stubbed: dry-run, dirty-tree refusal,
 * rollback, and idempotence are command-boundary contracts.
 *
 * One exception: the config-write-failure rollback test below calls
 * computeMigrationPlan()/applyMigration() directly (in-process) instead of
 * through the CLI. #4698 Blocker 1 — a chmod-based injection there would be
 * vacuous under the uid-0 `gsd-test` Docker bench (root's own write is not
 * blocked by a 0o444 mode bit), and a mock.method() interception installed
 * from this parent process is invisible to a spawned child process (see
 * tests/broken-windows.test.cjs's #1950-H2 note, and the identical in-process
 * pattern this file's sibling tests/roadmap-upgrade.test.cjs already uses for
 * the milestone-prefixed convention's own config-write rollback test).
 */

const { describe, test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers.cjs');
const { cleanup, TOOLS_PATH } = helpers;
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const {
  computeMigrationPlan,
  applyMigration,
  computeDependsOnRewrites,
} = require('../gsd-core/bin/lib/roadmap-upgrade.cjs');
const { readVerificationStatus } = require('../gsd-core/bin/lib/verification.cjs');
const { scopeToPhase, matchPhaseDirs, isSentinelPhaseId } = require('../gsd-core/bin/lib/phase-id.cjs');
// #4144 round 5 Blocker 1: hasPhaseEntries and its exported single-owner
// phase-heading predicate — the READERS' OWN phase-heading grammar the
// bracket migrator's "phase-like but unparsed" refusal must be gated on
// (see the describe block below).
const { hasPhaseEntries, isPhaseHeadingText, scanMilestonePhaseIds } = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const { extractFencedBlock } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
// #4698 Blocker 1 (round 2): real production functions used to prove the
// REAL dependency resolver (not a hand-rolled stand-in) resolves a
// depends_on token this migrator rewrote. cmdPhasePlanIndex itself is not
// used for this — see readyPlansViaRealResolver's own comment below.
const { parsePlanDocument } = require('../gsd-core/bin/lib/plan-document.cjs');
const { computeDependencyLevels, buildShortFormToId } = require('../gsd-core/bin/lib/phase.cjs');
const { extractCanonicalPlanId } = require('../gsd-core/bin/lib/core-utils.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'roadmap-upgrade-bracket');
const COMMAND_TIMEOUT_MS = 60000;
const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) cleanup(tempRoots.pop());
});

function materializeFixture(name) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-bracket-${name}-`));
  tempRoots.push(cwd);
  fs.cpSync(path.join(FIXTURE_ROOT, name, 'planning'), path.join(cwd, '.planning'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.planning/\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Fixture repository\n', 'utf8');

  gitOrThrow(['init', '--quiet'], { cwd });
  gitOrThrow(['config', 'user.email', 'fixture@example.invalid'], { cwd });
  gitOrThrow(['config', 'user.name', 'Fixture Author'], { cwd });
  gitOrThrow(['add', '.gitignore', 'README.md'], { cwd });
  gitOrThrow(['commit', '--quiet', '-m', 'fixture baseline'], { cwd });
  return cwd;
}

/**
 * #4144 round 5 Blocker 1: a git-initialized fixture repo with an EMPTY
 * `.planning/` tree (no static `fixtures/roadmap-upgrade-bracket/<name>/`
 * directory to copy from) — for a ROADMAP.md built at test time from
 * `gsd-core/templates/roadmap.md` itself, so the regression test tracks the
 * real shipped template rather than a frozen duplicate of it. Mirrors
 * materializeFixture's own git scaffolding exactly, minus the `fs.cpSync`.
 */
function materializeEmptyFixture(label) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-bracket-${label}-`));
  tempRoots.push(cwd);
  fs.mkdirSync(path.join(cwd, '.planning', 'phases'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.planning/\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Fixture repository\n', 'utf8');

  gitOrThrow(['init', '--quiet'], { cwd });
  gitOrThrow(['config', 'user.email', 'fixture@example.invalid'], { cwd });
  gitOrThrow(['config', 'user.name', 'Fixture Author'], { cwd });
  gitOrThrow(['add', '.gitignore', 'README.md'], { cwd });
  gitOrThrow(['commit', '--quiet', '-m', 'fixture baseline'], { cwd });
  return cwd;
}

/**
 * #4144 round 5 Blocker 1: the fenced `markdown` roadmap example from
 * `gsd-core/templates/roadmap.md` (the "Initial Roadmap (v1.0 Greenfield)"
 * block, which contains the literal `## Phase Details` heading the reported
 * regression is about), with its name placeholders filled in. Extracted via
 * `extractFencedBlock` — the same fence-scanning seam the readers use — so
 * this is the ACTUAL shipped template content, not a hand-copied excerpt
 * that could silently drift from it.
 */
function buildTemplateRoadmap() {
  const templatePath = path.join(__dirname, '..', 'gsd-core', 'templates', 'roadmap.md');
  const templateContent = fs.readFileSync(templatePath, 'utf8');
  const block = extractFencedBlock(templateContent, 'markdown');
  assert.ok(block, 'gsd-core/templates/roadmap.md must still contain its fenced `markdown` roadmap example');
  return block
    .replaceAll('[Project Name]', 'Nimbus')
    .replaceAll('Phase 1: [Name]', 'Phase 1: Alpha')
    .replaceAll('Phase 2: [Name]', 'Phase 2: Beta')
    .replaceAll('Phase 3: [Name]', 'Phase 3: Gamma')
    .replaceAll('Phase 4: [Name]', 'Phase 4: Delta')
    .replaceAll('| 1. [Name] |', '| 1. Alpha |')
    .replaceAll('| 2. [Name] |', '| 2. Beta |')
    .replaceAll('| 3. [Name] |', '| 3. Gamma |')
    .replaceAll('| 4. [Name] |', '| 4. Delta |');
}

function runBracketUpgrade(cwd, extraArgs = []) {
  return runNode(
    [TOOLS_PATH, 'roadmap', 'upgrade', '--convention', 'bracket', ...extraArgs],
    {
      cwd,
      env: {
        ...process.env,
        ...helpers.TEST_ENV_BASE,
        HOME: cwd,
      },
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );
}

function assertExited(result, exitCode, context) {
  assert.equal(result.outcome, OUTCOME.EXITED, `${context}: ${result.outcome}`);
  assert.equal(
    result.exitCode,
    exitCode,
    `${context}: expected exit ${exitCode}; stdout=${result.stdout}; stderr=${result.stderr}`,
  );
}

function parseDryRun(result, context) {
  assertExited(result, 0, context);
  assert.match(result.stderr, /Bracket phase-ID convention/);
  assert.match(result.stderr, /\[GSD\.02\] 05\.03-01/);
  return JSON.parse(result.stdout);
}

function snapshotTree(root, options = {}) {
  const skipGit = options.skipGit === true;
  const snapshot = [];

  function walk(current, relative) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => !(skipGit && relative === '' && entry.name === '.git'))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relPath = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        snapshot.push({ path: relPath, type: 'directory' });
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        snapshot.push({
          path: relPath,
          type: 'file',
          bytes: fs.readFileSync(fullPath).toString('base64'),
        });
      } else if (entry.isSymbolicLink()) {
        snapshot.push({ path: relPath, type: 'symlink', target: fs.readlinkSync(fullPath) });
      }
    }
  }

  walk(root, '');
  return snapshot;
}

function phaseDirs(cwd) {
  return fs.readdirSync(path.join(cwd, '.planning', 'phases'))
    .filter((entry) => fs.statSync(path.join(cwd, '.planning', 'phases', entry)).isDirectory())
    .sort();
}

/**
 * #4698 Blocker 1 (round 2): builds rawPlans/planMap/canonicalToId from the
 * REAL files on disk (via the REAL parsePlanDocument) and runs them through
 * the REAL computeDependencyLevels/buildShortFormToId — the exact function
 * pair the gate finding names, and the same one cmdPhasePlanIndex's own
 * `ready_plans` is built from (src/phase.cts).
 *
 * cmdPhasePlanIndex itself is NOT exercised end-to-end here: its own
 * directory lookup (`matchPhaseDirs(dirs, normalized)`, src/phase.cts) is
 * called with no `convention` argument, so it cannot resolve a
 * bracket-renamed directory (`GSD.02-01-deps`) by phase number at all — a
 * separate, pre-existing gap in that command's own directory resolution,
 * unrelated to any of the three #4698 Blockers this suite covers. Exercising
 * the resolver directly, on the phase directory this test already knows the
 * path to, avoids that unrelated gap while still proving the real fix with
 * real production code.
 */
function readyPlansViaRealResolver(phaseDir) {
  const files = fs.readdirSync(phaseDir).filter((f) => /-PLAN\.md$/i.test(f)).sort();
  const rawPlans = files.map((f) => {
    const id = f.replace(/-PLAN\.md$/i, '');
    const doc = parsePlanDocument(fs.readFileSync(path.join(phaseDir, f), 'utf8'));
    return {
      id,
      dependsOn: doc.dependsOn,
      hasSummary: fs.existsSync(path.join(phaseDir, `${id}-SUMMARY.md`)),
    };
  });
  const planMap = new Map(rawPlans.map((p) => [p.id.toLowerCase(), p]));
  const canonicalToId = new Map(rawPlans.map((p) => [extractCanonicalPlanId(p.id).toLowerCase(), p.id]));
  const shortFormToId = buildShortFormToId(rawPlans);
  const { level, visited, order, unresolved } = computeDependencyLevels(rawPlans, planMap, canonicalToId, shortFormToId);
  return { rawPlans, planMap, level, visited, order, unresolved };
}

describe('roadmap upgrade --convention bracket', () => {
  test('legacy → bracket dry-run reports the plan, prints the card, and writes zero bytes', () => {
    const cwd = materializeFixture('legacy-multi-milestone');
    const before = snapshotTree(cwd, { skipGit: true });

    const plan = parseDryRun(runBracketUpgrade(cwd), 'legacy bracket dry-run');

    assert.equal(plan.alreadyMigrated, false);
    assert.equal(plan.targetConvention, 'bracket');
    assert.deepEqual(
      plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })),
      [
        { oldDir: '01-alpha', newDir: 'GSD.01-01-alpha' },
        { oldDir: '02.1-beta', newDir: 'GSD.01-02-beta' },
        { oldDir: '03-gamma', newDir: 'GSD.02-01-gamma' },
      ],
    );
    assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'dry-run must write nothing');
  });

  test('M-NN → bracket preserves the milestone and lifts deep integer segments', () => {
    const cwd = materializeFixture('mnn-multi-milestone');

    const plan = parseDryRun(runBracketUpgrade(cwd), 'M-NN bracket dry-run');

    assert.deepEqual(
      plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })),
      [
        { oldDir: 'GSD-02-01-foundation', newDir: 'GSD.02-01-foundation' },
        { oldDir: 'GSD-02-04-01-deep-slice', newDir: 'GSD.02-04.01-deep-slice' },
      ],
    );
    assert.ok(
      plan.roadmapEdits.some(({ to }) => to === '### [GSD.02] 04.01: Deep slice'),
      'M-NN 2-04-01 must become bracket token 04.01',
    );
  });

  test('project-prefixed single-milestone layouts derive the STATE milestone instead of no-oping', () => {
    const cwd = materializeFixture('project-prefixed-single-milestone');

    const plan = parseDryRun(runBracketUpgrade(cwd), 'single-milestone bracket dry-run');

    assert.equal(plan.alreadyMigrated, false);
    assert.deepEqual(
      plan.phases.map(({ newDir }) => newDir),
      ['HQ.01-01-intake', 'HQ.01-02-delivery'],
    );

    // #4144 round 8 B2: this fixture has no `## vN.M` heading at all (its
    // milestone comes from STATE.md), so its two non-bold checklist bullets
    // — `- [ ] Phase 1: Intake` / `- [ ] Phase 2: Delivery` — sit outside
    // every section. Round 7 left both legacy after apply; only the plan's
    // phase renames were ever checked here, so the regression was invisible
    // to this test. Assert the bullets on disk directly.
    const applyResult = runBracketUpgrade(cwd, ['--apply']);
    assertExited(applyResult, 0, 'single-milestone bracket apply');
    const roadmapAfter = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
    assert.match(roadmapAfter, /- \[ \] \[HQ\.01\] 01: Intake/, 'the Intake checklist bullet must convert, not stay legacy');
    assert.match(roadmapAfter, /- \[ \] \[HQ\.01\] 02: Delivery/, 'the Delivery checklist bullet must convert, not stay legacy');
    assert.doesNotMatch(roadmapAfter, /- \[ \] Phase 1: Intake/, 'no leftover legacy-token bullet may remain');
    assert.doesNotMatch(roadmapAfter, /- \[ \] Phase 2: Delivery/, 'no leftover legacy-token bullet may remain');
  });

  test('refuses a legacy tree whose milestone cannot be derived instead of marking it bracket', () => {
    const cwd = materializeFixture('project-prefixed-single-milestone');
    fs.unlinkSync(path.join(cwd, '.planning', 'STATE.md'));
    const before = snapshotTree(cwd, { skipGit: true });

    const result = runBracketUpgrade(cwd);

    assertExited(result, 1, 'missing milestone source');
    assert.match(result.stderr, /Cannot determine a milestone/);
    assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'refusal must write nothing');
  });

  test('hard-refuses a bracket migration without project_code and writes zero bytes', () => {
    const cwd = materializeFixture('legacy-multi-milestone');
    const configPath = path.join(cwd, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.project_code;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const before = snapshotTree(cwd, { skipGit: true });

    const result = runBracketUpgrade(cwd);

    assertExited(result, 1, 'missing project_code');
    assert.match(result.stderr, /without a project_code/);
    assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'refusal must write nothing');
  });

  test('hard-refuses a non-canonical project_code before planning any writes', () => {
    const cwd = materializeFixture('legacy-multi-milestone');
    const configPath = path.join(cwd, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.project_code = 'bad-code';
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const before = snapshotTree(cwd, { skipGit: true });

    const result = runBracketUpgrade(cwd);

    assertExited(result, 1, 'invalid project_code');
    assert.match(result.stderr, /invalid project_code/);
    assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'refusal must write nothing');
  });

  test('preserves the v999 sentinel milestone in the bracket identity', () => {
    const cwd = materializeFixture('legacy-multi-milestone');
    fs.writeFileSync(
      path.join(cwd, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v999.0 — Backlog\n\n### Phase 1: Someday\n',
      'utf8',
    );

    const plan = parseDryRun(runBracketUpgrade(cwd), 'sentinel milestone dry-run');

    assert.ok(
      plan.roadmapEdits.some(({ to }) => to === '### [GSD.999] 01: Someday'),
      'v999 must remain milestone 999 rather than being skipped or truncated',
    );
    assert.ok(
      plan.phases.some(({ oldDir, newDir }) => oldDir === '01-alpha' && newDir === 'GSD.999-01-alpha'),
      'the directory prefix must carry the same sentinel milestone',
    );
  });

  test('sanitizes a hostile legacy directory slug through the canonical emitter', () => {
    const cwd = materializeFixture('legacy-multi-milestone');
    const phasesPath = path.join(cwd, '.planning', 'phases');
    fs.renameSync(
      path.join(phasesPath, '01-alpha'),
      path.join(phasesPath, '01-..-..-etc'),
    );

    const plan = parseDryRun(runBracketUpgrade(cwd), 'hostile slug dry-run');
    const rename = plan.phases.find(({ oldDir }) => oldDir === '01-..-..-etc');

    assert.ok(rename, 'the hostile source directory must still be matched');
    assert.equal(rename.newDir, path.basename(rename.newDir), 'the target must remain one path segment');
    assert.doesNotMatch(rename.newDir, /\.\./, 'the target must not retain traversal tokens');
  });

  test('names the phase and legacy directory when a bracket slug cannot be emitted', () => {
    const cwd = materializeFixture('legacy-multi-milestone');
    const phasesPath = path.join(cwd, '.planning', 'phases');
    fs.renameSync(
      path.join(phasesPath, '01-alpha'),
      path.join(phasesPath, '01-2026'),
    );
    const before = snapshotTree(cwd, { skipGit: true });

    const result = runBracketUpgrade(cwd);

    assertExited(result, 1, 'all-digit bracket slug');
    assert.match(
      result.stderr,
      /Cannot build bracket directory for phase "1" from source directory "01-2026"/,
    );
    assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'dry-run refusal must write nothing');
  });

  test('apply refuses a dirty tracked working tree before mutating the ignored planning tree', () => {
    const cwd = materializeFixture('legacy-multi-milestone');
    fs.appendFileSync(path.join(cwd, 'README.md'), '\ndirty\n', 'utf8');
    const before = snapshotTree(cwd, { skipGit: true });

    const result = runBracketUpgrade(cwd, ['--apply']);

    assertExited(result, 1, 'dirty-tree refusal');
    assert.match(result.stderr, /Working tree is dirty/);
    assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'dirty refusal must precede mutation');
  });

  test('apply keeps renamed directories, ROADMAP headings/checklists, and config consistent', () => {
    const cwd = materializeFixture('legacy-multi-milestone');

    const result = runBracketUpgrade(cwd, ['--apply']);

    assertExited(result, 0, 'legacy bracket apply');
    assert.match(result.stderr, /Bracket phase-ID convention/);
    const dirs = phaseDirs(cwd);
    const expectedIds = ['GSD.01-01', 'GSD.01-02', 'GSD.02-01'];
    assert.deepEqual(
      dirs,
      ['GSD.01-01-alpha', 'GSD.01-02-beta', 'GSD.02-01-gamma'],
    );

    const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
    const headingIds = [...roadmap.matchAll(/^### \[([^\]\r\n]{1,200})\] ([^:\r\n]{1,200}):/gm)]
      .map((match) => `${match[1]}-${match[2]}`);
    assert.deepEqual(headingIds, expectedIds);
    assert.ok(
      headingIds.every((id) => dirs.some((dir) => dir.startsWith(`${id}-`))),
      'every migrated ROADMAP heading must have a matching directory identity',
    );
    assert.match(roadmap, /- \[ \] \*\*\[GSD\.01\] 01:\*\* Alpha/);
    assert.match(roadmap, /- \[x\] \[GSD\.02\] 01: Gamma/);

    const config = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
    assert.equal(config.phase_id_convention, 'bracket');
  });

  // #4144 round 6 (W-collision): a target directory occupied between the
  // dry-run and a fresh `--apply` invocation used to surface only at APPLY
  // time (a mid-rename ENOTEMPTY, caught and rolled back by applyMigration's
  // own try/catch). `computeMigrationPlan` now checks every target directory
  // for existence itself, and `--apply` recomputes the plan fresh before
  // touching anything — so this exact race is now refused at PLAN time,
  // before applyMigration's rename loop ever starts, and never reaches the
  // "Migration failed and rolled back" wrapper at all. Nothing is written
  // either way; this test now proves the EARLIER, better-scoped refusal.
  test('a target directory occupied since dry-run is refused at plan time on --apply, before any rename', () => {
    const cwd = materializeFixture('legacy-multi-milestone');
    const dryRunPlan = parseDryRun(runBracketUpgrade(cwd), 'rollback setup dry-run');
    assert.ok(dryRunPlan.phases.length >= 2, 'fixture must provide a rename before the failing rename');
    const occupiedTarget = path.join(cwd, '.planning', 'phases', dryRunPlan.phases[1].newDir);
    fs.mkdirSync(occupiedTarget, { recursive: true });
    fs.writeFileSync(path.join(occupiedTarget, 'occupied.txt'), 'do not overwrite\n', 'utf8');
    const before = snapshotTree(path.join(cwd, '.planning'));

    const result = runBracketUpgrade(cwd, ['--apply']);

    assertExited(result, 1, 'plan-time directory-collision refusal on --apply');
    assert.match(result.stderr, /directory already exists/);
    assert.ok(result.stderr.includes(dryRunPlan.phases[1].newDir), 'the refusal must name the colliding directory');
    assert.deepEqual(
      snapshotTree(path.join(cwd, '.planning')),
      before,
      'a plan-time refusal must write nothing — no rename, no rollback needed',
    );
  });

  test('a config write failure restores renamed directories and ROADMAP bytes', (t) => {
    const cwd = materializeFixture('legacy-multi-milestone');
    const planningPath = path.join(cwd, '.planning');
    const configPath = path.join(planningPath, 'config.json');

    const plan = computeMigrationPlan(cwd, { convention: 'bracket' });
    assert.equal(plan.alreadyMigrated, false);
    assert.ok(plan.phases.length >= 1, 'fixture must produce phase renames');
    assert.ok(plan.roadmapEdits.length >= 1, 'fixture must produce roadmap edits');

    const before = snapshotTree(planningPath);

    // uid-independent fault injection: a JS-level function replacement throws
    // for every caller regardless of uid, filesystem, or capabilities — unlike
    // fs.chmodSync(configPath, 0o444), which the uid-0 gsd-test Docker bench's
    // own write bypasses entirely (see file header note).
    const realWrite = fs.writeFileSync;
    const writeMock = mock.method(fs, 'writeFileSync', (target, data, opts) => {
      if (path.resolve(String(target)) === configPath) {
        throw Object.assign(
          new Error(`EACCES: permission denied, open '${configPath}'`),
          { code: 'EACCES' },
        );
      }
      return realWrite.call(fs, target, data, opts);
    });
    t.after(() => writeMock.mock.restore());

    // Probe: the injection must actually block a write to this exact path
    // before trusting it to exercise the rollback branch below. A probe that
    // unexpectedly succeeds (e.g. a path-matching bug in the mock above) must
    // fail the test loudly, never let the migration proceed "successfully"
    // and pass with zero rollback coverage.
    assert.throws(
      () => fs.writeFileSync(configPath, 'probe'),
      /EACCES/,
      'fault-injection probe unexpectedly wrote to config.json — refusing to trust this run',
    );

    let caught;
    try {
      applyMigration(cwd, plan, { dryRun: false });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'a config write failure must throw, not silently succeed');
    assert.match(caught.message, /Migration failed and rolled back/);
    assert.match(caught.message, /config\.json write phase/);
    assert.deepEqual(
      snapshotTree(planningPath),
      before,
      'ignored planning tree must be byte-restored after a config write failure',
    );
  });

  test('an applied migration is idempotent on re-run', () => {
    const cwd = materializeFixture('mnn-multi-milestone');
    const first = runBracketUpgrade(cwd, ['--apply']);
    assertExited(first, 0, 'first M-NN bracket apply');
    const afterFirst = snapshotTree(path.join(cwd, '.planning'));

    const second = runBracketUpgrade(cwd, ['--apply']);

    assertExited(second, 0, 'second M-NN bracket apply');
    assert.deepEqual(snapshotTree(path.join(cwd, '.planning')), afterFirst, 'second apply must be a no-op');
  });

  // #4698 Blocker 2: an unrecognized or partially-migrated roadmap must
  // refuse outright rather than silently mark the project "bracket" with
  // zero (or partial) conversions — see computeBracketPlan's idempotency
  // guard, which would otherwise treat that stamp as proof the migration is
  // already complete and make a corrected re-run permanently unreachable.
  describe('refuses unrecognized or partially migrated roadmaps (#4698 Blocker 2)', () => {
    test('refuses an empty ROADMAP.md on both dry-run and apply, writing nothing', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), '', 'utf8');
      const before = snapshotTree(cwd, { skipGit: true });

      const dryRun = runBracketUpgrade(cwd);
      assertExited(dryRun, 1, 'zero recognized headings (dry-run)');
      assert.match(dryRun.stderr, /No recognized phase headings/);
      assert.match(dryRun.stderr, /\[CODE\.MM\] NN/);
      assert.match(dryRun.stderr, /Phase M-NN/);
      assert.match(dryRun.stderr, /Phase N: Name/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'dry-run refusal must write nothing');

      const apply = runBracketUpgrade(cwd, ['--apply']);
      assertExited(apply, 1, 'zero recognized headings (apply)');
      assert.match(apply.stderr, /No recognized phase headings/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'apply refusal must write nothing');
    });

    test('refuses a ROADMAP.md whose ### headings match none of the recognized grammars', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        '# Roadmap\n\n## v1.0 — Foundation\n\n### Overview\n\nSome prose.\n\n### Open questions\n\nMore prose.\n',
        'utf8',
      );
      const before = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd);

      assertExited(result, 1, 'prose-only headings match no grammar');
      assert.match(result.stderr, /No recognized phase headings/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'refusal must write nothing');
    });

    test('refuses a roadmap mixing a bracket heading with an unconverted legacy heading', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 — Foundation',
          '',
          '### [GSD.01] 01: Alpha',
          '',
          '### Phase 2.1: Beta',
          '',
        ].join('\n'),
        'utf8',
      );
      const before = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd, ['--apply']);

      assertExited(result, 1, 'mixed bracket/legacy roadmap');
      assert.match(result.stderr, /still has unconverted phase headings/);
      assert.match(result.stderr, /### Phase 2\.1: Beta/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'refusal must write nothing');
    });

    test('refuses when config already says bracket but a legacy heading remains (does not return done)', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      const configPath = path.join(cwd, '.planning', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.phase_id_convention = 'bracket';
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      const before = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd, ['--apply']);

      assertExited(result, 1, 'config says bracket but legacy headings remain');
      assert.match(result.stderr, /still has unconverted phase headings/);
      assert.match(result.stderr, /### Phase 1: Alpha/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'refusal must write nothing, not `done`');
    });

    test('the existing fully-migrated idempotency test still passes (regression guard)', () => {
      // Duplicate, minimal re-assertion of the pre-existing idempotency
      // contract, scoped to this describe block so a future reader can see
      // Blocker 2's fix did not disturb it — the full-fidelity version is
      // the file's own "an applied migration is idempotent on re-run" test
      // above (mnn-multi-milestone), which continues to run unmodified.
      const cwd = materializeFixture('legacy-multi-milestone');
      const first = runBracketUpgrade(cwd, ['--apply']);
      assertExited(first, 0, 'first legacy bracket apply');
      const afterFirst = snapshotTree(path.join(cwd, '.planning'));

      const second = runBracketUpgrade(cwd, ['--apply']);

      assertExited(second, 0, 'second legacy bracket apply (must be `done`, not a mixed refusal)');
      assert.deepEqual(
        snapshotTree(path.join(cwd, '.planning')),
        afterFirst,
        'a fully-migrated roadmap must still short-circuit to done',
      );
    });

    test('applyMigration does not write config.json when the plan converted zero phases', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      const configPath = path.join(cwd, '.planning', 'config.json');
      const configBefore = fs.readFileSync(configPath, 'utf8');

      const emptyPlan = {
        alreadyMigrated: false,
        phases: [],
        roadmapEdits: [],
        crossRefEdits: [],
        targetConvention: 'bracket',
      };

      const result = applyMigration(cwd, emptyPlan, { dryRun: false });

      assert.equal(result.applied, true);
      assert.equal(
        fs.readFileSync(configPath, 'utf8'),
        configBefore,
        'config.json must be untouched when the plan converted zero phases',
      );
    });
  });

  // #4698 Blocker 2: `matchBracketSourceDir` matched an M-NN mapping by
  // checking only its LEADING integer segments, so a parent mapping (e.g.
  // `2-04`, two segments) is a strict prefix of its own child's mapping
  // (`2-04-01`, three segments) and matches the child's directory just as
  // readily as the child's own mapping — the resolution loop took whichever
  // candidate it reached FIRST (roadmap heading order), so a parent heading
  // that happens to precede its child's heading could claim the child's
  // directory and leave the true parent directory unmapped. These tests call
  // computeMigrationPlan() in-process (not the CLI subprocess `runBracketUpgrade`
  // spawns) specifically so `fs.readdirSync` can be mocked to pin the phases
  // directory's listing order — a subprocess would never see a mock installed
  // in this parent process (the same constraint documented on the Blocker 1
  // config-write-failure test above).
  describe('M-NN directories resolve to their most specific mapping (#4698 Blocker 2)', () => {
    function withPhaseDirOrder(phasesDir, orderedNames, fn) {
      const real = fs.readdirSync;
      const dirMock = mock.method(fs, 'readdirSync', (dir, opts) => {
        if (path.resolve(String(dir)) === path.resolve(phasesDir)) {
          if (opts && opts.withFileTypes) {
            return orderedNames.map((name) => ({
              name,
              isDirectory: () => true,
              isFile: () => false,
              isSymbolicLink: () => false,
            }));
          }
          return orderedNames.slice();
        }
        return real.call(fs, dir, opts);
      });
      try {
        return fn();
      } finally {
        dirMock.mock.restore();
      }
    }

    function setupParentChildFixture() {
      const cwd = materializeFixture('mnn-multi-milestone');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v2.0 — Existing milestone',
          '',
          '### Phase 2-04: Parent',
          '',
          '- [ ] **Phase 2-04:** Parent',
          '',
          '### Phase 2-01: Foundation',
          '',
          '- [ ] **Phase 2-01:** Foundation',
          '',
          '### Phase 2-04-01: Deep slice',
          '',
          '- [x] Phase 2-04-01: Deep slice',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      fs.mkdirSync(path.join(phasesDir, 'GSD-02-04-parent'), { recursive: true });
      fs.writeFileSync(path.join(phasesDir, 'GSD-02-04-parent', '02-04-PLAN.md'), '# Parent plan\n', 'utf8');
      return { cwd, phasesDir };
    }

    const expectedRenames = [
      { oldDir: 'GSD-02-01-foundation', newDir: 'GSD.02-01-foundation' },
      { oldDir: 'GSD-02-04-01-deep-slice', newDir: 'GSD.02-04.01-deep-slice' },
      { oldDir: 'GSD-02-04-parent', newDir: 'GSD.02-04-parent' },
    ].sort((a, b) => a.oldDir.localeCompare(b.oldDir));

    test('parent-before-child directory listing order still maps both to their own bracket directories', () => {
      const { cwd, phasesDir } = setupParentChildFixture();

      const plan = withPhaseDirOrder(
        phasesDir,
        ['GSD-02-04-parent', 'GSD-02-01-foundation', 'GSD-02-04-01-deep-slice'],
        () => computeMigrationPlan(cwd, { convention: 'bracket' }),
      );

      assert.deepEqual(
        plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })).sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        expectedRenames,
      );
    });

    test('child-before-parent directory listing order still maps both to their own bracket directories', () => {
      const { cwd, phasesDir } = setupParentChildFixture();

      const plan = withPhaseDirOrder(
        phasesDir,
        ['GSD-02-04-01-deep-slice', 'GSD-02-01-foundation', 'GSD-02-04-parent'],
        () => computeMigrationPlan(cwd, { convention: 'bracket' }),
      );

      assert.deepEqual(
        plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })).sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        expectedRenames,
      );
    });

    test('a digit-leading slug with no matching phase still maps to its milestone-phase parent, slug intact', () => {
      const { cwd, phasesDir } = setupParentChildFixture();
      fs.mkdirSync(path.join(phasesDir, 'GSD-02-04-2024-audit'), { recursive: true });
      fs.writeFileSync(path.join(phasesDir, 'GSD-02-04-2024-audit', '02-04-PLAN.md'), '# Audit plan\n', 'utf8');
      // Remove the literal parent directory so "2-04" has exactly ONE
      // directory candidate: the digit-leading-slug one. This isolates "no
      // `2-04-2024` phase exists, so 2024 must stay slug" from the
      // parent/child specificity claim the two tests above already cover.
      cleanup(path.join(phasesDir, 'GSD-02-04-parent'));

      const plan = computeMigrationPlan(cwd, { convention: 'bracket' });

      const auditRename = plan.phases.find((p) => p.oldDir === 'GSD-02-04-2024-audit');
      assert.ok(auditRename, 'the digit-leading-slug directory must still be matched to the 2-04 mapping');
      assert.equal(auditRename.newDir, 'GSD.02-04-2024-audit', 'the "2024-audit" slug must survive unchanged');
    });
  });

  // #4698 Blocker 1: `applyMigration` stamped `phase_id_convention` only when
  // `plan.phases.length > 0`, but `phases` holds DIRECTORY renames, not
  // converted HEADINGS. A roadmap with recognizable headings and zero phase
  // directories on disk therefore had its headings rewritten to bracket text
  // while config stayed unset — and Blocker 2's own mixed/partial guard above
  // then permanently refuses every retry (headings read bracket, config does
  // not: `alreadyBracket.length > 0 && unconverted.length > 0` after a repair
  // attempt could never apply here since NO unconverted headings remain, but
  // the untouched config also never says "bracket", so a caller checking
  // config directly stays fooled). Activation must instead follow whether any
  // identity — heading OR directory — actually converted.
  describe('activates the convention on converted headings, not just directory renames (#4698 Blocker 1)', () => {
    test('bracket target: headings convert and config is stamped even with zero phase directories', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      cleanup(path.join(cwd, '.planning', 'phases'));

      const plan = computeMigrationPlan(cwd, { convention: 'bracket' });
      assert.equal(plan.alreadyMigrated, false);
      assert.equal(plan.phases.length, 0, 'fixture must have zero phase directories after removal');
      assert.ok(plan.roadmapEdits.length >= 1, 'fixture must still produce heading conversions');

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'headings-only bracket apply');

      const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.match(roadmap, /### \[GSD\.01\] 01: Alpha/);
      assert.match(roadmap, /### \[GSD\.01\] 02: Beta/);
      assert.match(roadmap, /### \[GSD\.02\] 01: Gamma/);
      const config = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
      assert.equal(
        config.phase_id_convention,
        'bracket',
        'config must be stamped once headings convert, even though zero directories were renamed',
      );

      // A second run must see every heading as already bracket and
      // short-circuit to `done` — never re-refuse as "mixed" and never
      // rewrite anything (the exact retry Blocker 1 made unreachable).
      const afterFirst = snapshotTree(cwd, { skipGit: true });
      const second = runBracketUpgrade(cwd, ['--apply']);
      assertExited(second, 0, 'second headings-only bracket apply must be `done`, not refused');
      assert.deepEqual(
        snapshotTree(cwd, { skipGit: true }),
        afterFirst,
        'second run must be a no-op once config already says bracket and headings agree',
      );
    });

    test('the empty-plan refusal from #4698 Blocker 2 still writes nothing (regression guard)', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), '', 'utf8');
      const before = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd, ['--apply']);

      assertExited(result, 1, 'zero recognized headings must still refuse under the Blocker 1 fix');
      assert.match(result.stderr, /No recognized phase headings/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'refusal must write nothing');
    });
  });

  // #4698 Blocker 3: renaming a legacy/M-NN phase DIRECTORY to its bracket
  // identity does not rename the phase-qualified ARTIFACT FILENAMES inside
  // it. Legacy phases are renumbered per milestone by assignBracketTokens
  // (03-gamma in milestone 2 becomes GSD.02-01-gamma — its on-disk token
  // changes from "03" to "01"), so a contained 03-VERIFICATION.md keeps
  // spelling the OLD token and src/phase-id.cts's bracket-convention artifact
  // membership predicate (isPhaseArtifact) then excludes it: the report
  // reads as missing and plans disappear from the phase after migration.
  describe('renames phase-qualified artifacts inside a renamed directory (#4698 Blocker 3)', () => {
    test('dry-run plan previews the artifact renames for every directory whose on-disk token changes', () => {
      const cwd = materializeFixture('legacy-multi-milestone');

      const plan = parseDryRun(runBracketUpgrade(cwd), 'artifact-rename dry-run preview');

      const byOldDir = Object.fromEntries(plan.phases.map((p) => [p.oldDir, p]));
      // "01-alpha" keeps token "01" in its OWN milestone (first legacy phase
      // in milestone 1) — the directory is still renamed (project code +
      // milestone bracket added) but the phase TOKEN itself does not change,
      // so no artifact inside it needs renaming.
      assert.deepEqual(
        byOldDir['01-alpha'].fileRenames,
        [],
        '01-alpha keeps token "01"; its artifacts must not be touched',
      );
      // "02.1-beta" is legacy token "02.1" but becomes the milestone's 2nd
      // phase, bracket token "02" — every artifact must be renamed.
      assert.deepEqual(
        byOldDir['02.1-beta'].fileRenames.sort((a, b) => a.oldName.localeCompare(b.oldName)),
        [
          { oldName: '02.1-01-PLAN.md', newName: '02-01-PLAN.md' },
          { oldName: '02.1-VERIFICATION.md', newName: '02-VERIFICATION.md' },
        ],
      );
      // "03-gamma" is legacy token "03" but is the ONLY phase in milestone 2,
      // so it becomes bracket token "01" — the exact repro from the review
      // finding (03-VERIFICATION.md -> 01-VERIFICATION.md).
      assert.deepEqual(
        byOldDir['03-gamma'].fileRenames.sort((a, b) => a.oldName.localeCompare(b.oldName)),
        [
          { oldName: '03-01-PLAN.md', newName: '01-01-PLAN.md' },
          { oldName: '03-VERIFICATION.md', newName: '01-VERIFICATION.md' },
        ],
      );
    });

    test('dry-run plan previews the M-NN artifact renames when the deep-slice subphase token changes', () => {
      const cwd = materializeFixture('mnn-multi-milestone');

      const plan = parseDryRun(runBracketUpgrade(cwd), 'M-NN artifact-rename dry-run preview');

      const byOldDir = Object.fromEntries(plan.phases.map((p) => [p.oldDir, p]));
      assert.deepEqual(
        byOldDir['GSD-02-01-foundation'].fileRenames.sort((a, b) => a.oldName.localeCompare(b.oldName)),
        [
          { oldName: '02-01-PLAN.md', newName: '01-PLAN.md' },
          { oldName: '02-01-VERIFICATION.md', newName: '01-VERIFICATION.md' },
        ],
      );
      assert.deepEqual(
        byOldDir['GSD-02-04-01-deep-slice'].fileRenames.sort((a, b) => a.oldName.localeCompare(b.oldName)),
        [
          { oldName: '02-04-01-PLAN.md', newName: '04.01-PLAN.md' },
          { oldName: '02-04-01-VERIFICATION.md', newName: '04.01-VERIFICATION.md' },
        ],
      );
    });

    test('apply renames the artifact files on disk, preserving their bytes', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      const gammaBytesBefore = {
        plan: fs.readFileSync(path.join(cwd, '.planning', 'phases', '03-gamma', '03-01-PLAN.md')),
        verification: fs.readFileSync(path.join(cwd, '.planning', 'phases', '03-gamma', '03-VERIFICATION.md')),
      };

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'artifact-rename apply');

      const gammaDir = path.join(cwd, '.planning', 'phases', 'GSD.02-01-gamma');
      assert.equal(fs.existsSync(path.join(gammaDir, '03-01-PLAN.md')), false, 'old plan name must be gone');
      assert.equal(fs.existsSync(path.join(gammaDir, '03-VERIFICATION.md')), false, 'old verification name must be gone');
      assert.deepEqual(
        fs.readFileSync(path.join(gammaDir, '01-01-PLAN.md')),
        gammaBytesBefore.plan,
        'renamed plan file must keep its exact original bytes (it carries no phase: frontmatter to fix)',
      );
      // #4144 round 6 (W-phase): 03-VERIFICATION.md's own `phase: "03"` is a
      // STALE reference to Gamma's own OLD token after its 03 -> 01
      // renumbering — history-digest keys decisions by this exact field, so
      // it must be corrected to "01" (a real byte change), while the rest of
      // the file (the markdown body) stays byte-identical.
      const verificationAfter = fs.readFileSync(path.join(gammaDir, '01-VERIFICATION.md'), 'utf8');
      assert.notDeepEqual(
        Buffer.from(verificationAfter),
        gammaBytesBefore.verification,
        'the verification file\'s stale phase: "03" must actually change',
      );
      assert.equal(extractFrontmatter(verificationAfter).phase, '01', 'phase: must now name Gamma\'s own new token');
      assert.equal(
        extractFrontmatter(verificationAfter).status, 'passed',
        'every other frontmatter key must survive untouched',
      );
      assert.equal(
        verificationAfter.slice(verificationAfter.indexOf('\n# Phase 3')),
        gammaBytesBefore.verification.toString('utf8').slice(gammaBytesBefore.verification.toString('utf8').indexOf('\n# Phase 3')),
        'the markdown body after the frontmatter block must be byte-identical',
      );

      const betaDir = path.join(cwd, '.planning', 'phases', 'GSD.01-02-beta');
      assert.equal(fs.existsSync(path.join(betaDir, '02-01-PLAN.md')), true);
      assert.equal(fs.existsSync(path.join(betaDir, '02-VERIFICATION.md')), true);

      // "01-alpha" -> "GSD.01-01-alpha": token unchanged, artifact names untouched.
      const alphaDir = path.join(cwd, '.planning', 'phases', 'GSD.01-01-alpha');
      assert.equal(fs.existsSync(path.join(alphaDir, '01-01-PLAN.md')), true);
      assert.equal(fs.existsSync(path.join(alphaDir, '01-VERIFICATION.md')), true);
    });

    test('a legacy phase renumbered by the migration is still complete-readable by the real verification reader', () => {
      const cwd = materializeFixture('legacy-multi-milestone');

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'artifact-rename apply for verification-reader check');

      const gammaDir = path.join(cwd, '.planning', 'phases', 'GSD.02-01-gamma');
      const status = readVerificationStatus(gammaDir, { convention: 'bracket' });

      assert.equal(
        status.status,
        'passed',
        'the renamed 01-VERIFICATION.md must still resolve as this phase\'s own report, not "missing"',
      );
    });

    test('a name collision between a renamed artifact and an existing file is refused before any write', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      // "03-gamma" -> bracket token "01": 03-VERIFICATION.md would rename to
      // 01-VERIFICATION.md. Pre-seed that exact colliding name so the plan
      // must refuse rather than silently overwrite or pick one arbitrarily.
      fs.writeFileSync(
        path.join(cwd, '.planning', 'phases', '03-gamma', '01-VERIFICATION.md'),
        'a pre-existing, unrelated file that must not be silently overwritten\n',
        'utf8',
      );
      const before = snapshotTree(cwd, { skipGit: true });

      const dryRun = runBracketUpgrade(cwd);
      assertExited(dryRun, 1, 'artifact-rename collision (dry-run)');
      assert.match(dryRun.stderr, /already has that name|would rename to/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'dry-run refusal must write nothing');

      const apply = runBracketUpgrade(cwd, ['--apply']);
      assertExited(apply, 1, 'artifact-rename collision (apply)');
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'apply refusal must write nothing');
    });

    test('a failure after directory and artifact renames complete rolls both back byte-for-byte', (t) => {
      const cwd = materializeFixture('legacy-multi-milestone');
      const planningPath = path.join(cwd, '.planning');
      const roadmapPath = path.join(planningPath, 'ROADMAP.md');

      const plan = computeMigrationPlan(cwd, { convention: 'bracket' });
      assert.equal(plan.alreadyMigrated, false);
      const gammaEntry = plan.phases.find((p) => p.oldDir === '03-gamma');
      assert.ok(gammaEntry, 'fixture must produce the 03-gamma rename');
      assert.ok(gammaEntry.fileRenames.length >= 1, 'fixture must produce at least one artifact rename to reverse');

      const before = snapshotTree(planningPath);

      // Fail at the ROADMAP.md write — step 2, strictly AFTER step 1's
      // directory renames AND their artifact renames have already completed
      // on disk. This is the specific "failure after the artifact renames"
      // case the brief asks fault-injection to prove reversible.
      const realWrite = fs.writeFileSync;
      const writeMock = mock.method(fs, 'writeFileSync', (target, data, opts) => {
        if (path.resolve(String(target)) === path.resolve(roadmapPath)) {
          throw Object.assign(new Error('EIO: simulated write failure'), { code: 'EIO' });
        }
        return realWrite.call(fs, target, data, opts);
      });
      t.after(() => writeMock.mock.restore());

      let caught;
      try {
        applyMigration(cwd, plan, { dryRun: false });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught, 'a ROADMAP.md write failure must throw, not silently succeed');
      assert.match(caught.message, /Migration failed and rolled back/);
      assert.deepEqual(
        snapshotTree(planningPath),
        before,
        'directory renames AND their artifact renames must both be reversed, byte-for-byte',
      );
    });
  });

  // #4698 Blocker 1 (round 2, Astra pre-push gate round 2): computeArtifactRenames
  // (#4698 Blocker 3, round 1) renames a phase's artifact FILENAMES when its
  // directory's token changes, but a SIBLING plan's `depends_on` frontmatter
  // that names the renamed file by its OLD phase-qualified id kept spelling
  // the old token — the real dependency resolver (computeDependencyLevels,
  // src/phase.cts) then reports the token unresolved and the dependent plan
  // never reaches ready_plans, even once its predecessor completes.
  describe('rewrites stale depends_on references inside renamed phase artifacts (#4698 Blocker 1, round 2)', () => {
    test('matches dependency tokens with the resolver case fold and preserves unrelated content', () => {
      const phaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bracket-case-dependency-'));
      tempRoots.push(phaseDir);
      const predecessor = '---\nphase: "03A"\nplan: "01"\ndepends_on: []\n---\n\nFirst.\n';
      const dependent = '---\nphase: "03A"\nplan: "02"\ndepends_on: ["03a-01"]\n---\n\nSecond.\n';
      fs.writeFileSync(path.join(phaseDir, '03A-01-PLAN.md'), predecessor, 'utf8');
      fs.writeFileSync(path.join(phaseDir, '03A-02-PLAN.md'), dependent, 'utf8');

      const rewrites = computeDependsOnRewrites(
        phaseDir,
        '03A',
        '01',
        [
          { oldName: '03A-01-PLAN.md', newName: '01-01-PLAN.md' },
          { oldName: '03A-02-PLAN.md', newName: '01-02-PLAN.md' },
        ],
      );

      assert.equal(rewrites.length, 1);
      assert.equal(rewrites[0].oldName, '03A-02-PLAN.md');
      assert.equal(rewrites[0].finalName, '01-02-PLAN.md');
      assert.deepEqual(parsePlanDocument(rewrites[0].to).dependsOn, ['01-01']);
      assert.match(rewrites[0].to, /phase: "03A"\nplan: "02"/);
      assert.match(rewrites[0].to, /\n---\n\nSecond\.\n$/);

      fs.renameSync(path.join(phaseDir, '03A-01-PLAN.md'), path.join(phaseDir, '01-01-PLAN.md'));
      fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), rewrites[0].to, 'utf8');
      fs.unlinkSync(path.join(phaseDir, '03A-02-PLAN.md'));
      const { level, unresolved } = readyPlansViaRealResolver(phaseDir);
      assert.deepEqual(unresolved, []);
      assert.equal(level.get('01-01'), 0);
      assert.equal(level.get('01-02'), 1);
    });

    function setupDependsOnRewriteFixture() {
      const cwd = materializeFixture('legacy-multi-milestone');
      // Replace the roadmap with a single phase ("3") that is the ONLY phase
      // in its own milestone — exactly the shape that makes assignBracketTokens
      // renumber it to a DIFFERENT bracket token ("01"), the precondition for
      // any artifact (and therefore any depends_on) rewrite to be needed at all.
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v2.0 — Deps milestone',
          '',
          '### Phase 3: Deps',
          '',
          '- [ ] **Phase 3:** Deps',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      cleanup(path.join(phasesDir, '01-alpha'));
      cleanup(path.join(phasesDir, '02.1-beta'));
      cleanup(path.join(phasesDir, '03-gamma'));
      const depsDir = path.join(phasesDir, '03-deps');
      fs.mkdirSync(depsDir, { recursive: true });
      // Two plans in the SAME phase directory: 02 depends on 01 by its full
      // phase-qualified id, mirroring templates/phase-prompt.md's own
      // documented `depends_on: ["03-01"]` example for a same-phase sibling.
      fs.writeFileSync(
        path.join(depsDir, '03-01-PLAN.md'),
        '---\nphase: "03"\nplan: "01"\ntype: standard\nwave: 1\ndepends_on: []\nautonomous: true\n---\n\n'
        + '<objective>\nFirst plan.\n</objective>\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(depsDir, '03-01-SUMMARY.md'),
        '---\nphase: "03"\nplan: "01"\nstatus: complete\n---\n\nDone.\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(depsDir, '03-02-PLAN.md'),
        '---\nphase: "03"\nplan: "02"\ntype: standard\nwave: 2\ndepends_on: ["03-01"]\nautonomous: true\n---\n\n'
        + '<objective>\nSecond plan, depends on the first.\n</objective>\n',
        'utf8',
      );
      return { cwd, phasesDir, depsDir };
    }

    test('dry-run previews the depends_on rewrite (count and files) and writes zero bytes', () => {
      const { cwd } = setupDependsOnRewriteFixture();
      const before = snapshotTree(cwd, { skipGit: true });

      const plan = parseDryRun(runBracketUpgrade(cwd), 'depends_on rewrite dry-run preview');

      const depsEntry = plan.phases.find((p) => p.oldDir === '03-deps');
      assert.ok(depsEntry, 'fixture must produce the 03-deps rename');
      assert.equal(depsEntry.newDir, 'GSD.02-01-deps');
      // #4144 round 6 (W-phase): every phase-qualified file in this
      // directory carries a stale `phase: "03"` scalar, so all three get a
      // rewrite entry here now — 03-02-PLAN.md's combines its depends_on
      // fix and its own phase fix into ONE splice.
      assert.equal(depsEntry.dependsOnRewrites.length, 3, 'all three phase-qualified files need a rewrite');
      const byOldName = new Map(depsEntry.dependsOnRewrites.map((r) => [r.oldName, r]));
      const dependentRewrite = byOldName.get('03-02-PLAN.md');
      assert.ok(dependentRewrite, 'the dependent plan must have a rewrite entry');
      assert.equal(dependentRewrite.finalName, '01-02-PLAN.md');
      assert.deepEqual(parsePlanDocument(dependentRewrite.to).dependsOn, ['01-01']);
      assert.equal(extractFrontmatter(dependentRewrite.to).phase, '01', 'the dependent plan\'s own phase scalar must also be fixed');
      assert.equal(extractFrontmatter(byOldName.get('03-01-PLAN.md').to).phase, '01', 'the predecessor plan\'s phase scalar must be fixed');
      assert.equal(extractFrontmatter(byOldName.get('03-01-SUMMARY.md').to).phase, '01', 'the summary\'s phase scalar must be fixed');
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'dry-run must write nothing');
    });

    test('a sibling plan id renamed by the migration is still resolved and reported ready by the real dependency resolver', () => {
      const { cwd } = setupDependsOnRewriteFixture();

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'depends_on rewrite apply');

      const newDepsDir = path.join(cwd, '.planning', 'phases', 'GSD.02-01-deps');
      assert.equal(fs.existsSync(path.join(newDepsDir, '01-01-PLAN.md')), true, 'predecessor plan renamed');
      assert.equal(fs.existsSync(path.join(newDepsDir, '01-02-PLAN.md')), true, 'dependent plan renamed');

      const rewritten = fs.readFileSync(path.join(newDepsDir, '01-02-PLAN.md'), 'utf8');
      assert.deepEqual(
        parsePlanDocument(rewritten).dependsOn, ['01-01'],
        'the REAL plan-document parser must read depends_on as naming the renamed sibling',
      );
      assert.doesNotMatch(rewritten, /03-01/, 'the stale phase-03 token must not survive anywhere in the file');
      assert.match(rewritten, /Second plan, depends on the first\./, 'the rest of the file must be untouched');

      const { level, unresolved } = readyPlansViaRealResolver(newDepsDir);
      assert.deepEqual(unresolved, [], 'no depends_on token should be unresolved by the real resolver after the rewrite');
      assert.equal(level.get('01-01'), 0, 'the predecessor is a DAG root');
      assert.equal(
        level.get('01-02'), 1,
        'the dependent sits one level above its now-resolved predecessor — proving a real DAG edge exists, not a dropped one',
      );

      // Readiness itself: 01-01 has a SUMMARY (complete) and 01-02 does not —
      // the textbook definition of "01-02 is ready to start" once its one
      // dependency resolves AND that dependency has completion evidence.
      const { planMap } = readyPlansViaRealResolver(newDepsDir);
      assert.equal(planMap.get('01-01').hasSummary, true);
      assert.equal(planMap.get('01-02').hasSummary, false);
    });

    test('a failure after the depends_on rewrite completes rolls it back byte-for-byte, alongside the renames', (t) => {
      const { cwd } = setupDependsOnRewriteFixture();
      const planningPath = path.join(cwd, '.planning');
      const roadmapPath = path.join(planningPath, 'ROADMAP.md');

      const plan = computeMigrationPlan(cwd, { convention: 'bracket' });
      assert.equal(plan.alreadyMigrated, false);
      const depsEntry = plan.phases.find((p) => p.oldDir === '03-deps');
      assert.ok(depsEntry, 'fixture must produce the 03-deps rename');
      assert.ok(depsEntry.dependsOnRewrites.length >= 1, 'fixture must produce at least one depends_on rewrite to reverse');

      const before = snapshotTree(planningPath);

      // Fail at the ROADMAP.md write — strictly AFTER step 1's directory
      // renames, artifact renames, AND depends_on rewrites have already
      // completed on disk for every phase.
      const realWrite = fs.writeFileSync;
      const writeMock = mock.method(fs, 'writeFileSync', (target, data, opts) => {
        if (path.resolve(String(target)) === path.resolve(roadmapPath)) {
          throw Object.assign(new Error('EIO: simulated write failure'), { code: 'EIO' });
        }
        return realWrite.call(fs, target, data, opts);
      });
      t.after(() => writeMock.mock.restore());

      let caught;
      try {
        applyMigration(cwd, plan, { dryRun: false });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught, 'a ROADMAP.md write failure must throw, not silently succeed');
      assert.match(caught.message, /Migration failed and rolled back/);
      assert.deepEqual(
        snapshotTree(planningPath),
        before,
        'directory renames, artifact renames, AND the depends_on content rewrite must all be reversed, byte-for-byte',
      );
    });
  });

  // #4698 Blocker 2 (round 2, Astra pre-push gate round 2): computeArtifactRenames
  // matched an artifact filename against the directory's own on-disk token as
  // EXACT text, but cmdScaffold always writes artifact filenames using the
  // PADDED form regardless of how the phase's own directory happens to be
  // spelled — an unpadded legacy directory ("3-gamma") holds artifacts
  // prefixed with a spelling ("03-...") its own directory name does not
  // literally contain, so the exact-text match produced zero renames and the
  // phase's real, passing verification report silently read as missing.
  describe('matches artifact prefixes by numeric token equivalence, not literal spelling (#4698 Blocker 2, round 2)', () => {
    function setupPaddedUnpaddedFixture() {
      const cwd = materializeFixture('legacy-multi-milestone');
      const phasesDir = path.join(cwd, '.planning', 'phases');
      // "03-gamma" -> "3-gamma": the DIRECTORY now spells its own token
      // unpadded, while "03-VERIFICATION.md" (already in the base fixture)
      // keeps the padded spelling cmdScaffold actually writes. Also rename
      // the plan file itself to the UNPADDED spelling, so this one directory
      // holds BOTH an already-padded and an unpadded artifact filename.
      fs.renameSync(path.join(phasesDir, '03-gamma'), path.join(phasesDir, '3-gamma'));
      fs.renameSync(path.join(phasesDir, '3-gamma', '03-01-PLAN.md'), path.join(phasesDir, '3-gamma', '3-01-PLAN.md'));
      return { cwd, phasesDir };
    }

    test('a directory spelled unpadded still renames both a padded and an unpadded artifact filename', () => {
      const { cwd } = setupPaddedUnpaddedFixture();

      const plan = parseDryRun(runBracketUpgrade(cwd), 'padded/unpadded dry-run preview');
      const entry = plan.phases.find((p) => p.oldDir === '3-gamma');
      assert.ok(entry, '"3-gamma" must still be matched and migrated despite the unpadded spelling');
      assert.equal(entry.newDir, 'GSD.02-01-gamma');
      assert.deepEqual(
        entry.fileRenames.sort((a, b) => a.oldName.localeCompare(b.oldName)),
        [
          { oldName: '03-VERIFICATION.md', newName: '01-VERIFICATION.md' },
          { oldName: '3-01-PLAN.md', newName: '01-01-PLAN.md' },
        ],
        'both the padded and the unpadded artifact filename must be recognized and renamed',
      );

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'padded/unpadded apply');

      const gammaDir = path.join(cwd, '.planning', 'phases', 'GSD.02-01-gamma');
      assert.equal(fs.existsSync(path.join(gammaDir, '01-VERIFICATION.md')), true);
      assert.equal(fs.existsSync(path.join(gammaDir, '01-01-PLAN.md')), true);
      assert.equal(fs.existsSync(path.join(gammaDir, '03-VERIFICATION.md')), false, 'old padded name must be gone');
      assert.equal(fs.existsSync(path.join(gammaDir, '3-01-PLAN.md')), false, 'old unpadded name must be gone');

      const status = readVerificationStatus(gammaDir, { convention: 'bracket' });
      assert.equal(
        status.status, 'passed',
        'the real verification reader must still resolve the renamed report as this phase\'s own, not "missing"',
      );
    });

    test('a padded/unpadded pair that collides after renaming to the same target is refused before any write', () => {
      const { cwd, phasesDir } = setupPaddedUnpaddedFixture();
      // A second, UNPADDED-spelled verification file: it renames to the exact
      // same target ("01-VERIFICATION.md") as the already-padded one, so both
      // are renamed-away producers colliding on one target.
      fs.writeFileSync(
        path.join(phasesDir, '3-gamma', '3-VERIFICATION.md'),
        'a second, colliding verification file that must not silently overwrite or be silently dropped\n',
        'utf8',
      );
      const before = snapshotTree(cwd, { skipGit: true });

      const dryRun = runBracketUpgrade(cwd);
      assertExited(dryRun, 1, 'padded/unpadded collision (dry-run)');
      assert.match(dryRun.stderr, /already has that name|would rename to/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'dry-run refusal must write nothing');

      const apply = runBracketUpgrade(cwd, ['--apply']);
      assertExited(apply, 1, 'padded/unpadded collision (apply)');
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'apply refusal must write nothing');
    });
  });

  describe('round 4: identifies migratable artifacts with the reader predicate', () => {
    test('de-padded verification and letter-suffixed plan names migrate with the phase and remain reader-visible', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      const phasesDir = path.join(cwd, '.planning', 'phases');
      const gammaDir = path.join(phasesDir, '03-gamma');
      fs.renameSync(
        path.join(gammaDir, '03-VERIFICATION.md'),
        path.join(gammaDir, '3-VERIFICATION.md'),
      );
      fs.renameSync(
        path.join(gammaDir, '03-01-PLAN.md'),
        path.join(gammaDir, '03-01A-PLAN.md'),
      );

      assert.deepEqual(
        scopeToPhase(['3-VERIFICATION.md', '03-01A-PLAN.md'], '03-gamma'),
        ['3-VERIFICATION.md', '03-01A-PLAN.md'],
        'the source reader must attribute both spellings to phase 03 before migration',
      );

      const plan = parseDryRun(runBracketUpgrade(cwd), 'round 4 reader-predicate dry-run');
      const gammaEntry = plan.phases.find((entry) => entry.oldDir === '03-gamma');
      assert.ok(gammaEntry, 'fixture must produce the 03-gamma rename');
      assert.deepEqual(
        gammaEntry.fileRenames.sort((a, b) => a.oldName.localeCompare(b.oldName)),
        [
          { oldName: '03-01A-PLAN.md', newName: '01-01A-PLAN.md' },
          { oldName: '3-VERIFICATION.md', newName: '01-VERIFICATION.md' },
        ],
        'the rename set must be exactly the source reader\'s phase-qualified files',
      );

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'round 4 reader-predicate apply');

      const migratedDir = path.join(phasesDir, 'GSD.02-01-gamma');
      assert.deepEqual(
        scopeToPhase(['01-VERIFICATION.md', '01-01A-PLAN.md'], 'GSD.02-01-gamma', 'bracket'),
        ['01-VERIFICATION.md', '01-01A-PLAN.md'],
        'the target reader must still attribute both renamed files to the migrated phase',
      );
      assert.equal(
        readVerificationStatus(migratedDir, { convention: 'bracket' }).status,
        'passed',
        'the real completion reader must retain the de-padded verification evidence after migration',
      );
    });

    test('a source phase token with a letter axis the bracket grammar cannot express is refused before any write', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        '# Roadmap\n\n## v2.0 — Variants\n\n### Phase 3A: Variant alpha\n',
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      cleanup(path.join(phasesDir, '01-alpha'));
      cleanup(path.join(phasesDir, '02.1-beta'));
      fs.renameSync(path.join(phasesDir, '03-gamma'), path.join(phasesDir, '03A-variant-alpha'));
      fs.renameSync(
        path.join(phasesDir, '03A-variant-alpha', '03-01-PLAN.md'),
        path.join(phasesDir, '03A-variant-alpha', '03A-01-PLAN.md'),
      );
      fs.renameSync(
        path.join(phasesDir, '03A-variant-alpha', '03-VERIFICATION.md'),
        path.join(phasesDir, '03A-variant-alpha', '03A-VERIFICATION.md'),
      );
      const before = snapshotTree(cwd, { skipGit: true });

      const dryRun = runBracketUpgrade(cwd);
      assertExited(dryRun, 1, 'unrepresentable letter-axis phase (dry-run)');
      assert.match(dryRun.stderr, /Phase 3A/);
      assert.match(dryRun.stderr, /bracket grammar cannot represent/i);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'dry-run refusal must write nothing');

      const apply = runBracketUpgrade(cwd, ['--apply']);
      assertExited(apply, 1, 'unrepresentable letter-axis phase (apply)');
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'apply refusal must write nothing');
    });
  });

  describe('round 4: attributes legacy phases through reader milestone sections', () => {
    test('the shipped archived-details plus current-section shape keeps each phase in its own milestone', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## Milestones',
          '',
          '- ✅ **v1.0 Foundation** - Phases 1-2 (shipped)',
          '- 🚧 **v2.0 Current** - Phase 3 (in progress)',
          '',
          '## Phases',
          '',
          '<details>',
          '<summary>✅ v1.0 Foundation (Phases 1-2) - SHIPPED</summary>',
          '',
          '### Phase 1: Alpha',
          '',
          '### Phase 2.1: Beta',
          '',
          '</details>',
          '',
          '### 🚧 v2.0 Current (In Progress)',
          '',
          '#### Phase 3: Gamma',
          '',
        ].join('\n'),
        'utf8',
      );

      const plan = parseDryRun(runBracketUpgrade(cwd), 'round 4 milestone-section dry-run');
      assert.deepEqual(
        plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })),
        [
          { oldDir: '01-alpha', newDir: 'GSD.01-01-alpha' },
          { oldDir: '02.1-beta', newDir: 'GSD.01-02-beta' },
          { oldDir: '03-gamma', newDir: 'GSD.02-01-gamma' },
        ],
        'STATE v2.0 must not pull the archived v1.0 phases into milestone 02',
      );
      assert.ok(plan.roadmapEdits.some(({ to }) => to === '### [GSD.01] 01: Alpha'));
      assert.ok(plan.roadmapEdits.some(({ to }) => to === '### [GSD.01] 02: Beta'));
      assert.ok(plan.roadmapEdits.some(({ to }) => to === '#### [GSD.02] 01: Gamma'));
    });

    test('two milestone sections plus a phase outside every attributable section refuses before any write', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '### Phase 9: Orphan',
          '',
          '## v1.0 — Foundation',
          '',
          '### Phase 1: Alpha',
          '',
          '## v2.0 — Current',
          '',
          '### Phase 3: Gamma',
          '',
        ].join('\n'),
        'utf8',
      );
      const before = snapshotTree(cwd, { skipGit: true });

      const dryRun = runBracketUpgrade(cwd);
      assertExited(dryRun, 1, 'phase outside multiple milestone sections (dry-run)');
      assert.match(dryRun.stderr, /Cannot attribute legacy phase heading/i);
      assert.match(dryRun.stderr, /Phase 9/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'dry-run refusal must write nothing');

      const apply = runBracketUpgrade(cwd, ['--apply']);
      assertExited(apply, 1, 'phase outside multiple milestone sections (apply)');
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'apply refusal must write nothing');
    });
  });

  // #4698 Blocker 3 (round 2, Astra pre-push gate round 2): a heading the
  // runtime already supports — an optional parenthetical tag between the
  // phase number and the colon (`### Phase 2 (Cluster B): Beta`,
  // OPTIONAL_PHASE_TAG_SOURCE, src/phase-id.cts #1729) — was not matched by
  // this migrator's own legacy/M-NN heading regexes, so it was silently
  // skipped while a different heading converted fine; the partial migration
  // then stamped phase_id_convention and the next run reported "done".
  describe('recognizes tagged phase headings and refuses unparsed ones (#4698 Blocker 3, round 2)', () => {
    test('a supported parenthetical tag survives migration in the position the bracket grammar accepts', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 — Foundation',
          '',
          '### Phase 1: Alpha',
          '',
          '- [ ] **Phase 1:** Alpha',
          '',
          '### Phase 2 (Cluster B): Beta',
          '',
          '- [ ] **Phase 2 (Cluster B):** Beta',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      cleanup(path.join(phasesDir, '02.1-beta'));
      cleanup(path.join(phasesDir, '03-gamma'));

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'tagged heading apply');

      const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.match(roadmap, /### \[GSD\.01\] 01: Alpha/);
      assert.match(
        roadmap, /### \[GSD\.01\] 02 \(Cluster B\): Beta/,
        'the tag must be preserved, in the position the real bracket heading grammar accepts one (src/roadmap.cts)',
      );
      assert.match(
        roadmap, /- \[ \] \*\*\[GSD\.01\] 02 \(Cluster B\):\*\* Beta/,
        'the checklist row must also convert and preserve the tag',
      );

      const config = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
      assert.equal(config.phase_id_convention, 'bracket');

      // Idempotent re-run: the tagged bracket heading must be recognized as
      // already migrated, never refused as a textual mix and never rewritten
      // again — the exact retry the reported defect made unreachable.
      const afterFirst = snapshotTree(cwd, { skipGit: true });
      const second = runBracketUpgrade(cwd, ['--apply']);
      assertExited(second, 0, 'second apply over an already-tagged bracket heading must be done, not refused');
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), afterFirst, 'second run must be a no-op');
    });

    test('a heading that starts like a phase heading but matches no grammar is refused, with nothing written', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 — Foundation',
          '',
          '### Phase 1: Alpha',
          '',
          '### Phase Two: NoNumber',
          '',
        ].join('\n'),
        'utf8',
      );
      const before = snapshotTree(cwd, { skipGit: true });

      const dryRun = runBracketUpgrade(cwd);
      assertExited(dryRun, 1, 'unparseable phase-like heading (dry-run)');
      assert.match(dryRun.stderr, /do not match any recognized grammar/);
      assert.match(dryRun.stderr, /### Phase Two: NoNumber/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'dry-run refusal must write nothing');

      const apply = runBracketUpgrade(cwd, ['--apply']);
      assertExited(apply, 1, 'unparseable phase-like heading (apply)');
      assert.match(apply.stderr, /### Phase Two: NoNumber/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'apply refusal must write nothing');
    });
  });

  // #4144 round 5 Blocker 1 (Astra pass on PR 4773, regression from round 3):
  // gsd-core/templates/roadmap.md's own shipped "## Phase Details" section
  // heading (no phase number, no colon) was classified as an unrecognized
  // "phase-like" heading by PHASE_HEADING_LIKE_RE (a bare `/^#{2,4}\s*Phase\b/i`
  // — anything starting with the word "Phase"), and the round-2 unparsed-
  // heading refusal then aborted migration of every roadmap built from the
  // template verbatim. The readers' OWN phase-heading grammar
  // (roadmap-parser.cts's hasPhaseEntries, now exported as
  // `isPhaseHeadingText`) requires a phase NUMBER token and a trailing colon
  // — "## Phase Details" satisfies neither — so gating the refusal on that
  // predicate instead lets an ordinary section heading pass through
  // untouched while still refusing anything the readers themselves would
  // treat as a phase heading the migrator's three grammars cannot parse.
  describe('refuses only headings the readers\' own phase-heading grammar accepts (#4144 round 5 Blocker 1)', () => {
    test('a roadmap built from the shipped template migrates cleanly and keeps `## Phase Details` byte-identical', () => {
      const cwd = materializeEmptyFixture('template-roadmap');
      const roadmap = buildTemplateRoadmap();
      assert.match(
        roadmap, /^## Phase Details$/m,
        'sanity: the template must still carry the literal section heading this regression is about',
      );
      fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), roadmap, 'utf8');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'NIM', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'STATE.md'),
        '---\nmilestone: v1.0\n---\n\n# Project State\n',
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const dir of ['01-alpha', '02-beta', '02.1-critical-fix', '03-gamma', '04-delta']) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
      }

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'template-built roadmap apply');

      const migrated = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.ok(
        splitLines(migrated).includes('## Phase Details'),
        '`## Phase Details` must survive the migration byte-identical, never treated as an unparsed phase-like heading',
      );
      assert.match(migrated, /^### \[NIM\.01\] 01: Alpha$/m);
      assert.match(
        migrated, /^### \[NIM\.01\] 03: Critical Fix \(INSERTED\)$/m,
        'the decimal-inserted legacy phase converts too, counter-assigned like every other legacy phase',
      );
      assert.match(migrated, /^### \[NIM\.01\] 05: Delta$/m);

      // Readable by the real bracket-aware roadmap reader, not merely present as text.
      assert.equal(hasPhaseEntries(migrated, 'bracket'), true);

      // Readable by the real directory matcher too.
      const dirsAfter = fs.readdirSync(phasesDir);
      const match = matchPhaseDirs(dirsAfter, 'NIM.01-03', 'bracket');
      assert.deepEqual(match.matches, ['NIM.01-03-critical-fix']);
    });

    test('`## Phase Details`, `## Phase Lifecycle`, and `### Phase Notes` are not phase-like and pass through untouched', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      const before = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      const withExtras = before
        + '\n## Phase Details\n\nSee below.\n\n## Phase Lifecycle\n\nDraft -> Active -> Shipped.\n\n'
        + '### Phase Notes\n\nMisc notes.\n';
      fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), withExtras, 'utf8');

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'benign non-colon Phase-word headings must not abort migration');

      const migrated = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      const migratedLines = splitLines(migrated);
      for (const heading of ['## Phase Details', '## Phase Lifecycle', '### Phase Notes']) {
        assert.ok(migratedLines.includes(heading), `${heading} must survive byte-identical`);
      }
    });

    test('a heading the readers do treat as phase-like, but none of the three grammars accept, is still refused', () => {
      // "### Phase Two: NoNumber" above already covers a token-free custom
      // heading; this covers the OTHER shape the readers' grammar accepts —
      // a non-numeric custom id token ("AUTH-101") with a colon — which none
      // of BRACKET_PHASE_HEADING_RE / MNN_PHASE_HEADING_BRACKET_RE /
      // LEGACY_PHASE_HEADING_BRACKET_RE accept (all three require a
      // digit-led PHASE_NUMBER_TOKEN_SOURCE or MNN_SOURCE_TOKEN_SOURCE).
      const cwd = materializeFixture('legacy-multi-milestone');
      const before = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        before + '\n### Phase AUTH-101: Custom ID\n',
        'utf8',
      );
      const snapshot = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 1, 'still-unrecognized custom-id heading must refuse');
      assert.match(result.stderr, /do not match any recognized grammar/);
      assert.match(result.stderr, /### Phase AUTH-101: Custom ID/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), snapshot, 'refusal must write nothing');
    });

    test('the exported reader phase-heading predicate draws exactly the boundary the migrator must respect', () => {
      assert.equal(isPhaseHeadingText('Phase 1: Alpha'), true);
      assert.equal(isPhaseHeadingText('Phase AUTH-101: Custom ID'), true);
      assert.equal(isPhaseHeadingText('Phase Details'), false);
      assert.equal(isPhaseHeadingText('Phase Lifecycle'), false);
      assert.equal(isPhaseHeadingText('Phase Notes'), false);
    });
  });

  // #4144 round 5 Blocker 2: `assignBracketTokens` ran ONE counter per
  // milestone for legacy phases and never consulted a PRESERVED M-NN token's
  // own integer identity — so `### Phase 2-01: Alpha` (M-NN, preserved as
  // `01`) and a later `### Phase 3: Beta` (legacy, counter-assigned) under
  // the SAME milestone both resolved to `[GSD.02] 01`, and the planner wrote
  // that collision to disk without refusing (matchPhaseDirs then returns
  // both directories for the one token). Fix: a preserved M-NN token now
  // RESERVES its own leading integer segment against that milestone's
  // legacy counter, and any remaining (milestone, token) collision — two
  // preserved M-NN spellings of the same integer included — is refused
  // before any write, naming every colliding heading.
  describe('reserves preserved M-NN tokens before assigning legacy counters (#4144 round 5 Blocker 2)', () => {
    test('a preserved M-NN token and a legacy phase in the same milestone no longer collide', () => {
      const cwd = materializeFixture('mnn-legacy-reservation');

      const plan = parseDryRun(runBracketUpgrade(cwd), 'M-NN/legacy reservation dry-run');
      assert.deepEqual(
        plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })).sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        [
          { oldDir: '03-beta', newDir: 'GSD.02-02-beta' },
          { oldDir: '05-eta', newDir: 'GSD.03-01-eta' },
          { oldDir: 'GSD-02-01-alpha', newDir: 'GSD.02-01-alpha' },
          { oldDir: 'GSD-03-04-01-zeta', newDir: 'GSD.03-04.01-zeta' },
        ].sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
      );
      assert.ok(plan.roadmapEdits.some(({ to }) => to === '### [GSD.02] 01: Alpha'));
      assert.ok(
        plan.roadmapEdits.some(({ to }) => to === '### [GSD.02] 02: Beta'),
        'the legacy phase must skip the M-NN-reserved value 01 and take the next free counter, 02',
      );
      assert.ok(plan.roadmapEdits.some(({ to }) => to === '### [GSD.03] 04.01: Zeta'));
      assert.ok(
        plan.roadmapEdits.some(({ to }) => to === '### [GSD.03] 01: Eta'),
        'a lone legacy phase in a milestone whose only reservation is 04 still starts counting at 01',
      );

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'M-NN/legacy reservation apply');
      assert.deepEqual(
        phaseDirs(cwd),
        ['GSD.02-01-alpha', 'GSD.02-02-beta', 'GSD.03-01-eta', 'GSD.03-04.01-zeta'],
        'all four phases must land in their own distinct directory — no collision',
      );
    });

    test('two preserved M-NN spellings of the same integer collide and are refused before any write, both named', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v2.0 — Collision',
          '',
          '### Phase 2-01: Alpha',
          '',
          '### Phase 2-1: Also Alpha',
          '',
        ].join('\n'),
        'utf8',
      );
      const before = snapshotTree(cwd, { skipGit: true });

      const dryRun = runBracketUpgrade(cwd);
      assertExited(dryRun, 1, 'M-NN token collision (dry-run)');
      assert.match(dryRun.stderr, /same bracket token/i);
      assert.match(dryRun.stderr, /### Phase 2-01: Alpha/);
      assert.match(dryRun.stderr, /### Phase 2-1: Also Alpha/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'dry-run refusal must write nothing');

      const apply = runBracketUpgrade(cwd, ['--apply']);
      assertExited(apply, 1, 'M-NN token collision (apply)');
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'apply refusal must write nothing');
    });
  });

  // #4144 round 5 Blocker 3: computeDependsOnRewrites indexed only the FULL
  // filename-derived plan id (`03-01-setup`), but the real resolver
  // (computeDependencyLevels / resolveDependencyId, src/phase.cts) also
  // resolves a depends_on token against extractCanonicalPlanId's shorter
  // alias (core-utils.cts) — `03-01-setup-PLAN.md` is reachable as `03-01`
  // as well as its full slugged id. A depends_on referencing a renamed plan
  // by that canonical alias silently stopped resolving after the rename
  // (the rewrite map had no entry for it), producing a dropped edge the real
  // resolver reports unresolved.
  describe('rewrites depends_on through every alias the real resolver accepts (#4144 round 5 Blocker 3)', () => {
    test('indexes the canonical alias a depends_on reference uses, not just the full filename-derived id', () => {
      const phaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bracket-canonical-alias-dependency-'));
      tempRoots.push(phaseDir);
      const predecessor = '---\nphase: "03"\nplan: "01"\ndepends_on: []\n---\n\nSetup.\n';
      // Referenced by its CANONICAL ALIAS ("03-01"), not its full slugged id
      // ("03-01-setup") — the real resolver's canonicalToId map (built from
      // extractCanonicalPlanId) accepts both spellings.
      const byAlias = '---\nphase: "03"\nplan: "02"\ndepends_on: ["03-01"]\n---\n\nFollowup.\n';
      // Referenced by its FULL id — proving that path still rewrites
      // alongside the new alias path, not instead of it.
      const byFullId = '---\nphase: "03"\nplan: "03"\ndepends_on: ["03-01-setup"]\n---\n\nFull.\n';
      fs.writeFileSync(path.join(phaseDir, '03-01-setup-PLAN.md'), predecessor, 'utf8');
      fs.writeFileSync(path.join(phaseDir, '03-02-followup-PLAN.md'), byAlias, 'utf8');
      fs.writeFileSync(path.join(phaseDir, '03-03-full-PLAN.md'), byFullId, 'utf8');

      const rewrites = computeDependsOnRewrites(
        phaseDir,
        '03',
        '01',
        [
          { oldName: '03-01-setup-PLAN.md', newName: '01-01-setup-PLAN.md' },
          { oldName: '03-02-followup-PLAN.md', newName: '01-02-followup-PLAN.md' },
          { oldName: '03-03-full-PLAN.md', newName: '01-03-full-PLAN.md' },
        ],
      );

      const byOldName = new Map(rewrites.map((r) => [r.oldName, r]));
      assert.equal(rewrites.length, 2, 'exactly the alias reference and the full-id reference need rewriting');
      assert.deepEqual(
        parsePlanDocument(byOldName.get('03-02-followup-PLAN.md').to).dependsOn,
        ['01-01'],
        'the canonical-alias reference must rewrite to the SAME alias of the renamed file, not its full id',
      );
      assert.deepEqual(
        parsePlanDocument(byOldName.get('03-03-full-PLAN.md').to).dependsOn,
        ['01-01-setup'],
        'a dependency referenced by its full id must still rewrite to the full id',
      );
    });

    function setupCanonicalAliasDependsOnFixture() {
      const cwd = materializeFixture('legacy-multi-milestone');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v2.0 — Deps milestone',
          '',
          '### Phase 3: Deps',
          '',
          '- [ ] **Phase 3:** Deps',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      cleanup(path.join(phasesDir, '01-alpha'));
      cleanup(path.join(phasesDir, '02.1-beta'));
      cleanup(path.join(phasesDir, '03-gamma'));
      const depsDir = path.join(phasesDir, '03-deps');
      fs.mkdirSync(depsDir, { recursive: true });
      fs.writeFileSync(
        path.join(depsDir, '03-01-setup-PLAN.md'),
        '---\nphase: "03"\nplan: "01"\ntype: standard\nwave: 1\ndepends_on: []\nautonomous: true\n---\n\n'
        + '<objective>\nSetup plan.\n</objective>\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(depsDir, '03-01-setup-SUMMARY.md'),
        '---\nphase: "03"\nplan: "01"\nstatus: complete\n---\n\nDone.\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(depsDir, '03-02-followup-PLAN.md'),
        '---\nphase: "03"\nplan: "02"\ntype: standard\nwave: 2\ndepends_on: ["03-01"]\nautonomous: true\n---\n\n'
        + '<objective>\nFollowup plan, depends on setup by its canonical alias.\n</objective>\n',
        'utf8',
      );
      return { cwd, phasesDir, depsDir };
    }

    test('a plan referenced by its canonical alias (not its full slugged id) still resolves after the rename', () => {
      const { cwd } = setupCanonicalAliasDependsOnFixture();

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'canonical-alias depends_on rewrite apply');

      const newDepsDir = path.join(cwd, '.planning', 'phases', 'GSD.02-01-deps');
      assert.equal(fs.existsSync(path.join(newDepsDir, '01-01-setup-PLAN.md')), true, 'predecessor plan renamed');
      assert.equal(fs.existsSync(path.join(newDepsDir, '01-02-followup-PLAN.md')), true, 'dependent plan renamed');

      const rewritten = fs.readFileSync(path.join(newDepsDir, '01-02-followup-PLAN.md'), 'utf8');
      assert.deepEqual(
        parsePlanDocument(rewritten).dependsOn,
        ['01-01'],
        'the REAL plan-document parser must read depends_on as the renamed predecessor\'s own canonical alias',
      );
      assert.doesNotMatch(rewritten, /03-01/, 'the stale phase-03 token must not survive anywhere in the file');
      assert.match(rewritten, /Followup plan, depends on setup by its canonical alias\./, 'the rest of the file must be untouched');

      const { level, unresolved } = readyPlansViaRealResolver(newDepsDir);
      assert.deepEqual(unresolved, [], 'no depends_on token should be unresolved by the real resolver after the rewrite');
      assert.equal(level.get('01-01-setup'), 0, 'the predecessor is a DAG root');
      assert.equal(
        level.get('01-02-followup'), 1,
        'the dependent sits one level above its now-resolved predecessor — a real DAG edge exists via the canonical alias, not a dropped one',
      );
    });

    test('a failure after the alias depends_on rewrite completes rolls it back byte-for-byte, alongside the renames', (t) => {
      const { cwd } = setupCanonicalAliasDependsOnFixture();
      const planningPath = path.join(cwd, '.planning');
      const roadmapPath = path.join(planningPath, 'ROADMAP.md');

      const plan = computeMigrationPlan(cwd, { convention: 'bracket' });
      assert.equal(plan.alreadyMigrated, false);
      const depsEntry = plan.phases.find((p) => p.oldDir === '03-deps');
      assert.ok(depsEntry, 'fixture must produce the 03-deps rename');
      assert.ok(
        depsEntry.dependsOnRewrites.length >= 1,
        'fixture must produce at least one depends_on rewrite to reverse',
      );

      const before = snapshotTree(planningPath);

      const realWrite = fs.writeFileSync;
      const writeMock = mock.method(fs, 'writeFileSync', (target, data, opts) => {
        if (path.resolve(String(target)) === path.resolve(roadmapPath)) {
          throw Object.assign(new Error('EIO: simulated write failure'), { code: 'EIO' });
        }
        return realWrite.call(fs, target, data, opts);
      });
      t.after(() => writeMock.mock.restore());

      let caught;
      try {
        applyMigration(cwd, plan, { dryRun: false });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught, 'a ROADMAP.md write failure must throw, not silently succeed');
      assert.match(caught.message, /Migration failed and rolled back/);
      assert.deepEqual(
        snapshotTree(planningPath),
        before,
        'directory renames, artifact renames, AND the canonical-alias depends_on rewrite must all be reversed, byte-for-byte',
      );
    });
  });

  // #4144 round 5 Blocker 4 (Warn): parseBracketSourcePhases walked raw
  // lines with no fence awareness, so a fenced markdown EXAMPLE containing a
  // `### Phase N: Name`-shaped line was parsed as a real phase and consumed
  // a counter value — the readers use fence-aware `tokenizeHeadings`
  // (markdown-sectionizer.cts, used at roadmap-parser.cts:689) for exactly
  // this reason. Fix: skip every line inside a fenced code block using
  // `scanFencedBlocks`, the same fence-scanning engine, before testing it
  // against any of the milestone/bracket/M-NN/legacy/unparsed grammars.
  describe('skips fenced headings the way the readers do (#4144 round 5 Blocker 4)', () => {
    test('a fenced example phase heading is never converted, counted, or refused, and the real phase keeps 01', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      const phasesDir = path.join(cwd, '.planning', 'phases');
      cleanup(path.join(phasesDir, '02.1-beta'));
      cleanup(path.join(phasesDir, '03-gamma'));

      const fencedLines = [
        '```markdown',
        '### Phase 99: Example only',
        '## Phase Details',
        '### Phase Two: NoNumber',
        '```',
      ];
      const roadmap = [
        '# Roadmap',
        '',
        '## v1.0 — Foundation',
        '',
        'Example syntax for the phase-heading convention:',
        '',
        ...fencedLines,
        '',
        '### Phase 1: Alpha',
        '',
        '- [ ] **Phase 1:** Alpha',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), roadmap, 'utf8');

      const plan = parseDryRun(runBracketUpgrade(cwd), 'fenced example dry-run');
      assert.deepEqual(
        plan.roadmapEdits.map(({ from, to }) => ({ from, to })),
        [
          { from: '### Phase 1: Alpha', to: '### [GSD.01] 01: Alpha' },
          { from: '- [ ] **Phase 1:** Alpha', to: '- [ ] **[GSD.01] 01:** Alpha' },
        ],
        'the fenced "### Phase 99" line must never be edited, counted, or reserved — Alpha gets 01, not 02',
      );

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'fenced example apply');

      const migrated = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      const migratedLines = splitLines(migrated);
      for (const line of fencedLines) {
        assert.ok(migratedLines.includes(line), `fenced line ${JSON.stringify(line)} must survive byte-identical`);
      }
      assert.match(migrated, /^### \[GSD\.01\] 01: Alpha$/m);
    });

    test('a fence containing only unparseable/phase-like headings does not trigger the unparsed-heading refusal', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      const phasesDir = path.join(cwd, '.planning', 'phases');
      cleanup(path.join(phasesDir, '02.1-beta'));
      cleanup(path.join(phasesDir, '03-gamma'));

      const roadmap = [
        '# Roadmap',
        '',
        '## v1.0 — Foundation',
        '',
        '```markdown',
        '### Phase AUTH-101: Custom ID',
        '### Phase Two: NoNumber',
        '## Phase Details',
        '```',
        '',
        '### Phase 1: Alpha',
        '',
        '- [ ] **Phase 1:** Alpha',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), roadmap, 'utf8');

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'fenced malformed headings must never trigger the unparsed-heading refusal');

      const migrated = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.match(migrated, /### Phase AUTH-101: Custom ID/, 'fenced malformed heading survives untouched');
      assert.match(migrated, /### Phase Two: NoNumber/, 'fenced malformed heading survives untouched');
      assert.match(migrated, /## Phase Details/, 'fenced section heading survives untouched');
      assert.match(migrated, /^### \[GSD\.01\] 01: Alpha$/m);
    });
  });

  // #4144 round 5 follow-up (lint-plan-count-drift): computeDependsOnRewrites
  // tested plan-file membership with a private inline `/-PLAN\.md$/i` regex —
  // an independent re-derivation of the plan-scan owner's own root-plan-file
  // test (isRootPlanFile, src/plan-scan.cts). That owner accepts more than
  // the private regex did: a bare `PLAN.md`, and the legacy delimited slug
  // form (`3-PLAN-01-setup.md`) gsd-plan-phase historically wrote — both of
  // which the private regex rejected outright, silently skipping ANY
  // depends_on alias registration for such a plan (neither its full id nor
  // its canonical alias was ever indexed).
  describe('selects plan files through the plan-scan owner in depends_on rewrites (#4144 round 5 follow-up)', () => {
    test('a bare PLAN.md the old inline regex rejected still gets its depends_on alias registered and rewritten', () => {
      const phaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bracket-root-plan-file-owner-'));
      tempRoots.push(phaseDir);
      const predecessor = '---\nphase: "03"\nplan: "01"\ndepends_on: []\n---\n\nBare-named predecessor.\n';
      // References the bare-named predecessor by its CANONICAL alias — the
      // same alias extractCanonicalPlanId derives from its bare filename.
      const dependent = '---\nphase: "03"\nplan: "02"\ndepends_on: ["PLAN"]\n---\n\nDependent.\n';
      fs.writeFileSync(path.join(phaseDir, 'PLAN.md'), predecessor, 'utf8');
      fs.writeFileSync(path.join(phaseDir, '03-02-followup-PLAN.md'), dependent, 'utf8');

      const rewrites = computeDependsOnRewrites(
        phaseDir,
        '03',
        '01',
        [
          { oldName: 'PLAN.md', newName: '01-PLAN.md' },
          { oldName: '03-02-followup-PLAN.md', newName: '01-02-followup-PLAN.md' },
        ],
      );

      const followupRewrite = rewrites.find((r) => r.oldName === '03-02-followup-PLAN.md');
      assert.ok(
        followupRewrite,
        'isRootPlanFile accepts the bare "PLAN.md" rename the old /-PLAN\\.md$/i test rejected outright, '
        + 'so its alias must now be registered and this dependency rewritten',
      );
      assert.deepEqual(parsePlanDocument(followupRewrite.to).dependsOn, ['01']);
    });
  });

  // #4144 round 6 B1: legacy sentinel phases (`Phase 999.x` icebox, `Phase
  // 0.x` backlog/pre-milestone) are excluded from every phase COUNT under the
  // legacy convention (`isSentinelPhaseId`, phase-id.cts). Folding them into
  // the enclosing real milestone's own counter (the pre-fix behavior) both
  // consumes a real milestone's counter slot and makes `roadmap analyze`
  // count phases the legacy roadmap never counted. A sentinel must be lifted
  // into the bracket sentinel MILESTONE the grammar defines for it instead.
  describe('lifts legacy sentinel phases into the bracket sentinel milestones (#4144 round 6 B1)', () => {
    function buildSentinelFixture() {
      const cwd = materializeEmptyFixture('sentinel');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v2.0 Scale',
          '',
          '### Phase 5: Real',
          '**Goal**: r',
          '',
          '### Phase 6: Also real',
          '**Goal**: r2',
          '',
          '### Phase 999.1: Icebox idea',
          '**Goal**: later',
          '',
          '### Phase 0.5: Bootstrap note',
          '**Goal**: pre',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const [dir, num] of [
        ['05-real', '05'],
        ['06-also-real', '06'],
        ['999.1-icebox-idea', '999.1'],
        ['0.5-bootstrap-note', '0.5'],
      ]) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
        fs.writeFileSync(
          path.join(phasesDir, dir, `${num}-01-PLAN.md`),
          `---\nphase: "${num}"\nplan: "01"\n---\n# Plan\n`,
          'utf8',
        );
      }
      return cwd;
    }

    test('999.x and 0.x lift into their own sentinel bracket milestone, never the enclosing real milestone', () => {
      const cwd = buildSentinelFixture();
      const plan = parseDryRun(runBracketUpgrade(cwd), 'sentinel dry-run');

      assert.deepEqual(
        plan.phases
          .map(({ oldDir, newDir }) => ({ oldDir, newDir }))
          .sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        [
          { oldDir: '0.5-bootstrap-note', newDir: 'GSD.00-01-bootstrap-note' },
          { oldDir: '05-real', newDir: 'GSD.02-01-real' },
          { oldDir: '06-also-real', newDir: 'GSD.02-02-also-real' },
          { oldDir: '999.1-icebox-idea', newDir: 'GSD.999-01-icebox-idea' },
        ].sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        'the real milestone keeps exactly its own two phases; sentinels move to their own milestones',
      );
      assert.ok(plan.roadmapEdits.some(({ to }) => to === '### [GSD.999] 01: Icebox idea'));
      assert.ok(plan.roadmapEdits.some(({ to }) => to === '### [GSD.00] 01: Bootstrap note'));
      assert.ok(plan.roadmapEdits.some(({ to }) => to === '### [GSD.02] 01: Real'));
      assert.ok(plan.roadmapEdits.some(({ to }) => to === '### [GSD.02] 02: Also real'));

      assert.equal(isSentinelPhaseId('GSD.999-01-icebox-idea', 'bracket'), true);
      assert.equal(isSentinelPhaseId('GSD.00-01-bootstrap-note', 'bracket'), true);

      const applied = runBracketUpgrade(cwd, ['--apply']);
      assertExited(applied, 0, 'sentinel apply');
      const analyzed = JSON.parse(runNode(
        [TOOLS_PATH, 'roadmap', 'analyze'],
        { cwd, env: { ...process.env, ...helpers.TEST_ENV_BASE, HOME: cwd }, timeoutMs: COMMAND_TIMEOUT_MS },
      ).stdout);
      assert.deepEqual(
        analyzed.phases.map((p) => p.number).sort(),
        ['01', '02'],
        'roadmap analyze must still count exactly the two real phases — sentinels excluded, same as before migration',
      );
    });
  });

  // #4144 round 7 B1: the HEADING side already bypasses section attribution
  // for a legacy sentinel (`legacySentinelMilestone`, consulted before
  // `entry.attributedSection` is ever set — B1 above), but the CHECKLIST
  // lookup did not: a sentinel's own bullet can sit inside a real `## vN.M`
  // section on disk (nothing stops an author from listing an icebox item
  // next to the real phases it is scheduled near), and the bullet loop
  // looked it up only in that ENCLOSING section's bucket — where a sentinel
  // is never filed (it always lands under GLOBAL_SECTION_KEY, since it never
  // receives an `attributedSection`). A roadmap `roadmap analyze` reports
  // clean was refused.
  describe('resolves a sentinel checklist bullet regardless of its enclosing section (#4144 round 7 B1)', () => {
    function buildSentinelChecklistFixture() {
      const cwd = materializeEmptyFixture('sentinel-checklist');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v2.0 Scale',
          '',
          '- [ ] **Phase 5: Real** - r',
          '- [ ] **Phase 6: Also real** - r2',
          '- [ ] **Phase 999.1: Icebox idea** - later',
          '',
          '### Phase 5: Real',
          '**Goal**: r',
          '',
          '### Phase 6: Also real',
          '**Goal**: r2',
          '',
          '### Phase 999.1: Icebox idea',
          '**Goal**: later',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const [dir, num] of [
        ['05-real', '05'],
        ['06-also-real', '06'],
        ['999.1-icebox-idea', '999.1'],
      ]) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
        fs.writeFileSync(
          path.join(phasesDir, dir, `${num}-01-PLAN.md`),
          `---\nphase: "${num}"\nplan: "01"\n---\n# Plan\n`,
          'utf8',
        );
      }
      return cwd;
    }

    test('a sentinel checklist bullet inside a real milestone section converts to its own sentinel milestone', () => {
      const cwd = buildSentinelChecklistFixture();
      const plan = parseDryRun(runBracketUpgrade(cwd), 'sentinel checklist bullet dry-run');

      const editFor = (text) => plan.roadmapEdits.find(({ from }) => from === text);
      assert.equal(
        editFor('- [ ] **Phase 999.1: Icebox idea** - later')?.to,
        '- [ ] **[GSD.999] 01: Icebox idea** - later',
      );
      assert.equal(editFor('- [ ] **Phase 5: Real** - r')?.to, '- [ ] **[GSD.02] 01: Real** - r');
      assert.equal(editFor('- [ ] **Phase 6: Also real** - r2')?.to, '- [ ] **[GSD.02] 02: Also real** - r2');

      const applied = runBracketUpgrade(cwd, ['--apply']);
      assertExited(applied, 0, 'sentinel checklist bullet apply');
      const analyzed = JSON.parse(runNode(
        [TOOLS_PATH, 'roadmap', 'analyze'],
        { cwd, env: { ...process.env, ...helpers.TEST_ENV_BASE, HOME: cwd }, timeoutMs: COMMAND_TIMEOUT_MS },
      ).stdout);
      assert.deepEqual(analyzed.phases.map((p) => p.number).sort(), ['01', '02']);
      assert.equal(analyzed.missing_phase_details, null);
    });
  });

  // #4144 round 8 W1: a sentinel bullet with no matching sentinel heading
  // anywhere (an icebox/backlog to-do jotted down before its own
  // `### Phase 999.x:`/`### Phase 0.x:` heading exists) has no converted
  // phase to resolve to. Round 7 B1's rewired sentinel lookup fell through
  // to the Tier-1 partial-conversion refusal in that case, blocking the
  // whole migration — but `roadmap analyze`'s own missing_phase_details scan
  // deliberately excludes sentinel checklist entries (roadmap.cts:795-798),
  // so nothing a reader would call "missing" is being left behind.
  describe('leaves a headingless sentinel bullet untouched instead of refusing (#4144 round 8 W1)', () => {
    test('a bold sentinel bullet with no heading, inside a real section, migrates untouched', () => {
      const cwd = materializeEmptyFixture('sentinel-no-heading-in-section');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '- [ ] **Phase 1: Alpha**',
          '- [ ] **Phase 999.1: Someday idea**',
          '',
          '### Phase 1: Alpha',
          '**Goal**: a',
          '',
        ].join('\n'),
        'utf8',
      );
      fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-alpha'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, '.planning', 'phases', '01-alpha', '01-01-PLAN.md'),
        '---\nphase: "01"\n---\n# alpha plan\n',
        'utf8',
      );

      const plan = parseDryRun(runBracketUpgrade(cwd), 'headingless sentinel bullet in section dry-run');

      assert.equal(
        plan.roadmapEdits.some(({ from }) => from === '- [ ] **Phase 999.1: Someday idea**'),
        false,
        'no sentinel heading exists to resolve to — left untouched, not refused',
      );
      assert.equal(plan.roadmapEdits.find(({ from }) => from === '- [ ] **Phase 1: Alpha**')?.to, '- [ ] **[GSD.01] 01: Alpha**');

      const applied = runBracketUpgrade(cwd, ['--apply']);
      assertExited(applied, 0, 'headingless sentinel bullet in section apply');
      const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.match(roadmap, /- \[ \] \*\*Phase 999\.1: Someday idea\*\*/, 'the headingless sentinel bullet stays byte-identical');
    });

    test('the same headingless sentinel bullet in a global list before any section also migrates untouched', () => {
      const cwd = materializeEmptyFixture('sentinel-no-heading-global');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## Phases',
          '',
          '- [ ] **Phase 1: Alpha**',
          '- [ ] **Phase 999.1: Someday idea**',
          '',
          '## v1.0 Core',
          '',
          '### Phase 1: Alpha',
          '**Goal**: a',
          '',
        ].join('\n'),
        'utf8',
      );
      fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-alpha'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, '.planning', 'phases', '01-alpha', '01-01-PLAN.md'),
        '---\nphase: "01"\n---\n# alpha plan\n',
        'utf8',
      );

      const plan = parseDryRun(runBracketUpgrade(cwd), 'headingless sentinel bullet global dry-run');

      assert.equal(
        plan.roadmapEdits.some(({ from }) => from === '- [ ] **Phase 999.1: Someday idea**'),
        false,
        'no sentinel heading exists to resolve to — left untouched, not refused',
      );

      const applied = runBracketUpgrade(cwd, ['--apply']);
      assertExited(applied, 0, 'headingless sentinel bullet global apply');
      const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.match(roadmap, /- \[ \] \*\*Phase 999\.1: Someday idea\*\*/, 'the headingless sentinel bullet stays byte-identical');
    });
  });

  // #4144 round 6 B2: two milestone sections sharing the same leading major
  // integer (`## v2.0`, `## v2.1` — both resolve to bracket milestone 2) each
  // restart their own legacy phase numbering. Headings resolve correctly
  // (idMapping is keyed by lineIndex), but the checklist lookup used to be
  // keyed by (milestoneInt, legacy token) alone, so the SECOND section's
  // token silently overwrote the FIRST section's in that shared map.
  describe('attributes checklist bullets to their own milestone section (#4144 round 6 B2)', () => {
    function buildSameMajorFixture() {
      const cwd = materializeEmptyFixture('samemajor');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v2.0 Core',
          '',
          '- [ ] **Phase 1: Alpha**',
          '- [ ] **Phase 2: Beta**',
          '',
          '### Phase 1: Alpha',
          '**Goal**: a',
          '',
          '### Phase 2: Beta',
          '**Goal**: b',
          '',
          '## v2.1 Patch',
          '',
          '- [ ] **Phase 1: Gamma**',
          '- [ ] **Phase 2: Delta**',
          '',
          '### Phase 1: Gamma',
          '**Goal**: g',
          '',
          '### Phase 2: Delta',
          '**Goal**: d',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const dir of ['01-alpha', '02-beta', '01-gamma', '02-delta']) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
        fs.writeFileSync(path.join(phasesDir, dir, '01-01-PLAN.md'), '---\nphase: "01"\n---\n', 'utf8');
      }
      return cwd;
    }

    test('each section\'s own checklist bullets convert to that section\'s own tokens, not the later section\'s', () => {
      const cwd = buildSameMajorFixture();
      const plan = parseDryRun(runBracketUpgrade(cwd), 'same-major-milestones dry-run');

      const editFor = (text) => plan.roadmapEdits.find(({ from }) => from === text);

      assert.equal(editFor('- [ ] **Phase 1: Alpha**')?.to, '- [ ] **[GSD.02] 01: Alpha**');
      assert.equal(editFor('- [ ] **Phase 2: Beta**')?.to, '- [ ] **[GSD.02] 02: Beta**');
      assert.equal(editFor('- [ ] **Phase 1: Gamma**')?.to, '- [ ] **[GSD.02] 03: Gamma**');
      assert.equal(editFor('- [ ] **Phase 2: Delta**')?.to, '- [ ] **[GSD.02] 04: Delta**');
    });

    test('a checklist bullet outside every section naming an ambiguous legacy token is refused before any write', () => {
      const cwd = buildSameMajorFixture();
      const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        `# Roadmap\n\n- [ ] **Phase 1: Somebody**\n\n${roadmap.slice('# Roadmap\n\n'.length)}`,
        'utf8',
      );
      const before = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd);

      assertExited(result, 1, 'ambiguous global checklist bullet dry-run');
      assert.match(result.stderr, /ambiguous|more than one/i);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'a refusal must write nothing');
    });
  });

  // #4144 round 7 B2: the READERS' own checklist grammar
  // (`src/roadmap.cts:770` checklistPattern — the exact scan
  // `missing_phase_details` is computed from) requires an EXACT bold `**`
  // immediately before the `Phase` label. This migrator's own long-standing
  // tolerance additionally accepts 0 or 1 asterisks — a plain, non-bold
  // `- [x] Phase 3: Gamma` has converted since round 1 and must keep doing
  // so. Round 6 dropped the checklist regex's colon requirement (B4) AND
  // turned an unresolved bullet into a hard refusal, so a non-bold to-do
  // bullet naming a phase number no heading defines (e.g.
  // `- [ ] Phase 2 retrospective write-up`, where no "Phase 2" heading
  // exists anywhere) now refuses the whole migration even though NO reader
  // treats a non-bold bullet as a phase reference (roadmap.cts:770 requires
  // bold, roadmap-parser.cts:1446 requires `**Phase`, phase.cts's checkbox
  // branch requires a separator). Two tiers: Tier 1 (the readers' own
  // grammar — an EXACT `**` bold intro) converts when it resolves, refuses
  // when it does not (the partial-conversion rule, unchanged). Tier 2 (this
  // migrator's own wider, non-bold tolerance) converts when it resolves
  // (e.g. `- [ ] Phase 1 demo video`, a plain to-do naming a real "Phase 1"
  // heading in its own enclosing section — `## Notes` is not itself a
  // `## vN.M` heading, so it never ends the enclosing milestone section;
  // `milestoneSections` only ever breaks a section at the next versioned
  // heading), otherwise stays byte-identical — never refused, and (per the
  // OUTSIDE-every-section ambiguity search a few lines below) never
  // resolved by guessing across sections the way Tier 1 alone may.
  describe('refuses only checklist bullets the readers\' own grammar recognizes as phase references (#4144 round 7 B2)', () => {
    function buildNonBoldFixture() {
      const cwd = materializeEmptyFixture('nonbold-checklist');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '- [ ] **Phase 1: Alpha** - a',
          '',
          '### Phase 1: Alpha',
          '**Goal**: a',
          '',
          '## Notes',
          '',
          '- [ ] Phase 2 retrospective write-up',
          '- [ ] Phase 1 demo video',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      fs.mkdirSync(path.join(phasesDir, '01-alpha'), { recursive: true });
      fs.writeFileSync(path.join(phasesDir, '01-alpha', '01-01-PLAN.md'), '---\nphase: "01"\n---\n', 'utf8');
      return cwd;
    }

    test('a non-bold to-do bullet naming an unresolvable phase number stays byte-identical; a resolvable one still converts', () => {
      const cwd = buildNonBoldFixture();
      const plan = parseDryRun(runBracketUpgrade(cwd), 'non-bold checklist dry-run');

      assert.equal(
        plan.roadmapEdits.some(({ from }) => from === '- [ ] Phase 2 retrospective write-up'),
        false,
        'no heading defines "Phase 2" anywhere — left untouched, not refused',
      );
      assert.equal(
        plan.roadmapEdits.find(({ from }) => from === '- [ ] Phase 1 demo video')?.to,
        '- [ ] [GSD.01] 01 demo video',
        'a non-bold bullet that DOES resolve (a real "Phase 1" heading in its own section) still converts',
      );
      assert.ok(plan.roadmapEdits.some(({ from }) => from === '- [ ] **Phase 1: Alpha** - a'), 'the bold bullet still converts');

      const applied = runBracketUpgrade(cwd, ['--apply']);
      assertExited(applied, 0, 'non-bold checklist apply');
      const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.match(roadmap, /- \[ \] Phase 2 retrospective write-up/);
      assert.match(roadmap, /- \[ \] \[GSD\.01\] 01 demo video/);
      assert.match(roadmap, /- \[ \] \*\*\[GSD\.01\] 01: Alpha\*\* - a/);
    });

    test('a bold to-do bullet naming an unresolvable phase number still refuses before any write', () => {
      const cwd = materializeEmptyFixture('bold-unresolvable-checklist');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '- [ ] **Phase 1: Alpha** - a',
          '',
          '### Phase 1: Alpha',
          '**Goal**: a',
          '',
          '## Notes',
          '',
          '- [ ] **Phase 2** retrospective write-up',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      fs.mkdirSync(path.join(phasesDir, '01-alpha'), { recursive: true });
      fs.writeFileSync(path.join(phasesDir, '01-alpha', '01-01-PLAN.md'), '---\nphase: "01"\n---\n', 'utf8');
      const before = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd);

      assertExited(result, 1, 'bold unresolvable checklist bullet dry-run');
      assert.match(result.stderr, /recognize as a phase reference/i);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'a refusal must write nothing');
    });

    // #4144 round 8 B2: a non-bold bullet genuinely OUTSIDE every section
    // (before the first `## vN.M` heading, not merely under a non-versioned
    // `## Notes` sub-heading inside one) must still resolve when its legacy
    // token is unambiguous across sections — round 7 gated this lookup on
    // the bold prefix and left it unresolved, a silent partial conversion.
    test('a non-bold to-do bullet in a global summary list resolves against the unique section that defines its token', () => {
      const cwd = materializeEmptyFixture('global-nonbold-unique');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## Phases',
          '',
          '- [x] Phase 1: Alpha',
          '- [ ] Phase 2: Beta',
          '',
          '## v1.0 Core',
          '',
          '### Phase 1: Alpha',
          '**Goal**: a',
          '',
          '## v2.0 Scale',
          '',
          '### Phase 2: Beta',
          '**Goal**: b',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      fs.mkdirSync(path.join(phasesDir, '01-alpha'), { recursive: true });
      fs.mkdirSync(path.join(phasesDir, '02-beta'), { recursive: true });

      const plan = parseDryRun(runBracketUpgrade(cwd), 'global non-bold unique dry-run');

      assert.equal(
        plan.roadmapEdits.find(({ from }) => from === '- [x] Phase 1: Alpha')?.to,
        '- [x] [GSD.01] 01: Alpha',
        'the global non-bold bullet must resolve to the one section defining "Phase 1"',
      );
      assert.equal(
        plan.roadmapEdits.find(({ from }) => from === '- [ ] Phase 2: Beta')?.to,
        '- [ ] [GSD.02] 01: Beta',
        'the global non-bold bullet must resolve to the one section defining "Phase 2"',
      );

      const applied = runBracketUpgrade(cwd, ['--apply']);
      assertExited(applied, 0, 'global non-bold unique apply');
      const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.doesNotMatch(roadmap, /Phase 1: Alpha\n/, 'no leftover legacy-token bullet may remain');
      assert.doesNotMatch(roadmap, /Phase 2: Beta\n/, 'no leftover legacy-token bullet may remain');
    });
  });

  // #4144 round 6 B3: the same legacy phase NUMBER in two different sections
  // (the exact ambiguity M-NN exists to resolve) is claimed by directories in
  // LISTING order, because `matchBracketSourceDir`'s legacy branch matches
  // purely on the numeric token — it has no idea which milestone a directory
  // belongs to. A directory can therefore be silently renamed into a
  // DIFFERENT phase's identity.
  describe('resolves duplicate legacy numbers by slug and refuses ambiguity (#4144 round 6 B3)', () => {
    function buildDirOrderFixture() {
      const cwd = materializeEmptyFixture('dirorder');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '### Phase 1: Zeta',
          '**Goal**: z',
          '',
          '## v2.0 Scale',
          '',
          '### Phase 1: Gamma',
          '**Goal**: g',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const [dir, note] of [['01-zeta', 'zeta plan'], ['01-gamma', 'gamma plan']]) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
        fs.writeFileSync(path.join(phasesDir, dir, '01-01-PLAN.md'), `---\nphase: "01"\n---\n# ${note}\n`, 'utf8');
      }
      return cwd;
    }

    test('each directory maps to the phase its own slug names, never a directory-listing-order guess', () => {
      const cwd = buildDirOrderFixture();
      const plan = parseDryRun(runBracketUpgrade(cwd), 'dir-order dry-run');

      assert.deepEqual(
        plan.phases
          .map(({ oldDir, newDir }) => ({ oldDir, newDir }))
          .sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        [
          { oldDir: '01-gamma', newDir: 'GSD.02-01-gamma' },
          { oldDir: '01-zeta', newDir: 'GSD.01-01-zeta' },
        ],
        'Gamma (v2.0) must keep its own identity; Zeta (v1.0) must keep its own — never swapped',
      );
    });

    test('the same directory-listing order still resolves correctly when directories are visited in the opposite order', () => {
      const cwd = buildDirOrderFixture();
      const phasesDir = path.join(cwd, '.planning', 'phases');
      const real = fs.readdirSync;
      const dirMock = mock.method(fs, 'readdirSync', (dir, opts) => {
        if (dir === phasesDir) {
          const entries = real.call(fs, dir, opts);
          return [...entries].reverse();
        }
        return real.call(fs, dir, opts);
      });
      try {
        const { computeMigrationPlan: computePlanDirect } = require('../gsd-core/bin/lib/roadmap-upgrade.cjs');
        const plan = computePlanDirect(cwd, { convention: 'bracket' });
        assert.deepEqual(
          plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })).sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
          [
            { oldDir: '01-gamma', newDir: 'GSD.02-01-gamma' },
            { oldDir: '01-zeta', newDir: 'GSD.01-01-zeta' },
          ],
        );
      } finally {
        dirMock.mock.restore();
      }
    });

    test('the same legacy token twice under one milestone is a duplicate identity, refused before any write', () => {
      const cwd = materializeEmptyFixture('dirorder-dup');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        '# R\n\n## v1.0\n\n## Phase 1: Alpha\n\n### Phase 1: Alpha\n\n### Phase 2: Beta\n',
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      fs.mkdirSync(path.join(phasesDir, '01-alpha'), { recursive: true });
      fs.writeFileSync(path.join(phasesDir, '01-alpha', '01-01-PLAN.md'), '---\nphase: "01"\n---\n', 'utf8');
      fs.mkdirSync(path.join(phasesDir, '02-beta'), { recursive: true });
      fs.writeFileSync(path.join(phasesDir, '02-beta', '02-01-PLAN.md'), '---\nphase: "02"\n---\n', 'utf8');
      const before = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd);

      assertExited(result, 1, 'duplicate legacy token dry-run');
      assert.match(result.stderr, /more than once|duplicate/i);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'a refusal must write nothing');
    });
  });

  // #4144 round 8 W2: in a BALANCED tie group (dirs === candidates), the
  // resolution loop's "single remaining candidate" shortcut accepted
  // whichever directory is visited LAST without ever checking its slug —
  // fine when every directory in the group is a genuine phase directory,
  // wrong when a STALE duplicate-number directory (a leftover copy of one
  // real phase's directory) is among them: the real directory claims its
  // own phase by slug first, and the stale leftover is then handed the
  // OTHER phase by elimination alone, though its own slug names neither.
  describe('refuses a stale duplicate-number directory instead of assigning it by elimination (#4144 round 8 W2)', () => {
    test('a stale copy of one phase\'s directory is refused rather than silently claiming the other phase', () => {
      const cwd = materializeEmptyFixture('balanced-stale-dup');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '### Phase 1: Alpha',
          '**Goal**: a',
          '',
          '## v2.0 Scale',
          '',
          '### Phase 1: Beta',
          '**Goal**: b',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const dir of ['01-alpha', '01-alpha-old']) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
        fs.writeFileSync(path.join(phasesDir, dir, '01-01-PLAN.md'), '---\nphase: "01"\n---\n# plan\n', 'utf8');
      }
      const before = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd);

      assertExited(result, 1, 'stale duplicate-number directory dry-run');
      assert.match(result.stderr, /01-alpha-old/, 'the refusal must name the stale directory');
      assert.doesNotMatch(result.stderr, /GSD\.02-01-alpha-old/, 'the stale directory must never be silently assigned Beta\'s identity');
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'a refusal must write nothing');
    });
  });

  // #4144 round 8 I1: Tier 2 (non-bold) checklist matching had no token
  // boundary requirement after the phase number at all, so prose that
  // merely STARTS WITH a phase number and continues as a hyphenated
  // compound word converted too — `- [ ] Phase 1-on-1 meetings` became
  // `- [ ] [GSD.01] 01-on-1 meetings`. Mirrors phase.cts:4358-4361's
  // checkbox-branch separator (colon/em-dash/en-dash/hyphen, the same
  // family BULLET_PHASE_LINE_PATTERN already accepts) plus the ordinary
  // "whitespace before a plain word" case a bare to-do bullet needs, rather
  // than inventing a fourth grammar.
  describe('requires a token boundary before renumbering a non-bold bullet (#4144 round 8 I1)', () => {
    function buildTier2BoundaryFixture() {
      const cwd = materializeEmptyFixture('tier2-boundary');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '- [ ] **Phase 1: Alpha**',
          '- [ ] **Phase 2: Beta**',
          '',
          '### Phase 1: Alpha',
          '### Phase 2: Beta',
          '',
          '## Notes',
          '',
          '- [ ] Phase 2 retrospective',
          '- [ ] Phase 1 demo video',
          '- [ ] Ask Phase 3 owner',
          '- [ ] Phase 3 kickoff (no such phase)',
          '- [ ] Phase 1-on-1 meetings',
          '- [ ] Phase 10 planning',
          '- [ ] Phase 2: write the retro doc',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      fs.mkdirSync(path.join(phasesDir, '01-alpha'), { recursive: true });
      fs.mkdirSync(path.join(phasesDir, '02-beta'), { recursive: true });
      return cwd;
    }

    test('a hyphenated compound word right after the number is left byte-identical; ordinary prose still converts', () => {
      const cwd = buildTier2BoundaryFixture();
      const plan = parseDryRun(runBracketUpgrade(cwd), 'Tier 2 token boundary dry-run');
      const editFor = (text) => plan.roadmapEdits.find(({ from }) => from === text);

      assert.equal(
        plan.roadmapEdits.some(({ from }) => from === '- [ ] Phase 1-on-1 meetings'),
        false,
        'the number is glued directly onto a hyphenated word — no token boundary, left byte-identical',
      );
      assert.equal(
        plan.roadmapEdits.some(({ from }) => from === '- [ ] Ask Phase 3 owner'),
        false,
        'not anchored at the bullet start — never matched at all',
      );
      assert.equal(
        plan.roadmapEdits.some(({ from }) => from === '- [ ] Phase 3 kickoff (no such phase)'),
        false,
        'no "Phase 3" heading exists in this section — unresolved, left byte-identical',
      );
      assert.equal(
        plan.roadmapEdits.some(({ from }) => from === '- [ ] Phase 10 planning'),
        false,
        'no "Phase 10" heading exists anywhere — unresolved, left byte-identical',
      );

      assert.equal(editFor('- [ ] Phase 2 retrospective')?.to, '- [ ] [GSD.01] 02 retrospective', 'space then a plain word is a valid boundary');
      assert.equal(editFor('- [ ] Phase 1 demo video')?.to, '- [ ] [GSD.01] 01 demo video', 'space then a plain word is a valid boundary');
      assert.equal(editFor('- [ ] Phase 2: write the retro doc')?.to, '- [ ] [GSD.01] 02: write the retro doc', 'a colon immediately after the number is still a valid boundary');

      const applied = runBracketUpgrade(cwd, ['--apply']);
      assertExited(applied, 0, 'Tier 2 token boundary apply');
      const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.match(roadmap, /- \[ \] Phase 1-on-1 meetings/, 'the hyphenated-compound bullet stays byte-identical on disk');
    });
  });

  // #4144 round 7 W1: the B3 tie-break slugified the heading NAME with
  // `generateSlugInternal(text, null)` — never accounting for the way the
  // HARNESS ITSELF derives a directory's own slug. `phase insert` writes
  // "(INSERTED)" into the heading TEXT but not into the directory it
  // creates (phase.cts's insert path slugifies the bare `description`,
  // which never carries the marker — mirroring how `roadmap.cts:494`
  // strips it before slugifying a heading name for its own comparisons);
  // and `init`/`phase add` truncate at `generateSlugInternal`'s own default
  // maxLen (60), never unlimited (`null`). Comparing under a DIFFERENT rule
  // than the one that created the directory refused two-milestone roadmaps
  // the tooling's own commands produced.
  describe('derives the comparison slug the way the harness derives directory slugs (#4144 round 7 W1)', () => {
    test('an inserted decimal sub-phase\'s "(INSERTED)" heading marker does not block its own directory match', () => {
      const cwd = materializeEmptyFixture('inserted-slug');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '### Phase 2: Beta',
          '### Phase 2.1: Critical Fix (INSERTED)',
          '',
          '## v2.0 Scale',
          '',
          '### Phase 2: Delta',
          '### Phase 2.1: Hot Patch (INSERTED)',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const dir of ['02-beta', '02.1-critical-fix', '02-delta', '02.1-hot-patch']) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
        fs.writeFileSync(path.join(phasesDir, dir, '01-01-PLAN.md'), '---\nphase: "01"\n---\n', 'utf8');
      }

      const plan = parseDryRun(runBracketUpgrade(cwd), 'inserted-marker slug dry-run');

      assert.deepEqual(
        plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })).sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        [
          { oldDir: '02-beta', newDir: 'GSD.01-01-beta' },
          { oldDir: '02-delta', newDir: 'GSD.02-01-delta' },
          { oldDir: '02.1-critical-fix', newDir: 'GSD.01-02-critical-fix' },
          { oldDir: '02.1-hot-patch', newDir: 'GSD.02-02-hot-patch' },
        ].sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        'Critical Fix (v1.0) must keep its own identity; Hot Patch (v2.0) must keep its own — never refused',
      );
    });

    test('a phase name truncated to the creators\' 60-char slug limit still matches its own directory', () => {
      const long = 'A very long phase name that goes on and on and on past sixty characters total';
      const cwd = materializeEmptyFixture('long-slug');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          `### Phase 1: ${long}`,
          '',
          '## v2.0 Scale',
          '',
          '### Phase 1: Other',
          '',
        ].join('\n'),
        'utf8',
      );
      const { generateSlugInternal } = require('../gsd-core/bin/lib/core-utils.cjs');
      const truncatedSlug = generateSlugInternal(long);
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const dir of [`01-${truncatedSlug}`, '01-other']) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
      }

      const plan = parseDryRun(runBracketUpgrade(cwd), 'long-name slug dry-run');

      assert.deepEqual(
        plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })).sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        [
          { oldDir: `01-${truncatedSlug}`, newDir: `GSD.01-01-${truncatedSlug}` },
          { oldDir: '01-other', newDir: 'GSD.02-01-other' },
        ].sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        'the directory created with the creators\' own 60-char-truncated slug must still resolve',
      );
    });
  });

  // #4144 round 7 W2: a stale duplicate-number directory sorting between two
  // REAL ones claims whichever candidate is still unused by the time it is
  // visited, and the real directory for that candidate is then silently
  // dropped from the plan. `01-gamma`, `01-gamma-old`, `01-zeta` (Zeta in
  // v1.0, Gamma in v2.0, both legacy token "1") is the exact repro: 01-gamma
  // resolves to Gamma by slug; only Zeta is left "unused" by the time
  // 01-gamma-old is visited, so it claims Zeta's identity WITHOUT its own
  // slug agreeing (bySlug is skipped entirely when only one candidate
  // remains) — and 01-zeta itself is left with no candidate at all.
  describe('refuses when duplicate-number directories leave a phase unclaimed (#4144 round 7 W2)', () => {
    test('a stale leftover directory sharing a legacy number with two real ones is refused, not silently dropped', () => {
      const cwd = materializeEmptyFixture('leftover-dup');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '### Phase 1: Zeta',
          '**Goal**: z',
          '',
          '## v2.0 Scale',
          '',
          '### Phase 1: Gamma',
          '**Goal**: g',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const [dir, note] of [['01-gamma', 'gamma plan'], ['01-gamma-old', 'stale gamma plan'], ['01-zeta', 'zeta plan']]) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
        fs.writeFileSync(path.join(phasesDir, dir, '01-01-PLAN.md'), `---\nphase: "01"\n---\n# ${note}\n`, 'utf8');
      }
      const before = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd);

      assertExited(result, 1, 'leftover duplicate-number directory dry-run');
      assert.match(result.stderr, /01-gamma-old/, 'the refusal must name the directory that cannot resolve its own slug');
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'a refusal must write nothing — 01-zeta must never be silently dropped');

      const apply = runBracketUpgrade(cwd, ['--apply']);
      assertExited(apply, 1, 'leftover duplicate-number directory apply');
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'apply refusal must also write nothing');
    });

    test('the same two-candidate, two-directory shape still resolves cleanly (no leftover) — round 6 B3 regression guard', () => {
      const cwd = materializeEmptyFixture('dirorder-regression');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '### Phase 1: Zeta',
          '**Goal**: z',
          '',
          '## v2.0 Scale',
          '',
          '### Phase 1: Gamma',
          '**Goal**: g',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const [dir, note] of [['01-zeta', 'zeta plan'], ['01-gamma', 'gamma plan']]) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
        fs.writeFileSync(path.join(phasesDir, dir, '01-01-PLAN.md'), `---\nphase: "01"\n---\n# ${note}\n`, 'utf8');
      }

      const plan = parseDryRun(runBracketUpgrade(cwd), 'two-candidate dir-order dry-run');

      assert.deepEqual(
        plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })).sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        [
          { oldDir: '01-gamma', newDir: 'GSD.02-01-gamma' },
          { oldDir: '01-zeta', newDir: 'GSD.01-01-zeta' },
        ],
        'Gamma (v2.0) must keep its own identity; Zeta (v1.0) must keep its own — never swapped, never dropped',
      );
    });
  });

  // #4144 round 8 B1: the round-7 W2 pre-check above refused a tie group
  // whenever `dirs.length !== mappingLines.length`, which also caught the far
  // more common shape where a tie group has FEWER directories than
  // candidates — a later milestone that reuses a legacy number but is only
  // planned (no directory yet), an archived `<details>` milestone whose
  // directory was cleaned up, or a decimal insert whose sibling has no
  // directory. The depletion loop only ever drops a directory silently when a
  // tie group has MORE directories than candidates (a directory visited with
  // no unused candidate left just `continue`s); with fewer directories every
  // directory is either resolved by slug or refused loudly on its own, so the
  // safe pre-check condition is `dirs > candidates`, never `!==`.
  describe('resolves a tie group with fewer directories than candidates by slug (#4144 round 8 B1)', () => {
    test('a legacy number shared by a started and an unstarted milestone resolves the started one by slug', () => {
      const cwd = materializeEmptyFixture('fewer-dirs-unstarted');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '- [x] **Phase 1: Alpha**',
          '',
          '### Phase 1: Alpha',
          '**Goal**: a',
          '',
          '## v2.0 Scale',
          '',
          '- [ ] **Phase 1: Beta**',
          '',
          '### Phase 1: Beta',
          '**Goal**: b',
          '',
        ].join('\n'),
        'utf8',
      );
      fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-alpha'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, '.planning', 'phases', '01-alpha', '01-01-PLAN.md'),
        '---\nphase: "01"\n---\n# alpha plan\n',
        'utf8',
      );

      const plan = parseDryRun(runBracketUpgrade(cwd), 'fewer-dirs-than-candidates dry-run');

      assert.deepEqual(
        plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })),
        [{ oldDir: '01-alpha', newDir: 'GSD.01-01-alpha' }],
        'the only directory must resolve to the milestone whose slug it actually matches',
      );
      assert.ok(
        plan.roadmapEdits.some(({ to }) => to === '### [GSD.02] 01: Beta'),
        'the unstarted milestone\'s heading must still convert even with no directory of its own',
      );
    });

    test('an archived milestone whose directory was cleaned up leaves the live milestone resolvable by slug', () => {
      const cwd = materializeEmptyFixture('fewer-dirs-archived');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '<details>',
          '<summary>✅ v1.0 MVP (Phases 1-2) — SHIPPED 2026-01-01</summary>',
          '',
          '### Phase 1: Foundation',
          '**Goal**: f',
          '',
          '### Phase 2: Auth',
          '**Goal**: a',
          '',
          '</details>',
          '',
          '## v2.0 Scale',
          '',
          '- [ ] **Phase 1: Beta**',
          '',
          '### Phase 1: Beta',
          '**Goal**: b',
          '',
        ].join('\n'),
        'utf8',
      );
      fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-beta'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, '.planning', 'phases', '01-beta', '01-01-PLAN.md'),
        '---\nphase: "01"\n---\n# beta plan\n',
        'utf8',
      );

      const plan = parseDryRun(runBracketUpgrade(cwd), 'archived-milestone-cleaned-dir dry-run');

      assert.deepEqual(
        plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })),
        [{ oldDir: '01-beta', newDir: 'GSD.02-01-beta' }],
        'the live milestone\'s directory must resolve by slug rather than being refused for a cardinality mismatch',
      );
    });

    test('a decimal insert whose sibling milestone has no directory resolves the existing one by slug', () => {
      const cwd = materializeEmptyFixture('fewer-dirs-decimal');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '### Phase 2: Alpha',
          '### Phase 2.1: Fix (INSERTED)',
          '',
          '## v2.0 Scale',
          '',
          '### Phase 2: Beta',
          '### Phase 2.1: Patch (INSERTED)',
          '',
        ].join('\n'),
        'utf8',
      );
      fs.mkdirSync(path.join(cwd, '.planning', 'phases', '02-alpha'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, '.planning', 'phases', '02-alpha', '02-01-PLAN.md'),
        '---\nphase: "02"\n---\n# alpha plan\n',
        'utf8',
      );
      fs.mkdirSync(path.join(cwd, '.planning', 'phases', '02-beta'), { recursive: true });
      fs.mkdirSync(path.join(cwd, '.planning', 'phases', '02.1-fix'), { recursive: true });

      const plan = parseDryRun(runBracketUpgrade(cwd), 'decimal-insert-no-sibling-dir dry-run');

      assert.deepEqual(
        plan.phases.map(({ oldDir, newDir }) => ({ oldDir, newDir })).sort((a, b) => a.oldDir.localeCompare(b.oldDir)),
        [
          { oldDir: '02-alpha', newDir: 'GSD.01-01-alpha' },
          { oldDir: '02-beta', newDir: 'GSD.02-01-beta' },
          { oldDir: '02.1-fix', newDir: 'GSD.01-02-fix' },
        ],
        '02.1-fix must resolve to Fix (its own slug, milestone 1) even though Patch (v2.0) has no directory at all',
      );
    });
  });

  // #4144 round 6 B4: the READERS' own checklist grammar
  // (`src/roadmap.cts:770`, `missing_phase_details`) requires a bold `**`
  // before the `Phase` label but no colon anywhere after the token — a
  // bullet like `- [ ] **Phase 7** - Eta work` is a real phase reference to
  // it. The migrator's own checklist regex required a colon immediately
  // after the token, so such bullets survived byte-identical while their
  // headings converted, and `roadmap analyze` reported them missing after a
  // "done" migration.
  describe("converts every checklist bullet the reader's grammar accepts (#4144 round 6 B4)", () => {
    function buildChecklistShapesFixture() {
      const cwd = materializeEmptyFixture('checklistshapes');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v2.0 Scale',
          '',
          '- [ ] **Phase 7** - Eta work',
          '- [x] **Phase 8**: Theta',
          '- [ ] **Phase 9 (Cluster B)** - Iota',
          '',
          '### Phase 7: Eta',
          '**Goal**: h',
          '',
          '### Phase 8: Theta',
          '**Goal**: t',
          '',
          '### Phase 9 (Cluster B): Iota',
          '**Goal**: i',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      fs.mkdirSync(path.join(phasesDir, '07-eta'), { recursive: true });
      fs.writeFileSync(path.join(phasesDir, '07-eta', '07-01-PLAN.md'), '---\nphase: "07"\n---\n', 'utf8');
      return cwd;
    }

    test('bold checklist bullets with no colon after the token still convert, preserving what follows', () => {
      const cwd = buildChecklistShapesFixture();
      const before = JSON.parse(runNode(
        [TOOLS_PATH, 'roadmap', 'analyze'],
        { cwd, env: { ...process.env, ...helpers.TEST_ENV_BASE, HOME: cwd }, timeoutMs: COMMAND_TIMEOUT_MS },
      ).stdout);
      assert.equal(before.missing_phase_details, null, 'the reader must not report any missing detail before migration');

      const plan = parseDryRun(runBracketUpgrade(cwd), 'checklist-shapes dry-run');
      const editFor = (text) => plan.roadmapEdits.find(({ from }) => from === text);
      assert.equal(editFor('- [ ] **Phase 7** - Eta work')?.to, '- [ ] **[GSD.02] 01** - Eta work');
      assert.equal(editFor('- [x] **Phase 8**: Theta')?.to, '- [x] **[GSD.02] 02**: Theta');
      assert.equal(
        editFor('- [ ] **Phase 9 (Cluster B)** - Iota')?.to,
        '- [ ] **[GSD.02] 03 (Cluster B)** - Iota',
      );

      const applied = runBracketUpgrade(cwd, ['--apply']);
      assertExited(applied, 0, 'checklist-shapes apply');
      const after = JSON.parse(runNode(
        [TOOLS_PATH, 'roadmap', 'analyze'],
        { cwd, env: { ...process.env, ...helpers.TEST_ENV_BASE, HOME: cwd }, timeoutMs: COMMAND_TIMEOUT_MS },
      ).stdout);
      assert.equal(
        after.missing_phase_details,
        null,
        'a "done" migration must never leave a reader-recognized checklist bullet unconverted',
      );
    });

    test('a colon-form checklist bullet still converts (no regression)', () => {
      const cwd = materializeFixture('legacy-multi-milestone');
      const plan = parseDryRun(runBracketUpgrade(cwd), 'legacy-multi-milestone dry-run');
      assert.ok(plan.roadmapEdits.some(({ from, to }) => from === '- [ ] **Phase 1:** Alpha' && to === '- [ ] **[GSD.01] 01:** Alpha'));
    });
  });

  // #4144 round 6 (W-CRLF): on a CRLF ROADMAP.md, every converted HEADING
  // line lost its trailing `\r` (checklist bullets kept theirs, since their
  // rewrite slices the line's own remainder instead of reassembling
  // captured regex groups), leaving a mixed-EOL file despite
  // applyRoadmapEdits' own "preserve every terminator" contract.
  describe('preserves CRLF line terminators on converted headings (#4144 round 6 W-CRLF)', () => {
    test('every line stays CRLF after apply, including converted headings', () => {
      const cwd = materializeEmptyFixture('crlf');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      const roadmap = [
        '# Roadmap',
        '',
        '## v1.0 Core',
        '',
        '### Phase 1: Alpha',
        '**Goal**: a',
        '',
        '### Phase 2.1 (Cluster B): Beta',
        '**Goal**: b',
        '',
        '### Phase 3: Gamma',
        '**Goal**: g',
        '',
      ].join('\r\n');
      fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), roadmap, 'utf8');
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const dir of ['01-alpha', '02.1-beta', '03-gamma']) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
        fs.writeFileSync(path.join(phasesDir, dir, '01-01-PLAN.md'), '---\nphase: "01"\n---\n', 'utf8');
      }

      const result = runBracketUpgrade(cwd, ['--apply']);
      assertExited(result, 0, 'CRLF apply');

      const after = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.equal(
        after.replace(/\r\n/g, '').includes('\n'),
        false,
        'no line terminator may be a bare LF — every terminator must be a full CRLF pair',
      );
      assert.match(after, /### \[GSD\.01\] 01: Alpha\r\n/);
      assert.match(after, /### \[GSD\.01\] 02 \(Cluster B\): Beta\r\n/);
      assert.match(after, /### \[GSD\.01\] 03: Gamma\r\n/);
    });
  });

  // #4144 round 6 (W-collision): the plan never checked that a target
  // directory name was free — dry-run reported a clean plan `apply` could
  // not perform (non-empty target: ENOTEMPTY mid-apply, rollback restores)
  // or silently replaced (empty target: POSIX rename semantics).
  describe('refuses target directory collisions at plan time (#4144 round 6 W-collision)', () => {
    function buildCollisionFixture(preExisting) {
      const cwd = materializeEmptyFixture('collision');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        '# Roadmap\n\n## v1.0 Core\n\n### Phase 1: Alpha\n\n### Phase 2: Beta\n',
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const dir of ['01-alpha', '02-beta']) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
        fs.writeFileSync(path.join(phasesDir, dir, '01-01-PLAN.md'), '---\nphase: "01"\n---\n', 'utf8');
      }
      fs.mkdirSync(path.join(phasesDir, 'GSD.01-02-beta'), { recursive: true });
      preExisting(path.join(phasesDir, 'GSD.01-02-beta'));
      return cwd;
    }

    test('a pre-existing NON-EMPTY target directory refuses at dry-run, nothing written', () => {
      const cwd = buildCollisionFixture((dir) => fs.writeFileSync(path.join(dir, 'STALE.md'), 'stale\n', 'utf8'));
      const before = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd);

      assertExited(result, 1, 'non-empty target collision dry-run');
      assert.match(result.stderr, /GSD\.01-02-beta/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'a refusal must write nothing');
    });

    test('a pre-existing EMPTY target directory also refuses at dry-run, never silently replaced', () => {
      const cwd = buildCollisionFixture(() => {});
      const before = snapshotTree(cwd, { skipGit: true });

      const result = runBracketUpgrade(cwd);

      assertExited(result, 1, 'empty target collision dry-run');
      assert.match(result.stderr, /GSD\.01-02-beta/);
      assert.deepEqual(snapshotTree(cwd, { skipGit: true }), before, 'a refusal must write nothing, even for an empty target');
    });
  });

  // #4144 round 6 (W-collision follow-up, coordinator-directed): repurposing
  // 'a mid-migration rename failure restores an ignored planning tree
  // byte-for-byte' into the plan-time collision test above removed the
  // repo's only rollback proof for a failure in the MIDDLE of the
  // directory-rename list — the occupied-target injection that test used is
  // now refused at PLAN time (W-collision), so it can no longer reach
  // applyMigration's mid-rename rollback path at all. This restores that
  // coverage with a different injection: fs.renameSync itself, mocked by
  // exact destination path (the same "resolve the real path, compare, call
  // through otherwise" style the writeFileSync mocks elsewhere in this file
  // use), on a fixture with three phase directories where the FIRST one's
  // rename, artifact renames, AND depends_on/phase rewrites all complete for
  // real before the SECOND directory's own rename throws.
  describe('rolls back a failure partway through the directory renames (#4144 round 6, coordinator follow-up)', () => {
    test('a failure on the second of three directory renames rolls back the first rename, its artifacts, and its content rewrites', (t) => {
      const cwd = materializeEmptyFixture('midrename');
      const planningPath = path.join(cwd, '.planning');
      const configPath = path.join(planningPath, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(planningPath, 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '### Phase 1.5: Alpha',
          '### Phase 2: Middle',
          '### Phase 3: Beta',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(planningPath, 'phases');
      // Alpha's on-disk token ("01.5") differs from its assigned bracket
      // token ("01" — the decimal flattens into the milestone's counter),
      // so its OWN directory rename, BOTH its plan files' artifact renames,
      // AND its depends_on rewrite all really happen on disk before Middle
      // (the second directory) ever gets touched.
      fs.mkdirSync(path.join(phasesDir, '01.5-alpha'), { recursive: true });
      fs.writeFileSync(
        path.join(phasesDir, '01.5-alpha', '01.5-01-PLAN.md'),
        '---\nphase: "01.5"\nplan: "01"\ndepends_on: []\n---\n\nAlpha first plan.\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(phasesDir, '01.5-alpha', '01.5-02-PLAN.md'),
        '---\nphase: "01.5"\nplan: "02"\ndepends_on: ["01.5-01"]\n---\n\nAlpha second plan, depends on the first.\n',
        'utf8',
      );
      // Middle and Beta keep on-disk tokens equal to their assigned bracket
      // tokens ("02"/"03"), so each is a plain directory rename with no
      // artifacts of its own — Middle is the failure point; Beta must never
      // be reached or touched at all.
      fs.mkdirSync(path.join(phasesDir, '02-middle'), { recursive: true });
      fs.writeFileSync(path.join(phasesDir, '02-middle', '02-01-PLAN.md'), '---\nphase: "02"\n---\n\nMiddle plan.\n', 'utf8');
      fs.mkdirSync(path.join(phasesDir, '03-beta'), { recursive: true });
      fs.writeFileSync(path.join(phasesDir, '03-beta', '03-01-PLAN.md'), '---\nphase: "03"\n---\n\nBeta plan.\n', 'utf8');

      const plan = computeMigrationPlan(cwd, { convention: 'bracket' });
      assert.equal(plan.alreadyMigrated, false);
      assert.ok(plan.phases.length >= 3, 'fixture must produce at least three directory renames');
      const alphaEntry = plan.phases.find((p) => p.oldDir === '01.5-alpha');
      const middleEntry = plan.phases.find((p) => p.oldDir === '02-middle');
      const betaEntry = plan.phases.find((p) => p.oldDir === '03-beta');
      assert.ok(alphaEntry && middleEntry && betaEntry, 'fixture must produce all three renames');
      assert.equal(plan.phases[0].oldDir, '01.5-alpha', 'Alpha must be first in rename order');
      assert.equal(plan.phases[1].oldDir, '02-middle', 'Middle must be second in rename order — the failure point');
      assert.ok(alphaEntry.fileRenames.length >= 1, 'Alpha must produce at least one artifact rename to reverse');
      assert.ok(alphaEntry.dependsOnRewrites.length >= 1, 'Alpha must produce at least one content rewrite to reverse');

      const before = snapshotTree(planningPath);
      const beforeConfigBytes = fs.readFileSync(configPath);

      const firstTarget = path.resolve(path.join(phasesDir, plan.phases[0].newDir));
      const failTarget = path.resolve(path.join(phasesDir, middleEntry.newDir));
      const realRename = fs.renameSync;
      let sawFirstRenameBeforeFailure = false;
      const renameMock = mock.method(fs, 'renameSync', (oldPath, newPath) => {
        const resolvedNew = path.resolve(String(newPath));
        if (resolvedNew === firstTarget) sawFirstRenameBeforeFailure = true;
        if (resolvedNew === failTarget) {
          throw Object.assign(new Error('EIO: simulated rename failure'), { code: 'EIO' });
        }
        return realRename.call(fs, oldPath, newPath);
      });
      t.after(() => renameMock.mock.restore());

      let caught;
      try {
        applyMigration(cwd, plan, { dryRun: false });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught, 'a mid-list directory-rename failure must throw, not silently succeed');
      assert.match(caught.message, /Migration failed and rolled back/);
      assert.ok(
        sawFirstRenameBeforeFailure,
        'the mock must have observed Alpha\'s own directory rename before the injected failure — '
        + 'otherwise this test proves nothing about a MID-list failure',
      );
      assert.deepEqual(
        snapshotTree(planningPath),
        before,
        'the whole .planning tree (directory listing plus every file\'s bytes) must be byte-identical after rollback',
      );
      assert.deepEqual(
        fs.readFileSync(configPath),
        beforeConfigBytes,
        'config.json must be untouched — this failure never reached the config-stamp step',
      );
    });
  });

  // #4144 round 6 (W-phase): a renamed artifact's `phase:` frontmatter kept
  // spelling the OLD legacy token, and `history-digest` (src/commands.cts,
  // `cmdHistoryDigest`) keys phases and decisions by that exact scalar — so
  // after a renumbering migration (a decimal sub-phase shifts every later
  // phase's counter, the exact shape the shipped template itself produces),
  // a phase's decisions were filed under a DIFFERENT phase's new token.
  describe('rewrites phase frontmatter in renamed artifacts (#4144 round 6 W-phase)', () => {
    function buildRenumberingFixture() {
      const cwd = materializeEmptyFixture('phasefrontmatter');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '### Phase 1: Alpha',
          '### Phase 2: Beta',
          '### Phase 2.1: CriticalFix',
          '### Phase 3: Gamma',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const dir of ['01-alpha', '02-beta', '02.1-critical-fix']) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
        fs.writeFileSync(path.join(phasesDir, dir, `${dir.split('-')[0]}-01-PLAN.md`), '---\nphase: "x"\n---\n', 'utf8');
      }
      // Gamma is legacy "3" but the decimal 2.1 insertion between it and Beta
      // shifts its counter-assigned bracket token to "04" instead of "03" —
      // the exact renumbering shape that makes a stale phase: field collide
      // with CriticalFix's own new "03" token.
      const gammaDir = path.join(phasesDir, '03-gamma');
      fs.mkdirSync(gammaDir, { recursive: true });
      fs.writeFileSync(
        path.join(gammaDir, '03-01-SUMMARY.md'),
        '---\nphase: "03"\nplan: "01"\nstatus: complete\nkey-decisions:\n  - "Gamma chose X"\n---\n\n# Summary\n',
        'utf8',
      );
      fs.writeFileSync(path.join(gammaDir, '03-01-PLAN.md'), '---\nphase: "03"\nplan: "01"\n---\n\n# Plan\n', 'utf8');
      return cwd;
    }

    function runHistoryDigest(cwd) {
      return JSON.parse(runNode(
        [TOOLS_PATH, 'history-digest'],
        { cwd, env: { ...process.env, ...helpers.TEST_ENV_BASE, HOME: cwd }, timeoutMs: COMMAND_TIMEOUT_MS },
      ).stdout);
    }

    test('a renumbered phase\'s decisions file under its OWN new token, not a colliding sibling\'s', () => {
      const cwd = buildRenumberingFixture();

      const plan = parseDryRun(runBracketUpgrade(cwd), 'renumbering dry-run');
      const gammaEntry = plan.phases.find((p) => p.oldDir === '03-gamma');
      assert.ok(gammaEntry, 'fixture must produce the 03-gamma rename');
      assert.equal(gammaEntry.newDir, 'GSD.01-04-gamma', 'the decimal insertion must shift Gamma to bracket token 04');
      const summaryRewrite = gammaEntry.dependsOnRewrites.find((r) => r.oldName === '03-01-SUMMARY.md');
      assert.ok(summaryRewrite, 'the summary\'s stale phase: field must produce a rewrite entry');
      assert.equal(extractFrontmatter(summaryRewrite.to).phase, '04', 'phase: must be corrected to Gamma\'s own new token');

      const applied = runBracketUpgrade(cwd, ['--apply']);
      assertExited(applied, 0, 'renumbering apply');

      const digest = runHistoryDigest(cwd);
      assert.deepEqual(
        digest.decisions,
        [{ phase: '04', decision: 'Gamma chose X' }],
        'the decision must be filed under Gamma\'s own new token, never under 03 (CriticalFix\'s new token)',
      );
    });
  });

  // #4144 round 6 (C-fence, claims finder): fence handling was heading-only
  // — a checklist bullet INSIDE a fenced markdown example was still
  // rewritten, even though the identical heading inside the same fence
  // (round 5 W4) already survives untouched.
  describe('skips fenced checklist bullets the way fenced headings are skipped (#4144 round 6 C-fence)', () => {
    test('a fenced checklist bullet survives byte-identical; the real phase converts normally', () => {
      const cwd = materializeEmptyFixture('fencedchecklist');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '### Phase 1: Alpha',
          '',
          '- [ ] **Phase 1:** Alpha',
          '',
          '```markdown',
          '- [ ] **Phase 1:** example',
          '```',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      fs.mkdirSync(path.join(phasesDir, '01-alpha'), { recursive: true });
      fs.writeFileSync(path.join(phasesDir, '01-alpha', '01-01-PLAN.md'), '---\nphase: "01"\n---\n', 'utf8');

      const plan = parseDryRun(runBracketUpgrade(cwd), 'fenced checklist dry-run');
      assert.ok(
        plan.roadmapEdits.some(({ from, to }) => from === '- [ ] **Phase 1:** Alpha' && to === '- [ ] **[GSD.01] 01:** Alpha'),
        'the real checklist bullet must still convert',
      );
      assert.ok(
        !plan.roadmapEdits.some(({ from }) => from === '- [ ] **Phase 1:** example'),
        'the fenced checklist bullet must never appear in roadmapEdits at all',
      );

      const applied = runBracketUpgrade(cwd, ['--apply']);
      assertExited(applied, 0, 'fenced checklist apply');
      const after = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.ok(
        after.includes('```markdown\n- [ ] **Phase 1:** example\n```'),
        'the fenced bullet must survive byte-identical',
      );
    });
  });

  // #4144 round 7 W3: `BULLET_PHASE_LINE_PATTERN` (roadmap-parser.cts:1446,
  // the scanner `scanMilestonePhaseIds` uses) accepts BOTH `-` and `*` list
  // markers (`^\s*[-*]\s+...`), but this migrator's own checklist prefix
  // (`CHECKLIST_BULLET_PREFIX_SRC`) began with a literal `-` only, so a
  // `* [ ] **Phase 1: Alpha**` bullet stayed legacy after an otherwise-done
  // migration — and the bracket-mode milestone id set then carried the
  // stale legacy token alongside the bracket ones.
  describe('accepts star list markers on checklist bullets (#4144 round 7 W3)', () => {
    test('star-marker bold checklist bullets convert the same way dash-marker ones do', () => {
      const cwd = materializeEmptyFixture('starbullet');
      fs.writeFileSync(
        path.join(cwd, '.planning', 'config.json'),
        JSON.stringify({ project_code: 'GSD', phase_id_convention: null }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(cwd, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '## v1.0 Core',
          '',
          '* [ ] **Phase 1: Alpha**',
          '* [ ] **Phase 2: Beta**',
          '',
          '### Phase 1: Alpha',
          '### Phase 2: Beta',
          '',
        ].join('\n'),
        'utf8',
      );
      const phasesDir = path.join(cwd, '.planning', 'phases');
      for (const dir of ['01-alpha', '02-beta']) {
        fs.mkdirSync(path.join(phasesDir, dir), { recursive: true });
      }

      const plan = parseDryRun(runBracketUpgrade(cwd), 'star-bullet dry-run');
      assert.equal(plan.roadmapEdits.find(({ from }) => from === '* [ ] **Phase 1: Alpha**')?.to, '* [ ] **[GSD.01] 01: Alpha**');
      assert.equal(plan.roadmapEdits.find(({ from }) => from === '* [ ] **Phase 2: Beta**')?.to, '* [ ] **[GSD.01] 02: Beta**');

      const applied = runBracketUpgrade(cwd, ['--apply']);
      assertExited(applied, 0, 'star-bullet apply');
      const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf8');
      assert.match(roadmap, /\* \[ \] \*\*\[GSD\.01\] 01: Alpha\*\*/);
      assert.match(roadmap, /\* \[ \] \*\*\[GSD\.01\] 02: Beta\*\*/);

      const bracketIds = [...scanMilestonePhaseIds(roadmap, 'bracket')];
      assert.deepEqual(
        bracketIds.sort(),
        ['01', '02'],
        'no stale legacy token ("1"/"2") may survive alongside the bracket ids',
      );
    });
  });
});
