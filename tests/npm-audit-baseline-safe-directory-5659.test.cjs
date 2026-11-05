'use strict';

/**
 * #5659 — on the gsd-test bench the checkout (/work) is owned by a different uid than the one running
 * the tests, so git refuses every command ("detected dubious ownership"). The npm-audit baseline
 * resolved nothing, `tests/npm-integrity-gate.test.cjs` fell back to zero tolerance, and a pre-existing
 * advisory on `next` failed every unrelated PR's bench run until the Dependabot fix merged.
 *
 * git honors `safe.directory` from the command line only, and ownership is the one thing the baseline
 * cannot detect on its own, so the baseline's git calls pass `-c safe.directory=<repoRoot>` (scoped to
 * the repo being audited, never `*`). The stub below emulates git's refusal exactly: it exits 128 with
 * git's own message unless that override is on the command line.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const { resolveBaselineRef, extractBaselineTree, explainNoBaseline } = require('../scripts/npm-audit-baseline.cjs');

const REPO = path.join(path.sep, 'work');
// git compares safe.directory against its forward-slash path, also on Windows.
const forwardSlash = (p) => String(p).replace(/\\/g, '/');
const PKG = '{"name":"fixture","version":"1.0.0"}\n';
const LOCK = '{"name":"fixture","lockfileVersion":3,"packages":{}}\n';

/** A git that refuses unless `-c safe.directory=<cwd>` is on the command line, like the real one. */
function ownershipRefusingGit({ knownRefs = ['origin/next'], honorOverride = true } = {}) {
  const calls = [];
  const impl = (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    if (command !== 'git') throw new Error(`unexpected command ${command}`);
    const overrides = [];
    let rest = [...args];
    while (rest[0] === '-c') {
      overrides.push(rest[1]);
      rest = rest.slice(2);
    }
    const trusted = honorOverride && overrides.includes(`safe.directory=${forwardSlash(options.cwd)}`);
    if (!trusted) {
      throw Object.assign(new Error('git failed'), {
        status: 128,
        stderr: `fatal: detected dubious ownership in repository at '${options.cwd}'`,
      });
    }
    const [sub, ...tail] = rest;
    if (sub === 'rev-parse') {
      if (tail[0] === '--git-dir') return '.git\n';
      const ref = tail[tail.length - 1];
      if (knownRefs.includes(ref)) return `${'a'.repeat(40)}\n`;
      throw Object.assign(new Error('unknown revision'), { status: 128, stderr: `fatal: Needed a single revision` });
    }
    if (sub === 'show') {
      const [ref, file] = tail[0].split(':');
      if (!knownRefs.includes(ref)) throw Object.assign(new Error('bad object'), { status: 128, stderr: 'fatal: invalid object name' });
      return file === 'package.json' ? PKG : LOCK;
    }
    throw new Error(`unexpected git subcommand ${sub}`);
  };
  return { impl, calls };
}

describe('#5659 the audit baseline resolves in a checkout owned by another uid', () => {
  const saved = {};
  beforeEach(() => {
    for (const key of ['AUDIT_BASELINE_REF', 'GITHUB_BASE_REF', 'GITHUB_EVENT_NAME']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('resolveBaselineRef finds origin/next although git refuses an untrusted checkout', () => {
    const git = ownershipRefusingGit();
    assert.equal(resolveBaselineRef(REPO, { execFileSyncImpl: git.impl }), 'origin/next');
  });

  test('extractBaselineTree reads the baseline files although git refuses an untrusted checkout', (t) => {
    const git = ownershipRefusingGit();
    const dir = extractBaselineTree('origin/next', REPO, '', { execFileSyncImpl: git.impl });
    assert.notEqual(dir, null, 'the baseline tree must be extracted');
    t.after(() => cleanup(dir));
    assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), PKG);
    assert.equal(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), LOCK);
  });

  test('the override is exactly the audited repo root, a -c argument before the subcommand, never a wildcard', (t) => {
    const git = ownershipRefusingGit();
    resolveBaselineRef(REPO, { execFileSyncImpl: git.impl });
    const dir = extractBaselineTree('origin/next', REPO, '', { execFileSyncImpl: git.impl });
    if (dir) t.after(() => cleanup(dir));
    assert.ok(git.calls.length > 0);
    for (const call of git.calls) {
      assert.deepEqual(call.args.slice(0, 2), ['-c', `safe.directory=${forwardSlash(REPO)}`], `${call.args.join(' ')}: override comes first`);
      assert.ok(!call.args.some((a) => /safe\.directory=\*/.test(a)), 'never a wildcard');
    }
  });

  test('a git that refuses even with the override stays fail-closed: no baseline', () => {
    const git = ownershipRefusingGit({ honorOverride: false });
    assert.equal(resolveBaselineRef(REPO, { execFileSyncImpl: git.impl }), '');
    assert.equal(extractBaselineTree('origin/next', REPO, '', { execFileSyncImpl: git.impl }), null);
  });

  test('a ref that does not exist still yields no baseline tree', () => {
    const git = ownershipRefusingGit({ knownRefs: [] });
    assert.equal(extractBaselineTree('origin/next', REPO, '', { execFileSyncImpl: git.impl }), null);
  });
});

describe('#5659 a missing baseline says why (the zero-tolerance fallback is not silent)', () => {
  test('git refusing the checkout is named, with the first line git printed', () => {
    const git = ownershipRefusingGit({ honorOverride: false });
    const why = explainNoBaseline(REPO, { execFileSyncImpl: git.impl });
    assert.match(why, /git could not read/i);
    assert.match(why, /dubious ownership/);
  });

  test('no origin/next or next ref is named as a missing ref, not as a git failure', () => {
    const git = ownershipRefusingGit({ knownRefs: [] });
    const why = explainNoBaseline(REPO, { execFileSyncImpl: git.impl });
    assert.match(why, /no baseline ref/i);
    assert.doesNotMatch(why, /git could not read/i);
  });
});

describe('#5659 the override does not disturb a normal checkout (real git)', () => {
  test('resolveBaselineRef and extractBaselineTree work in an ordinary repo with an origin/next ref', (t) => {
    const dir = createTempDir('gsd-5659-real-');
    t.after(() => cleanup(dir));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true,
    });
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'package.json'), PKG);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), LOCK);
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/next', 'HEAD');

    const saved = {};
    for (const key of ['AUDIT_BASELINE_REF', 'GITHUB_BASE_REF', 'GITHUB_EVENT_NAME']) { saved[key] = process.env[key]; delete process.env[key]; }
    t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

    assert.equal(resolveBaselineRef(dir), 'origin/next');
    const tree = extractBaselineTree('origin/next', dir, '');
    assert.notEqual(tree, null);
    t.after(() => cleanup(tree));
    assert.equal(fs.readFileSync(path.join(tree, 'package.json'), 'utf8'), PKG);
  });
});
