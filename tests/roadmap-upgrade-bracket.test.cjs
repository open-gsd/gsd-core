'use strict';

/**
 * ADR-612 PR-3 bracket migrator acceptance tests.
 *
 * These tests copy committed real-layout fixture trees into temporary Git
 * repositories and drive the compiled gsd-tools command. The router and the
 * migrator are intentionally not stubbed: dry-run, dirty-tree refusal,
 * rollback, and idempotence are command-boundary contracts.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers.cjs');
const { cleanup, TOOLS_PATH } = helpers;
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

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

  test('a mid-migration rename failure restores an ignored planning tree byte-for-byte', () => {
    const cwd = materializeFixture('legacy-multi-milestone');
    const dryRunPlan = parseDryRun(runBracketUpgrade(cwd), 'rollback setup dry-run');
    assert.ok(dryRunPlan.phases.length >= 2, 'fixture must provide a rename before the failing rename');
    const occupiedTarget = path.join(cwd, '.planning', 'phases', dryRunPlan.phases[1].newDir);
    fs.mkdirSync(occupiedTarget, { recursive: true });
    fs.writeFileSync(path.join(occupiedTarget, 'occupied.txt'), 'do not overwrite\n', 'utf8');
    const before = snapshotTree(path.join(cwd, '.planning'));

    const result = runBracketUpgrade(cwd, ['--apply']);

    assertExited(result, 1, 'mid-migration rollback');
    assert.match(result.stderr, /Migration failed and rolled back/);
    assert.deepEqual(
      snapshotTree(path.join(cwd, '.planning')),
      before,
      'ignored planning tree must be byte-restored after rollback',
    );
  });

  test('a config write failure restores renamed directories and ROADMAP bytes', {
    skip: process.platform === 'win32' ? 'requires POSIX mode-bit enforcement' : false,
  }, () => {
    const cwd = materializeFixture('legacy-multi-milestone');
    const planningPath = path.join(cwd, '.planning');
    const configPath = path.join(planningPath, 'config.json');
    fs.chmodSync(configPath, 0o444);
    const before = snapshotTree(planningPath);

    const result = runBracketUpgrade(cwd, ['--apply']);

    assertExited(result, 1, 'config write rollback');
    assert.match(result.stderr, /Migration failed and rolled back/);
    assert.deepEqual(
      snapshotTree(planningPath),
      before,
      'ignored planning tree must be byte-restored after a config write failure',
    );
    assert.match(result.stderr, /config\.json write phase/);
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
});
