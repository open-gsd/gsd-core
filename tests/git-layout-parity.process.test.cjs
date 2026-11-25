'use strict';

/**
 * #6355 (ADR-6315 item 25): the project context's git facts come from the
 * filesystem, and they are the facts git gives.
 *
 * resolveProjectContext used to start `git rev-parse --show-toplevel
 * --git-dir --git-common-dir` on every CLI call (and `git worktree list` in a
 * linked worktree). It now reads `.git`, `gitdir` and `commondir` itself and
 * starts git only for a layout the reader does not answer for.
 *
 * This is a process-contract test. Every fixture is built with real git, and
 * every row compares the resolver's default answer with the answer it gives
 * when forced through git. A row also pins which of the two paths answered,
 * so a layout cannot drift from "read from disk" to "ask git" (or back)
 * without this file changing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');
const { setEnvForTest, withHome } = require('./helpers/isolated-env.cjs');
const { runGit } = require('./helpers/process-seam.cjs');
const projectContext = require('../gsd-core/bin/lib/project-context.cjs');
const shellCommandProjection = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const { runCli } = require('../gsd-core/bin/gsd-tools.cjs');

const { resolveProjectContext, parseGitConfig } = projectContext;

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];

function git(cwd, args, env) {
  const result = runGit([...IDENTITY, ...args], { cwd, ...(env ? { env: { ...process.env, ...env } } : {}) });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
}

/** One tree holding every layout. Built once: the rows only read it. */
function buildFixtures(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-git-layout-')));
  t.after(() => cleanup(root));
  const at = (...parts) => path.join(root, ...parts);

  // The reader answers from the filesystem on Windows only for a repository inside this user's
  // home (ownedByThisUser, src/project-context.cts). The fixtures are the home's contents, so the
  // test declares that home instead of relying on os.tmpdir() sitting inside the runner's real
  // one, which the runner's sandbox HOME/USERPROFILE (#4635) no longer guarantees.
  withHome(t, root);

  fs.mkdirSync(at('main', 'sub', 'deep'), { recursive: true });
  git(at('main'), ['init', '-q']);
  fs.writeFileSync(at('main', 'file.txt'), 'x\n');
  git(at('main'), ['add', 'file.txt']);
  git(at('main'), ['commit', '-q', '-m', 'init']);

  git(at('main'), ['worktree', 'add', '-q', at('linked'), '-b', 'linked']);
  fs.mkdirSync(at('linked', 'sub'));

  // The same linked worktree shape, with the `.git` file's path written relative.
  git(at('main'), ['worktree', 'add', '-q', at('linked-relative'), '-b', 'linked-relative']);
  // Replaced, not overwritten: on Windows git marks a worktree's `.git` file
  // hidden, and opening a hidden file for truncation fails with EPERM.
  fs.unlinkSync(at('linked-relative', '.git'));
  fs.writeFileSync(at('linked-relative', '.git'), 'gitdir: ../main/.git/worktrees/linked-relative\n');

  git(root, ['clone', '-q', '--bare', at('main'), at('bare.git')]);
  git(at('bare.git'), ['worktree', 'add', '-q', at('of-bare'), '-b', 'of-bare']);

  git(root, ['init', '-q', '--separate-git-dir', at('separate.git'), at('separate')]);

  git(at('main'), ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', at('bare.git'), 'module']);

  fs.mkdirSync(at('core-worktree'));
  git(at('core-worktree'), ['init', '-q']);
  fs.mkdirSync(at('elsewhere'));
  git(at('core-worktree'), ['config', 'core.worktree', at('elsewhere')]);

  fs.mkdirSync(at('worktree-config'));
  git(at('worktree-config'), ['init', '-q']);
  git(at('worktree-config'), ['config', 'extensions.worktreeConfig', 'true']);
  git(at('worktree-config'), ['config', '--worktree', 'user.name', 'per-worktree']);

  fs.mkdirSync(at('no-repo', 'inner'), { recursive: true });

  // Repositories git refuses, or reads differently from how the files look.
  // Each started as a valid `git init`; the reader must leave every one to git.
  for (const [name, appended] of Object.entries(REFUSED_CONFIGS)) {
    fs.mkdirSync(at(name, 'sub'), { recursive: true });
    git(at(name), ['init', '-q']);
    fs.appendFileSync(at(name, '.git', 'config'), appended);
  }
  fs.mkdirSync(at('bad-head'));
  git(at('bad-head'), ['init', '-q']);
  fs.writeFileSync(at('bad-head', '.git', 'HEAD'), 'garbage\n');
  // A `.git` planted in a subdirectory of a real repository. git does not take
  // it for a repository and keeps walking up to the real one.
  fs.mkdirSync(at('main', 'planted', '.git', 'objects'), { recursive: true });
  fs.mkdirSync(at('main', 'planted', '.git', 'refs'));
  fs.writeFileSync(at('main', 'planted', '.git', 'HEAD'), '');
  fs.mkdirSync(at('main', 'planted', 'deep'));

  const links = process.platform !== 'win32';
  if (links) {
    fs.symlinkSync(at('main'), at('link-to-main'), 'dir');
    fs.symlinkSync(at('linked'), at('link-to-linked'), 'dir');
  }
  return { root, at, links };
}

/** The context without the one field that says which path answered. */
function facts(context) {
  const provenance = { ...context.provenance };
  delete provenance.layout;
  return { ...context, provenance };
}

// Appended to a fresh repository's config. Found by review: each is a spelling
// that a pattern over the config text misses and git honours, or a config git
// rejects outright.
const REFUSED_CONFIGS = {
  'cfg-format-9': '[core]\n\trepositoryformatversion = 9\n',
  'cfg-unknown-extension': '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tfooBar = true\n',
  'cfg-malformed': '[core\njunk\n',
  'cfg-quoted-bare': '[core]\n\tbare = "true"\n',
  'cfg-continued-bare': '[core]\n\tbare = tr\\\nue\n',
  'cfg-bare-with-comment': '[core]\n\tbare = true ; why\n',
  'cfg-numeric-bare': '[core]\n\tbare = 2\n',
  'cfg-key-on-header-line': '[core] worktree = ../elsewhere\n',
  'cfg-continued-key': '[core]\n\tworktree\\\n = ../elsewhere\n',
  'cfg-include': '[include]\n\tpath = ../other.config\n',
  // `[core "x"]` is a subsection: its keys are core.x.*, and do not override core.*.
  'cfg-bare-then-subsection-false': '[core]\n\tbare = true\n[core "x"]\n\tbare = false\n',
  'cfg-format-9-then-subsection-0': '[core]\n\trepositoryformatversion = 9\n[core "x"]\n\trepositoryformatversion = 0\n',
  // git's whitespace is space, tab, CR and LF; a form feed is a bad config line.
  'cfg-form-feed': '[core]\f\n\tfoo = 1\n',
  'cfg-vertical-tab': '[core]\v\n\tfoo = 1\n',
};

// [start, the path that must answer]. `filesystem` rows start no process.
const ROWS = [
  [['main'], 'filesystem'],
  [['main', 'sub', 'deep'], 'filesystem'],
  [['linked'], 'filesystem'],
  [['linked', 'sub'], 'filesystem'],
  [['linked-relative'], 'filesystem'],
  [['separate'], 'filesystem'],
  [['worktree-config'], 'filesystem'],
  [['no-repo'], 'filesystem'],
  [['no-repo', 'inner'], 'filesystem'],
  [['of-bare'], 'git'],
  [['bare.git'], 'git'],
  [['main', 'module'], 'git'],
  [['core-worktree'], 'git'],
  [['main', '.git'], 'git'],
  [['main', '.git', 'objects'], 'git'],
  [['not-there'], 'git'],
  [['bad-head'], 'git'],
  [['main', 'planted', 'deep'], 'git'],
  ...Object.keys(REFUSED_CONFIGS).flatMap((name) => [[[name], 'git'], [[name, 'sub'], 'git']]),
];
const LINK_ROWS = [
  [['link-to-main'], 'filesystem'],
  [['link-to-main', 'sub'], 'filesystem'],
  [['link-to-linked'], 'filesystem'],
];

test('the git facts read from the filesystem are the facts git gives, layout by layout (#6355)', (t) => {
  const { at, links } = buildFixtures(t);
  const differences = [];

  for (const [parts, expectedLayout] of [...ROWS, ...(links ? LINK_ROWS : [])]) {
    const start = at(...parts);
    let gitCalls = 0;
    const counting = (args, opts) => {
      gitCalls += 1;
      return shellCommandProjection.execGit(args, opts);
    };
    const byDefault = resolveProjectContext(start, { deps: { execGit: counting } });
    const throughGit = resolveProjectContext(start, { deps: { readGitLayout: () => null } });
    const row = parts.join('/');

    assert.equal(throughGit.provenance.layout, 'git', row);
    assert.equal(byDefault.provenance.layout, expectedLayout, `${row}: which path answered`);
    if (expectedLayout === 'filesystem') assert.equal(gitCalls, 0, `${row}: a filesystem answer starts no git process`);
    try {
      assert.deepEqual(facts(byDefault), facts(throughGit));
    } catch {
      differences.push({ row, filesystem: facts(byDefault), git: facts(throughGit) });
    }
  }

  assert.deepEqual(differences, []);
});

test('the rows cover what they claim to (#6355)', (t) => {
  const { at } = buildFixtures(t);
  const context = (...parts) => resolveProjectContext(at(...parts));

  // Each fixture is the layout its name says, by git's own account of it.
  assert.equal(context('linked').isLinkedWorktree, true);
  assert.equal(context('linked').repoRoot, at('main'));
  assert.equal(context('linked-relative').repoRoot, at('main'));
  assert.equal(context('of-bare').isLinkedWorktree, false, 'a bare repository has no main checkout to differ from');
  assert.equal(context('of-bare').provenance.reason, 'ok');
  assert.equal(context('separate').gitCommonDir, at('separate.git'));
  assert.equal(context('main', 'module').worktreeRoot, at('main', 'module'));
  assert.equal(context('core-worktree').worktreeRoot, at('elsewhere'));
  assert.equal(context('no-repo').provenance.reason, 'not_git_repo');
  assert.equal(context('no-repo').gitCommonDir, null);
  assert.equal(context('bare.git').provenance.degraded, true);
  assert.equal(context('main', 'planted', 'deep').worktreeRoot, at('main'), 'the planted .git is not the repository');
  assert.equal(context('bad-head').provenance.reason, 'not_git_repo');
  assert.equal(context('cfg-quoted-bare').provenance.degraded, true);
  assert.equal(context('cfg-malformed').provenance.degraded, true);
});

// The reader decides from a repository's config whether git would open it and
// where git would say its work tree is. It parses the file itself, so the
// parser has to be git's: this compares it with `git config --file` over files
// assembled from spellings that are valid, odd and invalid.
test('property: parseGitConfig accepts what git accepts and reads the values git reads (#6355)', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-git-config-')));
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'config');
  const fragment = fc.constantFrom(
    '[core]', '[CORE]', '[core] ', '[extensions]', '[include]', '[branch "a b"]', '[branch "x\\"y"]', '[remote "o"]',
    '[core', '[ core]', '[core "s"]x', '[]', '[core "x"]', '[extensions "x"]', '[a.B]', '\f', '\v', 'k\f= v', 'k = a\fb',
    '\tbare = false', '\tbare = true', 'bare', 'bare = "true"', 'bare = tr\\\nue', 'bare = false ; c', 'bare = false # c',
    '\tBare = FALSE', 'bare =', 'bare = no', 'bare = 0', 'worktree = ../x', 'worktree\\\n = y',
    'repositoryformatversion = 0', 'repositoryformatversion = 1', 'repositoryformatversion = 9',
    'worktreeConfig = true', 'fooBar = true', 'path = ../o', 'url = https://e/x.git',
    'fetch = +refs/heads/*:refs/remotes/o/*', 'driver = node \\"/a b/c\\" \\"%O\\"', 'k = "a b" c  ', 'k = a\\tb',
    'k = a\\qb', 'k = "unterminated', 'k = a\\', '1k = v', 'k-1 = v', 'k_1 = v', '!!!', '# comment', '; comment', '', '   ',
    'k = v\r', '[core]\r', 'k = "a;b" ; c', 'k = a"b"c', 'k="x"', 'k =v=w', '[core]bare = false', '[core] worktree = /tmp',
    'k = \\\\', 'k = "\\n"',
  );

  fc.assert(fc.property(
    fc.array(fragment, { minLength: 1, maxLength: 7 }), fc.constantFrom('\n', '\r\n'), fc.boolean(),
    (lines, newline, trailing) => {
      const text = lines.join(newline) + (trailing ? '\n' : '');
      fs.writeFileSync(file, text);
      const listed = runGit(['config', '--file', file, '--null', '--list'], { cwd: dir });
      const parsed = parseGitConfig(text);

      if (listed.exitCode !== 0) return parsed === null;
      if (parsed === null) return false;
      // `--null --list` prints "key\nvalue\0", or "key\0" for a key with no `=`.
      const fromGit = new Map();
      for (const entry of listed.stdout.split('\0')) {
        if (entry === '') continue;
        const cut = entry.indexOf('\n');
        const key = cut < 0 ? entry : entry.slice(0, cut);
        // git prints a key that has no section bare; the parser files it under the empty section.
        fromGit.set(key.includes('.') ? key : `.${key}`, cut < 0 ? true : entry.slice(cut + 1));
      }
      assert.deepEqual([...parsed.values].sort(), [...fromGit].sort());
      return true;
    },
  ), { numRuns: 150 });
});

test('environment variables that concern git (#6355)', async (t) => {
  const { at } = buildFixtures(t);
  const both = (...parts) => ({
    byDefault: resolveProjectContext(at(...parts)),
    throughGit: resolveProjectContext(at(...parts), { deps: { readGitLayout: () => null } }),
  });

  // The git seam removes GIT_DIR and GIT_WORK_TREE before it starts git
  // (#5548), so git discovers from the working directory regardless of them.
  // The reader does the same and still answers.
  await t.test('GIT_DIR and GIT_WORK_TREE do not redirect the answer, by either path', (t2) => {
    setEnvForTest(t2, { GIT_DIR: at('main', '.git'), GIT_WORK_TREE: at('main') });
    for (const [parts, worktreeRoot] of [[['no-repo'], at('no-repo')], [['linked'], at('linked')]]) {
      const { byDefault, throughGit } = both(...parts);
      assert.equal(byDefault.provenance.layout, 'filesystem');
      assert.deepEqual(facts(byDefault), facts(throughGit));
      assert.equal(byDefault.worktreeRoot, worktreeRoot);
    }
  });

  // A ceiling stops git below the repository it would otherwise find. The
  // reader would walk past it, so it leaves the question to git.
  await t.test('GIT_CEILING_DIRECTORIES sends the question to git', (t2) => {
    setEnvForTest(t2, { GIT_CEILING_DIRECTORIES: at('main', 'sub') });
    const { byDefault, throughGit } = both('main', 'sub', 'deep');

    assert.equal(byDefault.provenance.layout, 'git');
    assert.deepEqual(facts(byDefault), facts(throughGit));
    assert.equal(byDefault.provenance.reason, 'not_git_repo');
  });

  await t.test('so does each of the others that reaches git', async (t2) => {
    for (const name of ['GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) {
      await t2.test(name, (t3) => {
        setEnvForTest(t3, { [name]: name === 'GIT_CONFIG_PARAMETERS' ? "'core.bare=false'" : '0' });
        const { byDefault, throughGit } = both('main');
        assert.equal(byDefault.provenance.layout, 'git');
        assert.deepEqual(facts(byDefault), facts(throughGit));
      });
    }
  });
});

test('a CLI call starts no git process to find its project (#6355)', async (t) => {
  const { at } = buildFixtures(t);

  for (const parts of [['main'], ['linked'], ['no-repo']]) {
    await t.test(parts.join('/'), async (t2) => {
      const execGit = t2.mock.method(shellCommandProjection, 'execGit');

      const result = await runCli({ argv: ['generate-slug', 'Hello World'], cwd: at(...parts) });

      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { slug: 'hello-world' });
      assert.deepEqual(execGit.mock.calls.map((call) => call.arguments[0].join(' ')), []);
    });
  }

  await t.test('and a layout left to git still starts it', async (t2) => {
    const execGit = t2.mock.method(shellCommandProjection, 'execGit');

    const result = await runCli({ argv: ['generate-slug', 'Hello World'], cwd: at('of-bare') });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      execGit.mock.calls.map((call) => call.arguments[0].join(' ')),
      ['rev-parse --show-toplevel --git-dir --git-common-dir', 'worktree list --porcelain'],
    );
  });
});
