'use strict';

// #5972: /gsd:pr-branch takes the target verbatim, so `origin/main` reached `gh pr create --base` (the printed next-step
// hint and the sub-repo companion PR). `gh --base` wants the bare branch name; git operations keep the full ref. The
// workflow's own fences are RUN here, with `gh` stubbed to record its argv and `gsd_run` stubbed for the default-branch
// query; the launcher preamble line is dropped because the stub stands in for it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { runHook } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'pr-branch.md');
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

function fenceContaining(marker) {
  const lines = splitLines(WORKFLOW);
  const hit = scanFencedBlocks(lines).find((b) => b.closeLineIdx !== -1
    && lines.slice(b.openLineIdx + 1, b.closeLineIdx).some((l) => l.includes(marker)));
  assert.ok(hit, `a bash fence contains ${marker}`);
  return lines.slice(hit.openLineIdx + 1, hit.closeLineIdx).filter((l) => !l.startsWith('_GSD_SHIM_NAME=')).join('\n');
}

const TARGET_FENCE = fenceContaining('TARGET=${1:-');
const COMPANION_FENCE = fenceContaining('REMOTE_SLUG=$(node -e');

const ZSH = ['/bin/zsh', '/usr/bin/zsh', '/opt/homebrew/bin/zsh', '/usr/local/bin/zsh'].some((p) => fs.existsSync(p));

const GIT = 'git -c commit.gpgsign=false -c user.email=t@example.test -c user.name=t';

/**
 * Root repo with remotes `origin` and `upstream`, plus a sub-repo whose default branch is `trunk` and which also has
 * `main` (so a base chosen from the sub-repo's default branch is distinguishable from the requested one). The target
 * fence runs with `target` as its first argument, then the companion-PR fence runs against `repoRel`.
 */
function run({ target, repoRel = 'sub', runCompanion = true, interpreter = 'bash' }) {
  const dir = createTempDir('gsd-5972-');
  try {
    const out = path.join(dir, 'out.log');
    const script = [
      'gsd_run() { echo main; }',
      'gh() { printf "%s\\n" "$@" > "$GH_ARGS"; }',
      `export GIT_CONFIG_GLOBAL=/dev/null`,
      'git init -q -b feature . && git remote add origin /nonexistent/origin.git && git remote add upstream /nonexistent/upstream.git && git remote add team/fork /nonexistent/fork.git',
      'git init -q --bare -b trunk bare.git',
      `git init -q -b trunk sub && (cd sub && ${GIT} commit -q --allow-empty -m init && git branch main && git remote add origin ../bare.git && git push -q origin trunk main)`,
      `set -- "$TARGET_ARG"`,
      TARGET_FENCE,
      'printf "%s" "$PR_BASE" > "$PR_BASE_OUT"',
      runCompanion ? [
        `ROOT="$PWD"; REPO_REL="${repoRel}"; SUB_BRANCH=feature-sub-pr; COMMIT_MSG=m`,
        `RESULT='{"remote_slug":"o/r"}'`,
        COMPANION_FENCE,
      ].join('\n') : '',
    ].join('\n');
    const res = runHook('-c', [script], {
      interpreter,
      cwd: dir,
      env: { ...process.env, TARGET_ARG: target, GH_ARGS: out, PR_BASE_OUT: path.join(dir, 'base.txt') },
    });
    assert.equal(res.exitCode, 0, res.stderr);
    const base = fs.readFileSync(path.join(dir, 'base.txt'), 'utf8');
    let ghBase = null;
    if (fs.existsSync(out)) {
      const argv = splitLines(fs.readFileSync(out, 'utf8'));
      ghBase = argv[argv.indexOf('--base') + 1];
    }
    return { prBase: base, ghBase };
  } finally {
    cleanup(dir);
  }
}

describe('#5972: gh receives the bare base branch, derived once from the target', () => {
  test('target origin/main: the derived base is main and the sub-repo companion PR is created against main', () => {
    const r = run({ target: 'origin/main' });
    assert.equal(r.prBase, 'main');
    assert.equal(r.ghBase, 'main', 'the sub-repo default branch is trunk; main is only chosen when the bare name is looked up');
  });

  test('target origin/main on the unsafe-path branch: the companion PR base is main, not origin/main', () => {
    assert.equal(run({ target: 'origin/main', repoRel: '../outside' }).ghBase, 'main');
  });

  test('target main is unchanged', () => {
    const r = run({ target: 'main' });
    assert.equal(r.prBase, 'main');
    assert.equal(r.ghBase, 'main');
  });

  test('a slash-containing branch whose prefix is not a configured remote passes through unchanged', () => {
    assert.equal(run({ target: 'release/1.2', runCompanion: false }).prBase, 'release/1.2');
  });

  test('any configured remote is stripped, not only origin', () => {
    assert.equal(run({ target: 'upstream/dev', runCompanion: false }).prBase, 'dev');
  });

  test('a configured remote whose own name contains a slash is stripped whole', () => {
    assert.equal(run({ target: 'team/fork/main', runCompanion: false }).prBase, 'main');
    assert.equal(run({ target: 'team/other/main', runCompanion: false }).prBase, 'team/other/main');
  });

  test('a target that is only a remote prefix, or strips to a flag-like name, keeps the full ref', () => {
    assert.equal(run({ target: 'origin/', runCompanion: false }).prBase, 'origin/');
    assert.equal(run({ target: 'origin/-x', runCompanion: false }).prBase, 'origin/-x');
  });

  test('the derivation does not depend on the shell word-splitting the remote list (zsh)', { skip: !ZSH && 'zsh is not installed' }, () => {
    assert.equal(run({ target: 'upstream/dev', runCompanion: false, interpreter: 'zsh' }).prBase, 'dev');
  });

  test('property: remote-qualified targets reduce to the bare name, bare names are unchanged', () => {
    fc.assert(fc.property(
      fc.constantFrom('origin', 'upstream', 'team/fork'),
      fc.stringMatching(/^[c-z][a-z0-9]{0,8}(\/[c-z][a-z0-9]{0,5})?$/),
      (remote, branch) => {
        assert.equal(run({ target: `${remote}/${branch}`, runCompanion: false }).prBase, branch);
        assert.equal(run({ target: branch, runCompanion: false }).prBase, branch);
      },
    ), { numRuns: 12 });
  });
});
