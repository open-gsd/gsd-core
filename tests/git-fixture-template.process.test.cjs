'use strict';

/**
 * #6336 — a git fixture is a copy of a template, not six `git` processes.
 *
 * This file runs real `git`, on purpose: what it holds is that a copied
 * repository is, to git, the repository `createFixture` used to build. Each
 * shape is checked against a template built here from scratch.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runGit } = require('./helpers/process-seam.cjs');
const { treeDigest } = require('./helpers/shared-install-fixture.cjs');
const {
  createFixture,
  TEMPLATE_VARIANTS,
  gitTemplateRoot,
  settleGitTemplates,
  templateBuildEnv,
} = require('./fixtures/index.cjs');

// Every git call here runs with the machine's git setup taken out, the way a
// template is built: stated here on its own, not borrowed from the builder.
const neutral = createTempDir('gsd-git-neutral-');
fs.writeFileSync(path.join(neutral, 'gitconfig'), '');
fs.mkdirSync(path.join(neutral, 'init-template'));
const NEUTRAL_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
NEUTRAL_ENV.GIT_CONFIG_NOSYSTEM = '1';
NEUTRAL_ENV.GIT_CONFIG_GLOBAL = path.join(neutral, 'gitconfig');
NEUTRAL_ENV.GIT_TEMPLATE_DIR = path.join(neutral, 'init-template');

const git = (cwd, args) => {
  const result = runGit(args, { cwd, env: NEUTRAL_ENV });
  return { exitCode: result.exitCode, out: result.stdout.trim() };
};
const ok = (cwd, args) => {
  const result = git(cwd, args);
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} in ${cwd}`);
  return result.out;
};

/** What git says a repository is: the facts a test that asks for a git fixture relies on. */
function describeRepo(dir) {
  return {
    branch: ok(dir, ['symbolic-ref', '--short', 'HEAD']),
    subjects: ok(dir, ['log', '--format=%s']).split('\n'),
    author: ok(dir, ['log', '-1', '--format=%an <%ae>']),
    tree: ok(dir, ['rev-parse', 'HEAD^{tree}']),
    tracked: ok(dir, ['ls-files']).split('\n').filter(Boolean),
    status: ok(dir, ['status', '--porcelain']),
    identity: [ok(dir, ['config', '--local', 'user.name']), ok(dir, ['config', '--local', 'user.email'])],
    gpgsign: ok(dir, ['config', '--local', 'commit.gpgsign']),
    planningPhases: fs.existsSync(path.join(dir, '.planning', 'phases')),
    projectDoc: fs.existsSync(path.join(dir, '.planning', 'PROJECT.md')),
    excludeFile: fs.existsSync(path.join(dir, '.git', 'info', 'exclude')),
  };
}

/**
 * The repository `createFixture` built before #6336, made here step by step.
 * It is the reference a copied fixture is held against, and shares no code
 * with the template builder.
 */
function buildByHand(shape) {
  const dir = createTempDir('gsd-git-by-hand-');
  if (shape.planning) fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  if (shape.projectDoc) {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'PROJECT.md'), '# Project\n\nTest project.\n');
  }
  ok(dir, ['init', '--initial-branch=master']);
  ok(dir, ['config', 'user.email', 'test@test.com']);
  ok(dir, ['config', 'user.name', 'Test']);
  ok(dir, ['config', 'commit.gpgsign', 'false']);
  ok(dir, ['add', '-A']);
  ok(dir, ['commit', '--allow-empty', '-m', 'initial commit']);
  return dir;
}

describe('git fixtures copied from a template (#6336)', () => {
  const made = [];
  const fixture = (shape) => {
    const dir = createFixture({ git: true, ...shape });
    made.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of made) cleanup(dir);
    cleanup(neutral);
  });

  for (const [name, shape] of Object.entries(TEMPLATE_VARIANTS)) {
    describe(`shape "${name}"`, () => {
      let dir;
      before(() => {
        dir = fixture(shape);
      });

      test('is a repository on master with the one initial commit and the fixture identity', () => {
        const repo = describeRepo(dir);
        assert.equal(repo.branch, 'master');
        assert.deepEqual(repo.subjects, ['initial commit']);
        assert.equal(repo.author, 'Test <test@test.com>');
        assert.deepEqual(repo.identity, ['Test', 'test@test.com']);
        assert.equal(repo.gpgsign, 'false');
        assert.equal(repo.excludeFile, false);
        assert.deepEqual(fs.readdirSync(path.join(dir, '.git', 'hooks')), []);
        assert.deepEqual(fs.readdirSync(path.join(dir, '.git', 'info')), []);
      });

      test('has the planning layout and project file its shape asks for, and nothing else tracked', () => {
        const repo = describeRepo(dir);
        assert.equal(repo.planningPhases, shape.planning);
        assert.equal(repo.projectDoc, shape.projectDoc);
        assert.deepEqual(repo.tracked, shape.projectDoc ? ['.planning/PROJECT.md'] : []);
      });

      test('reads as clean to porcelain and to plumbing, with no refresh first', () => {
        const fresh = fixture(shape);
        // Plumbing first: `git status` refreshes the index and would hide a stale one.
        assert.equal(git(fresh, ['diff-files', '--quiet']).exitCode, 0);
        assert.equal(git(fresh, ['diff-index', '--quiet', 'HEAD']).exitCode, 0);
        assert.equal(ok(fresh, ['status', '--porcelain']), '');
      });

      test('is the repository the six git commands used to make', () => {
        const byHand = buildByHand(shape);
        made.push(byHand);
        assert.deepEqual(describeRepo(dir), describeRepo(byHand));
      });

      test('a change committed in it shows as a change, and a second fixture does not have it', () => {
        const a = fixture(shape);
        const b = fixture(shape);
        fs.writeFileSync(path.join(a, 'added.txt'), 'x\n');
        assert.equal(ok(a, ['status', '--porcelain']), '?? added.txt');
        ok(a, ['add', '-A']);
        ok(a, ['commit', '-q', '-m', 'second']);
        assert.deepEqual(ok(a, ['log', '--format=%s']).split('\n'), ['second', 'initial commit']);
        assert.deepEqual(ok(b, ['log', '--format=%s']).split('\n'), ['initial commit']);
        assert.equal(fs.existsSync(path.join(b, 'added.txt')), false);
      });

      test('an edit to a tracked file shows as modified', { skip: !shape.projectDoc }, () => {
        const a = fixture(shape);
        fs.appendFileSync(path.join(a, '.planning', 'PROJECT.md'), 'more\n');
        assert.equal(git(a, ['diff-files', '--quiet']).exitCode, 1);
        assert.equal(ok(a, ['diff-files', '--name-only']), '.planning/PROJECT.md');
      });
    });
  }

  test('making and changing fixtures leaves the template as it was built', () => {
    const shape = TEMPLATE_VARIANTS['planning+doc'];
    const template = gitTemplateRoot(shape);
    const before_ = treeDigest(template);
    const dir = fixture(shape);
    fs.writeFileSync(path.join(dir, 'added.txt'), 'x\n');
    ok(dir, ['add', '-A']);
    ok(dir, ['commit', '-q', '-m', 'second']);
    assert.equal(treeDigest(template), before_);
  });

  test('a fixture is made with no git process: it works with nothing on PATH', (t) => {
    const shape = TEMPLATE_VARIANTS['planning+doc'];
    // The builds, if this process is the first to need them: every shape used below.
    gitTemplateRoot(shape);
    gitTemplateRoot(TEMPLATE_VARIANTS.planning);
    const saved = process.env.PATH;
    t.after(() => {
      process.env.PATH = saved;
    });
    process.env.PATH = '';
    const dirs = [fixture(shape), fixture(shape), fixture(TEMPLATE_VARIANTS.planning)];
    process.env.PATH = saved;
    for (const dir of dirs) assert.equal(fs.statSync(path.join(dir, '.git', 'HEAD')).isFile(), true);
    // And with PATH emptied, a git call really cannot run: the check above is not vacuous.
    process.env.PATH = '';
    assert.notEqual(runGit(['--version'], { env: { ...NEUTRAL_ENV, PATH: '' } }).exitCode, 0);
  });

  test('a fixture without git is still an empty layout, with no repository', () => {
    const dir = createFixture({ git: false, planning: true });
    made.push(dir);
    assert.equal(fs.existsSync(path.join(dir, '.git')), false);
    assert.equal(fs.statSync(path.join(dir, '.planning', 'phases')).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(dir, '.planning', 'PROJECT.md')), false);
  });

  test('the prefix a caller passes names the fixture directory', () => {
    const dir = createFixture({ git: true, prefix: 'gsd-prefix-check-' });
    made.push(dir);
    assert.ok(path.basename(dir).startsWith('gsd-prefix-check-'));
  });
});

describe('templateBuildEnv', () => {
  const mine = { globalConfig: '/empty/gitconfig', templateDir: '/empty/template' };
  const fixed = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/empty/gitconfig', GIT_TEMPLATE_DIR: '/empty/template' };

  test('drops every inherited GIT_ variable, whatever its case, and keeps the rest', () => {
    const env = templateBuildEnv(mine, {
      PATH: '/bin', HOME: '/home/x', GIT_DIR: '/elsewhere/.git', git_work_tree: '/w', Git_Author_Name: 'X', GITHUB_ACTIONS: 'true',
    });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/home/x', GITHUB_ACTIONS: 'true', ...fixed });
  });

  test('a caller\'s own global config, system-config switch and init template do not survive', () => {
    const env = templateBuildEnv(mine, { GIT_CONFIG_GLOBAL: '/home/x/.gitconfig', GIT_CONFIG_NOSYSTEM: '0', GIT_TEMPLATE_DIR: '/host/template' });
    assert.deepEqual(env, fixed);
  });

  test('GIT_EXEC_PATH is kept: it says where git\'s own programs are', () => {
    assert.deepEqual(templateBuildEnv(mine, { GIT_EXEC_PATH: '/opt/git/libexec', Git_Exec_Path: '/x' }), {
      GIT_EXEC_PATH: '/opt/git/libexec', Git_Exec_Path: '/x', ...fixed,
    });
  });
});

describe('settleGitTemplates', () => {
  const fakeProc = () => {
    const proc = { exitCode: undefined, argv: ['node', '/repo/tests/some.test.cjs'], written: [], stderr: { write: (text) => proc.written.push(text) } };
    return proc;
  };

  test('removes this process\'s own templates and what was built beside them', () => {
    const root = createTempDir('gsd-git-template-own-');
    fs.writeFileSync(`${root}.gitconfig`, '');
    fs.mkdirSync(`${root}.init-template`);
    const own = new Map([['bare', root]]);
    const proc = fakeProc();
    assert.deepEqual(settleGitTemplates({ store: null, own, proc }), []);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(`${root}.gitconfig`), false);
    assert.equal(fs.existsSync(`${root}.init-template`), false);
    assert.equal(own.size, 0);
    assert.equal(proc.exitCode, undefined);
  });

  test('a changed shared template fails the process', () => {
    const proc = fakeProc();
    assert.deepEqual(settleGitTemplates({ store: { changed: () => ['k'] }, own: new Map(), proc }), ['k']);
    assert.equal(proc.exitCode, 1);
    assert.equal(proc.written.length, 1);
  });

  test('unchanged shared templates leave the exit code alone', () => {
    const proc = fakeProc();
    assert.deepEqual(settleGitTemplates({ store: { changed: () => [] }, own: new Map(), proc }), []);
    assert.equal(proc.exitCode, undefined);
    assert.deepEqual(proc.written, []);
  });
});
