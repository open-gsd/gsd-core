'use strict';

// #4990 — scripts/backmerge-tree.cjs is the ONE shared source for the
// back-merge tree construction/verification, replacing what used to be two
// independent, hand-kept bash copies (one in auto-backmerge.yml building
// the tree, one in backmerge-merge-when-green.yml trying to reproduce it) —
// exactly the "Generative Fix Divergence" CLAUDE.md forbids. This suite
// drives the REAL script as a subprocess (`stage`/`identify`/`verify`)
// against a throwaway git fixture repo built with the existing test-suite
// git conventions (tests/helpers/git-fixture.cjs's `gitOrThrow`,
// tests/helpers/process-seam.cjs's `runNode`) — no new timeout-named
// numeric literal is introduced anywhere in this file; every bound reused
// here is an EXISTING exported constant (`GIT_FIXTURE_TIMEOUT_MS`,
// `PROBE_TIMEOUT_MS`). `scripts/backmerge-tree.cjs`'s OWN git() wrapper is
// bounded by `GIT_TIMEOUT_MS` (see that module's header for the confirmed
// value) — this file does not duplicate that bound, it only bounds the test
// harness's OWN fixture-construction/subprocess calls.
//
// This file is git-subprocess-driven only (no chmod mode-bit tricks, no
// PATH-shadowed fake binaries, no shell scripts, no symlinks) — nothing
// here is POSIX-specific, so it is intentionally NOT excluded from the
// Windows conformance tier; see the final report for the disposition.
//
// TRUST-BOUNDARY PARITY (review fix, code#3): every `verify` call in this
// suite goes through a REAL `git worktree add` scratch checkout, exactly
// like backmerge-merge-when-green.yml's production usage — never the
// fixture repo's own primary checkout — so these tests exercise the same
// shape the workflow actually calls.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  VERSION_STAMP_MANIFESTS,
  parseNameStatus,
  splitNonEmptyLines,
  deepEqual,
  fieldPathsForFile,
  stripFieldPaths,
  isVersionOnlyChange,
  isCapabilityRegistryVersionOnlyChange,
} = require('../scripts/backmerge-tree.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'backmerge-tree.cjs');

// ---------------------------------------------------------------------------
// A. Pure helpers — no subprocess.
// ---------------------------------------------------------------------------

describe('backmerge-tree: pure helpers', () => {
  test('parseNameStatus parses tab-separated status/file rows', () => {
    assert.deepEqual(
      parseNameStatus('D\t.changeset/old.md\nA\t.changeset/new.md\nM\tCHANGELOG.md\n'),
      [
        { status: 'D', file: '.changeset/old.md' },
        { status: 'A', file: '.changeset/new.md' },
        { status: 'M', file: 'CHANGELOG.md' },
      ],
    );
  });

  test('parseNameStatus ignores a rename status shape (R100) — same as the bash it replaces', () => {
    const rows = parseNameStatus('R100\told.md\tnew.md\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'R100');
  });

  test('parseNameStatus ignores blank lines', () => {
    assert.deepEqual(parseNameStatus('\n\nD\tfoo\n\n'), [{ status: 'D', file: 'foo' }]);
  });

  test('splitNonEmptyLines trims and drops empties', () => {
    assert.deepEqual(splitNonEmptyLines('a\n\n b \n'), ['a', 'b']);
  });

  test('VERSION_STAMP_MANIFESTS is derived from sync-manifest-versions.cjs (sec MEDIUM: single source, not a second hand-kept list)', () => {
    const { VERSIONED_MANIFEST_PATHS } = require('../scripts/sync-manifest-versions.cjs');
    assert.ok(Object.isFrozen(VERSION_STAMP_MANIFESTS));
    assert.deepEqual(
      [...VERSION_STAMP_MANIFESTS].sort(),
      [
        '.claude-plugin/marketplace.json',
        '.claude-plugin/plugin.json',
        'gsd-core/bin/lib/capability-registry.cjs',
        'package-lock.json',
        'package.json',
        'vscode/package.json',
      ].sort(),
    );
    for (const p of VERSIONED_MANIFEST_PATHS) {
      assert.ok(VERSION_STAMP_MANIFESTS.includes(p), `expected VERSION_STAMP_MANIFESTS to include registered manifest "${p}"`);
    }
  });

  test('deepEqual is order-independent on object keys', () => {
    assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
    assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
    assert.equal(deepEqual([1, 2], [1, 2]), true);
    assert.equal(deepEqual([1, 2], [2, 1]), false);
  });

  test('fieldPathsForFile resolves every VERSIONED_MANIFESTS entry plus package.json/package-lock.json, and null for the capability registry', () => {
    assert.deepEqual(fieldPathsForFile('package.json'), ['version']);
    assert.deepEqual(fieldPathsForFile('package-lock.json'), ['version', 'packages..version']);
    assert.deepEqual(fieldPathsForFile('.claude-plugin/plugin.json'), ['version']);
    assert.deepEqual(fieldPathsForFile('.claude-plugin/marketplace.json'), ['plugins.0.version']);
    assert.deepEqual(fieldPathsForFile('vscode/package.json'), ['version']);
    assert.equal(fieldPathsForFile('gsd-core/bin/lib/capability-registry.cjs'), null);
    assert.equal(fieldPathsForFile('unrelated.json'), null);
  });

  test('stripFieldPaths removes only the top-level version for a plain manifest', () => {
    const doc = { name: 'x', version: '1.0.0', dependencies: { y: '1.0.0' } };
    assert.deepEqual(stripFieldPaths(doc, ['version']), { name: 'x', dependencies: { y: '1.0.0' } });
  });

  test('stripFieldPaths removes BOTH root version and packages[""].version for package-lock.json', () => {
    const doc = { name: 'x', version: '1.0.0', packages: { '': { name: 'x', version: '1.0.0' }, 'node_modules/y': { version: '1.0.0' } } };
    assert.deepEqual(
      stripFieldPaths(doc, ['version', 'packages..version']),
      { name: 'x', packages: { '': { name: 'x' }, 'node_modules/y': { version: '1.0.0' } } },
    );
  });

  test('stripFieldPaths removes a nested array-index field for marketplace.json-shaped docs', () => {
    const doc = { name: 'x', plugins: [{ name: 'p', version: '1.0.0' }] };
    assert.deepEqual(stripFieldPaths(doc, ['plugins.0.version']), { name: 'x', plugins: [{ name: 'p' }] });
  });

  describe('isVersionOnlyChange (review fix, HIGH, code#7 / sec MEDIUM — field-level AND target-version-validated)', () => {
    const TARGET = '9.9.9';

    test('package.json: version-only change matching the target is accepted', () => {
      assert.equal(isVersionOnlyChange({
        oldText: JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { y: '1.0.0' } }),
        newText: JSON.stringify({ name: 'x', version: TARGET, dependencies: { y: '1.0.0' } }),
        filePath: 'package.json',
        targetVersion: TARGET,
      }), true);
    });

    test('package.json: a version bump to the WRONG value is rejected even with no other changes', () => {
      assert.equal(isVersionOnlyChange({
        oldText: JSON.stringify({ name: 'x', version: '1.0.0' }),
        newText: JSON.stringify({ name: 'x', version: '1.2.3' }),
        filePath: 'package.json',
        targetVersion: TARGET,
      }), false);
    });

    test('package.json: a dependency change alongside the (correct) version bump is rejected', () => {
      assert.equal(isVersionOnlyChange({
        oldText: JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { y: '1.0.0' } }),
        newText: JSON.stringify({ name: 'x', version: TARGET, dependencies: { y: '2.0.0' } }),
        filePath: 'package.json',
        targetVersion: TARGET,
      }), false);
    });

    test('package.json: a scripts-block change alongside the version bump is rejected', () => {
      assert.equal(isVersionOnlyChange({
        oldText: JSON.stringify({ name: 'x', version: '1.0.0', scripts: { build: 'tsc' } }),
        newText: JSON.stringify({ name: 'x', version: TARGET, scripts: { build: 'tsc && echo evil' } }),
        filePath: 'package.json',
        targetVersion: TARGET,
      }), false);
    });

    test('package-lock.json: root version + packages[""].version bumped together (matching target) is accepted', () => {
      assert.equal(isVersionOnlyChange({
        oldText: JSON.stringify({ name: 'x', version: '1.0.0', packages: { '': { name: 'x', version: '1.0.0' } } }),
        newText: JSON.stringify({ name: 'x', version: TARGET, packages: { '': { name: 'x', version: TARGET } } }),
        filePath: 'package-lock.json',
        targetVersion: TARGET,
      }), true);
    });

    test('package-lock.json: root version bumped but packages[""].version left stale is rejected', () => {
      assert.equal(isVersionOnlyChange({
        oldText: JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }),
        newText: JSON.stringify({ version: TARGET, packages: { '': { version: '1.0.0' } } }),
        filePath: 'package-lock.json',
        targetVersion: TARGET,
      }), false);
    });

    test('package-lock.json: a dependency resolved/integrity change is rejected', () => {
      assert.equal(isVersionOnlyChange({
        oldText: JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' }, 'node_modules/y': { resolved: 'a', version: '1.0.0' } } }),
        newText: JSON.stringify({ version: TARGET, packages: { '': { version: TARGET }, 'node_modules/y': { resolved: 'b', version: '1.0.0' } } }),
        filePath: 'package-lock.json',
        targetVersion: TARGET,
      }), false);
    });

    test('marketplace.json: plugins.0.version bumped to the target is accepted', () => {
      assert.equal(isVersionOnlyChange({
        oldText: JSON.stringify({ name: 'x', plugins: [{ name: 'p', version: '1.0.0' }] }),
        newText: JSON.stringify({ name: 'x', plugins: [{ name: 'p', version: TARGET }] }),
        filePath: '.claude-plugin/marketplace.json',
        targetVersion: TARGET,
      }), true);
    });

    test('marketplace.json: a change to plugins.0.name alongside the version bump is rejected', () => {
      assert.equal(isVersionOnlyChange({
        oldText: JSON.stringify({ name: 'x', plugins: [{ name: 'p', version: '1.0.0' }] }),
        newText: JSON.stringify({ name: 'x', plugins: [{ name: 'EVIL', version: TARGET }] }),
        filePath: '.claude-plugin/marketplace.json',
        targetVersion: TARGET,
      }), false);
    });

    test('a file with no registered field path (not a JSON manifest) is always rejected', () => {
      assert.equal(isVersionOnlyChange({
        oldText: '{"a":1}', newText: '{"a":2}', filePath: 'unrelated.json', targetVersion: TARGET,
      }), false);
    });

    test('unparseable JSON on either side fails CLOSED (not version-only)', () => {
      assert.equal(isVersionOnlyChange({ oldText: 'not json', newText: '{}', filePath: 'package.json', targetVersion: TARGET }), false);
      assert.equal(isVersionOnlyChange({ oldText: '{}', newText: 'not json', filePath: 'package.json', targetVersion: TARGET }), false);
    });
  });

  describe('isCapabilityRegistryVersionOnlyChange (sec MEDIUM — line-based, gsd-core/bin/lib/capability-registry.cjs)', () => {
    const TARGET = '9.9.9';
    const PRE_SYNC = '1.0.0';

    test('every changed line is a "version" line matching the target, prior value matches preSyncVersion — accepted', () => {
      const old = ['{', '  "version": "1.0.0",', '  "x": 1', '}', '  "version": "1.0.0"', '}'].join('\n');
      const neu = ['{', '  "version": "9.9.9",', '  "x": 1', '}', '  "version": "9.9.9"', '}'].join('\n');
      assert.equal(isCapabilityRegistryVersionOnlyChange({ oldText: old, newText: neu, targetVersion: TARGET, preSyncVersion: PRE_SYNC }), true);
    });

    test('a changed line that is NOT a version line is rejected', () => {
      const old = ['{', '  "version": "1.0.0",', '  "x": 1', '}'].join('\n');
      const neu = ['{', '  "version": "9.9.9",', '  "x": 2', '}'].join('\n');
      assert.equal(isCapabilityRegistryVersionOnlyChange({ oldText: old, newText: neu, targetVersion: TARGET, preSyncVersion: PRE_SYNC }), false);
    });

    test('a version line bumped to the WRONG value is rejected', () => {
      const old = ['  "version": "1.0.0",'].join('\n');
      const neu = ['  "version": "1.2.3",'].join('\n');
      assert.equal(isCapabilityRegistryVersionOnlyChange({ oldText: old, newText: neu, targetVersion: TARGET, preSyncVersion: PRE_SYNC }), false);
    });

    test('a line-count mismatch (insertion/deletion) is rejected', () => {
      const old = ['a', 'b'].join('\n');
      const neu = ['a', 'b', 'c'].join('\n');
      assert.equal(isCapabilityRegistryVersionOnlyChange({ oldText: old, newText: neu, targetVersion: TARGET, preSyncVersion: PRE_SYNC }), false);
    });

    test('identical text is trivially accepted', () => {
      const text = ['a', '  "version": "1.0.0",', 'b'].join('\n');
      assert.equal(isCapabilityRegistryVersionOnlyChange({ oldText: text, newText: text, targetVersion: TARGET, preSyncVersion: PRE_SYNC }), true);
    });

    // Round-4 review fix (LOW, code#9): a changed line whose PRIOR value does
    // NOT equal preSyncVersion is rejected, even though its new value is
    // correct — closes the gap where any line merely matching the bare
    // "version": "X" shape could be rewritten to targetVersion regardless of
    // what it previously held.
    describe('round-4 review fix (LOW, code#9): prior value must equal preSyncVersion', () => {
      test('a version line whose PRIOR value is unrelated to preSyncVersion is rejected, even though the new value is correct', () => {
        const old = ['{', '  "version": "1.0.0",', '  "version": "5.5.5",', '}'].join('\n');
        const neu = ['{', '  "version": "9.9.9",', '  "version": "9.9.9",', '}'].join('\n');
        assert.equal(
          isCapabilityRegistryVersionOnlyChange({ oldText: old, newText: neu, targetVersion: TARGET, preSyncVersion: PRE_SYNC }),
          false,
          'the second line\'s prior value (5.5.5) does not equal preSyncVersion (1.0.0) — must reject',
        );
      });

      test('missing/non-string preSyncVersion fails closed (rejected) even for an otherwise-valid change', () => {
        const old = ['  "version": "1.0.0",'].join('\n');
        const neu = ['  "version": "9.9.9",'].join('\n');
        assert.equal(isCapabilityRegistryVersionOnlyChange({ oldText: old, newText: neu, targetVersion: TARGET, preSyncVersion: undefined }), false);
        assert.equal(isCapabilityRegistryVersionOnlyChange({ oldText: old, newText: neu, targetVersion: TARGET, preSyncVersion: null }), false);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// B. Behavioral — real subprocess against a throwaway git fixture repo.
// ---------------------------------------------------------------------------

/**
 * Build a fixture repo shaped like auto-backmerge.yml's real inputs, WITH
 * `origin/next`/`origin/main` remote-tracking refs (needed by verify's
 * ancestor checks — a real clone gets these from `git fetch`; this fixture
 * fakes them via `update-ref` since there is no real remote in a throwaway
 * repo):
 *   `next` — one commit (a.txt), then a second commit (b.txt) after main
 *            branches off, so next and main diverge.
 *   `main` — branches off next's first commit, adds CHANGELOG.md and a
 *            .changeset fragment (mirroring a real release commit).
 * `withChangelog=false` omits CHANGELOG.md from main entirely (item 10:
 * "main without CHANGELOG").
 */
function buildFixtureRepo({
  withChangelog = true,
  withPackageJson = false,
  mainPackageVersion = null,
  withCapabilities = null,
  withPackageLock = false,
} = {}) {
  const repoDir = createTempDir('backmerge-tree-fixture-');
  const g = (args) => gitOrThrow(args, { cwd: repoDir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });

  g(['init', '-q', '-b', 'next']);
  g(['config', 'user.email', 't@t.example']);
  g(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n');
  const initAdds = ['a.txt'];
  if (withPackageJson) {
    // Seeded on BOTH next and main (via this shared root commit) so a
    // later version-sync commit MODIFIES an existing file — matching real
    // auto-backmerge.yml input, where package.json always already exists on
    // next. Introducing it for the first time only in the extra commit
    // would test an unrealistic shape (git show <mergeCommit>:package.json
    // legitimately fails — see showFileAtRefOrNull in the script).
    fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify(withPackageJson)}\n`);
    initAdds.push('package.json');
  }
  if (withPackageLock) {
    // Round-4 review fix (LOW, code#8): a genuine v2/v3-shaped lockfile,
    // carrying BOTH tolerated field paths ('version' and the root package's
    // 'packages[""].version') — seeded here (shared root commit, present on
    // both next and main) so a later sync commit realistically MODIFIES it.
    const lock = {
      name: (withPackageJson && withPackageJson.name) || 'x',
      version: (withPackageJson && withPackageJson.version) || '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: (withPackageJson && withPackageJson.name) || 'x', version: (withPackageJson && withPackageJson.version) || '1.0.0' },
        'node_modules/y': { version: '2.0.0', resolved: 'https://example.invalid/y', integrity: 'sha512-abc' },
      },
    };
    fs.writeFileSync(path.join(repoDir, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    initAdds.push('package-lock.json');
  }
  if (withCapabilities) {
    // ADR-1244 D6 native capability manifests — discovered by GLOB
    // (capabilities/<id>/capability.json), never a fixed path list. Seeded
    // on the shared root commit (present on both next and main) so a later
    // sync commit realistically MODIFIES existing manifests rather than
    // introducing them for the first time.
    for (const { id, version } of withCapabilities) {
      const rel = path.join('capabilities', id, 'capability.json');
      fs.mkdirSync(path.join(repoDir, 'capabilities', id), { recursive: true });
      fs.writeFileSync(path.join(repoDir, rel), `${JSON.stringify({ id, version })}\n`);
      initAdds.push(rel.split(path.sep).join('/'));
    }
  }
  g(['add', ...initAdds]);
  g(['commit', '-q', '-m', 'init']);

  g(['checkout', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repoDir, '.changeset'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.changeset', 'foo.md'), 'a changeset\n');
  const mainAdds = ['.changeset'];
  if (withChangelog) {
    fs.writeFileSync(path.join(repoDir, 'CHANGELOG.md'), 'changelog\n');
    mainAdds.push('CHANGELOG.md');
  }
  g(['add', ...mainAdds]);
  g(['commit', '-q', '-m', 'main: release']);

  // A REAL release bumps main's OWN package.json to a NEW version (distinct
  // from next's inherited copy) — this is what makes `mainPackageVersion`
  // the correct, real `targetVersion` a version-sync commit must match
  // (scripts/backmerge-tree.cjs's verifyBackmergeContent now validates the
  // sync's NEW value against MAIN_PARENT's own package.json, not an
  // arbitrary value the test happens to pick).
  if (mainPackageVersion) {
    fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({ ...withPackageJson, version: mainPackageVersion })}\n`);
    g(['add', 'package.json']);
    g(['commit', '-q', '-m', 'main: bump version']);
  }

  g(['checkout', '-q', 'next']);
  fs.writeFileSync(path.join(repoDir, 'b.txt'), 'next only\n');
  g(['add', 'b.txt']);
  g(['commit', '-q', '-m', 'next: unrelated work']);

  g(['update-ref', 'refs/remotes/origin/next', 'refs/heads/next']);
  g(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);

  return { repoDir, g };
}

/** Run the real script as a subprocess against `repoDir`. */
function runScript(args, repoDir) {
  return runNode([SCRIPT, ...args], { cwd: repoDir, timeoutMs: PROBE_TIMEOUT_MS });
}

/**
 * Add a scratch `git worktree` at `<repoDir>/../<name>` detached at `sha`,
 * matching production usage (`verify` is NEVER called against the primary
 * checkout). Returns the absolute scratch path; caller is responsible for
 * `t.after(() => cleanup(repoDir))`, which also removes the sibling scratch
 * dir since createTempDir's cleanup recurses on `repoDir`'s PARENT only for
 * the dir it created — the scratch worktree is removed explicitly here
 * instead, before the repo itself is torn down (git worktree metadata must
 * be detached first or `git worktree list` in the primary repo would still
 * reference a now-deleted path).
 *
 * Review fix (MINOR, code#8): `remove()` now ALSO removes the scratch
 * directory from disk even when `git worktree remove` itself fails (e.g. the
 * worktree's own admin metadata got corrupted) — production's cleanup
 * (`git -C trusted worktree remove --force ... || true`) has the same
 * "best-effort, never throws" contract, but a leaked scratch directory is a
 * real resource leak this test's own cleanup must not reproduce.
 */
function addScratchWorktree(repoDir, g, sha, name = 'scratch') {
  const scratchDir = path.join(repoDir, '..', `${path.basename(repoDir)}-${name}`);
  g(['worktree', 'add', '-q', '--detach', scratchDir, sha]);
  return {
    scratchDir,
    remove: () => {
      try {
        g(['worktree', 'remove', '--force', scratchDir]);
      } catch {
        // best-effort — fall through to the forced directory removal below
      }
      // helpers.cleanup() rather than a raw fs.rmSync(): carries the same
      // Windows-EBUSY retry budget (maxRetries/retryDelay) production's own
      // best-effort teardown doesn't need (git worktree remove already
      // succeeded there in the common case), and it is already imported by
      // this file for repoDir's own teardown — one helper, not a second
      // hand-rolled removal path.
      try {
        cleanup(scratchDir);
      } catch {
        // best-effort
      }
    },
  };
}

describe('backmerge-tree: stage (build)', () => {
  test('stages next\'s tree wholesale, overlaid with CHANGELOG.md and the .changeset diff from main', (t) => {
    const { repoDir, g } = buildFixtureRepo();
    t.after(() => cleanup(repoDir));

    g(['checkout', '-q', '-b', 'backmerge', 'next']);
    const result = runScript(['stage', '--main', 'main'], repoDir);
    assert.equal(result.exitCode, 0, result.stderr);
    const printedTree = result.stdout.trim();
    assert.match(printedTree, /^[0-9a-f]{40}$/);

    g(['commit', '-q', '-m', 'chore: back-merge']);
    const committedTree = g(['rev-parse', 'HEAD^{tree}']).trim();
    assert.equal(printedTree, committedTree);

    const files = g(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n').sort();
    assert.deepEqual(files, ['.changeset/foo.md', 'CHANGELOG.md', 'a.txt', 'b.txt']);
  });

  test('main WITHOUT a CHANGELOG.md — stage tolerates its absence (no overlay attempted)', (t) => {
    const { repoDir, g } = buildFixtureRepo({ withChangelog: false });
    t.after(() => cleanup(repoDir));

    g(['checkout', '-q', '-b', 'backmerge', 'next']);
    const result = runScript(['stage', '--main', 'main'], repoDir);
    assert.equal(result.exitCode, 0, result.stderr);
    g(['commit', '-q', '-m', 'chore: back-merge']);
    const files = g(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n').sort();
    assert.deepEqual(files, ['.changeset/foo.md', 'a.txt', 'b.txt']);
  });

  test('.changeset deletion is replayed (a fragment present at the merge-base but absent on main is removed)', (t) => {
    const { repoDir, g } = buildFixtureRepo();
    t.after(() => cleanup(repoDir));

    // Add a second changeset fragment on next's SIDE of history too (so it's
    // present at the merge-base), then delete it on main — replay must drop it.
    g(['checkout', '-q', 'next']);
    g(['checkout', '-q', '-b', 'seed-both']);
    fs.mkdirSync(path.join(repoDir, '.changeset'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.changeset', 'consumed.md'), 'consumed at release\n');
    g(['add', '.changeset']);
    g(['commit', '-q', '-m', 'seed a changeset both sides will see']);
    const seedSha = g(['rev-parse', 'HEAD']).trim();

    g(['checkout', '-q', '-b', 'main2', 'main']);
    g(['merge', '-q', '--no-edit', seedSha]);
    // main "consumes" (deletes) the fragment at release.
    g(['rm', '-q', '.changeset/consumed.md']);
    g(['commit', '-q', '-m', 'main: consume changeset at release']);

    g(['checkout', '-q', '-b', 'backmerge2', 'seed-both']);
    const result = runScript(['stage', '--main', 'main2'], repoDir);
    assert.equal(result.exitCode, 0, result.stderr);
    g(['commit', '-q', '-m', 'chore: back-merge']);
    const files = g(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n');
    assert.ok(!files.includes('.changeset/consumed.md'), 'the consumed fragment must be removed by the replay');
    assert.ok(files.includes('.changeset/foo.md'), 'main\'s own fragment must still be added');
  });

  test('.changeset modification is replayed (a fragment edited on main overlays the next-side copy)', (t) => {
    const { repoDir, g } = buildFixtureRepo();
    t.after(() => cleanup(repoDir));

    g(['checkout', '-q', 'next']);
    g(['checkout', '-q', '-b', 'seed-both3']);
    fs.mkdirSync(path.join(repoDir, '.changeset'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.changeset', 'shared.md'), 'original text\n');
    g(['add', '.changeset']);
    g(['commit', '-q', '-m', 'seed a shared changeset']);
    const seedSha = g(['rev-parse', 'HEAD']).trim();

    g(['checkout', '-q', '-b', 'main3', 'main']);
    g(['merge', '-q', '--no-edit', seedSha]);
    fs.writeFileSync(path.join(repoDir, '.changeset', 'shared.md'), 'edited on main\n');
    g(['add', '.changeset']);
    g(['commit', '-q', '-m', 'main: edit the shared changeset']);

    g(['checkout', '-q', '-b', 'backmerge3', 'seed-both3']);
    const result = runScript(['stage', '--main', 'main3'], repoDir);
    assert.equal(result.exitCode, 0, result.stderr);
    g(['commit', '-q', '-m', 'chore: back-merge']);
    const content = g(['show', 'HEAD:.changeset/shared.md']);
    assert.equal(content, 'edited on main\n');
  });

  test('rejects a missing --main', (t) => {
    const { repoDir } = buildFixtureRepo();
    t.after(() => cleanup(repoDir));
    const result = runScript(['stage'], repoDir);
    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}${result.stderr}`, /--main/);
  });

  test('honors --cwd (stage runs against the given path, not the process cwd, and produces the real tree CONTENTS)', (t) => {
    const { repoDir, g } = buildFixtureRepo();
    t.after(() => cleanup(repoDir));
    g(['checkout', '-q', '-b', 'backmerge4', 'next']);
    // Invoke with ROOT as the subprocess cwd, but --cwd pointed at repoDir —
    // the script must operate on repoDir, not ROOT (which isn't even a git repo checkout of this fixture).
    const result = runNode([SCRIPT, 'stage', '--main', 'main', '--cwd', repoDir], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(result.exitCode, 0, result.stderr);
    const tree = result.stdout.trim();
    assert.match(tree, /^[0-9a-f]{40}$/);
    // Review fix (MINOR, code#7): assert the resulting tree's CONTENTS, not
    // just that a plausible-looking hash was printed — commit it and inspect
    // the real files, matching the CHANGELOG.md/.changeset overlay this
    // whole module exists to prove.
    g(['commit', '-q', '-m', 'chore: back-merge via --cwd']);
    assert.equal(g(['rev-parse', 'HEAD^{tree}']).trim(), tree);
    const files = g(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n').sort();
    assert.deepEqual(files, ['.changeset/foo.md', 'CHANGELOG.md', 'a.txt', 'b.txt']);
    assert.equal(g(['show', 'HEAD:CHANGELOG.md']), 'changelog\n');
    assert.equal(g(['show', 'HEAD:.changeset/foo.md']), 'a changeset\n');
  });

  test('prints usage', () => {
    const result = runNode([SCRIPT, '--help'], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Usage/i);
  });
});

describe('backmerge-tree: identify', () => {
  // Round-9 review fix (correcting a round-8 regression): identify() now
  // matches the back-merge merge-commit shape by ANCESTRY (each parent is
  // an ancestor-or-self of origin/next / origin/main), never by parent
  // COUNT — a round-8 "fix" wrongly rejected any 2-parent head whose own
  // parent was itself a merge commit, which rejects GENUINE back-merges:
  // main's tip is routinely a merge commit (release.yml merges release into
  // main with `gh pr merge --merge`), and next's tip can be one too (a
  // prior back-merge). `mainTipIsMerge`/`nextTipIsMerge` build exactly
  // those shapes so the fixture can prove identify() still accepts them.
  function refreshOriginRefs(g) {
    const nextSha = g(['rev-parse', 'next']).trim();
    const mainSha = g(['rev-parse', 'main']).trim();
    g(['update-ref', 'refs/remotes/origin/next', nextSha]);
    g(['update-ref', 'refs/remotes/origin/main', mainSha]);
  }

  function buildMergeCommit(opts = {}) {
    const { repoDir, g } = buildFixtureRepo();
    if (opts.mainTipIsMerge) {
      g(['checkout', '-q', '-b', 'release-side', 'main']);
      fs.writeFileSync(path.join(repoDir, 'release.txt'), 'r\n');
      g(['add', 'release.txt']);
      g(['commit', '-q', '-m', 'release side work']);
      g(['checkout', '-q', 'main']);
      g(['merge', '-q', '--no-ff', '--no-edit', 'release-side']);
      refreshOriginRefs(g);
    }
    if (opts.nextTipIsMerge) {
      g(['checkout', '-q', '-b', 'prior-side', 'next']);
      fs.writeFileSync(path.join(repoDir, 'prior.txt'), 'p\n');
      g(['add', 'prior.txt']);
      g(['commit', '-q', '-m', 'prior side work']);
      g(['checkout', '-q', 'next']);
      g(['merge', '-q', '--no-ff', '--no-edit', 'prior-side']);
      refreshOriginRefs(g);
    }
    g(['checkout', '-q', '-b', 'backmerge', 'next']);
    const stageResult = runScript(['stage', '--main', 'main'], repoDir);
    assert.equal(stageResult.exitCode, 0, stageResult.stderr);
    g(['commit', '-q', '-m', 'chore: back-merge']);
    const mergeCommit = g(['rev-parse', 'HEAD']).trim();
    const nextParent = g(['rev-parse', `${mergeCommit}^1`]).trim();
    const mainParent = g(['rev-parse', `${mergeCommit}^2`]).trim();
    return { repoDir, g, mergeCommit, nextParent, mainParent };
  }

  test('identifies a genuine back-merge whose MAIN parent is itself a merge commit (release -> main via gh pr merge --merge)', (t) => {
    const { repoDir, mergeCommit, nextParent, mainParent, g } = buildMergeCommit({ mainTipIsMerge: true });
    t.after(() => cleanup(repoDir));
    const mainParentParentCount = g(['rev-list', '--parents', '--max-count=1', mainParent]).trim().split(/\s+/).length - 1;
    assert.equal(mainParentParentCount, 2, 'fixture sanity check: mainParent really is a merge commit');
    const result = runScript(['identify', '--head', mergeCommit, '--cwd', repoDir], repoDir);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, mergeCommit, nextParent, mainParent, extraCommit: null });
  });

  test('identifies a genuine back-merge whose NEXT parent is itself a merge commit (a prior back-merge)', (t) => {
    const { repoDir, mergeCommit, nextParent, mainParent, g } = buildMergeCommit({ nextTipIsMerge: true });
    t.after(() => cleanup(repoDir));
    const nextParentParentCount = g(['rev-list', '--parents', '--max-count=1', nextParent]).trim().split(/\s+/).length - 1;
    assert.equal(nextParentParentCount, 2, 'fixture sanity check: nextParent really is a merge commit');
    const result = runScript(['identify', '--head', mergeCommit, '--cwd', repoDir], repoDir);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, mergeCommit, nextParent, mainParent, extraCommit: null });
  });

  // A 2-parent commit is refused when its FIRST parent is not really on
  // `next` at all (forged via commit-tree) — the ancestry check, not parent
  // count, is what makes this the correct rejection.
  test('a 2-parent head whose first parent is not an ancestor of origin/next is rejected', (t) => {
    const { repoDir, g, mainParent } = buildMergeCommit();
    t.after(() => cleanup(repoDir));
    g(['checkout', '-q', '-b', 'rogue-root']);
    fs.writeFileSync(path.join(repoDir, 'rogue.txt'), 'rogue\n');
    g(['add', 'rogue.txt']);
    g(['commit', '-q', '-m', 'a commit with no relation to next']);
    const rogue = g(['rev-parse', 'HEAD']).trim();
    const tree = g(['rev-parse', 'HEAD^{tree}']).trim();
    const forged = g(['commit-tree', tree, '-p', rogue, '-p', mainParent, '-m', 'forged']).trim();

    const result = runScript(['identify', '--head', forged, '--cwd', repoDir], repoDir);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, reason: 'unrecognized-shape' });
  });

  test('identifies a bare merge commit (no extra commit on top)', (t) => {
    const { repoDir, mergeCommit, nextParent, mainParent } = buildMergeCommit();
    t.after(() => cleanup(repoDir));
    const result = runScript(['identify', '--head', mergeCommit, '--cwd', repoDir], repoDir);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, mergeCommit, nextParent, mainParent, extraCommit: null });
  });

  test('identifies a merge commit with one version-sync commit on top', (t) => {
    const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit();
    t.after(() => cleanup(repoDir));
    fs.writeFileSync(path.join(repoDir, 'package.json'), '{"version":"9.9.9"}\n');
    g(['add', 'package.json']);
    g(['commit', '-q', '-m', 'chore: sync version']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const result = runScript(['identify', '--head', head, '--cwd', repoDir], repoDir);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, mergeCommit, nextParent, mainParent, extraCommit: head });
  });

  // Review fix (MEDIUM, code#4): a `gh pr update-branch`-style operation
  // creates ANOTHER merge commit on top (merging the new base into the
  // branch) — that shape must NOT be identified as "one extra commit"; it
  // must be refused outright, since identify only recognizes exactly
  // 0-or-1 plain (non-merge) commits on top of the real merge commit.
  test('an update-branch-style extra MERGE commit on top is an unrecognized shape', (t) => {
    const { repoDir, g, mergeCommit } = buildMergeCommit();
    t.after(() => cleanup(repoDir));
    g(['checkout', '-q', '-b', 'other-side', mergeCommit]);
    fs.writeFileSync(path.join(repoDir, 'zzz.txt'), 'zzz\n');
    g(['add', 'zzz.txt']);
    g(['commit', '-q', '-m', 'unrelated side commit']);
    const otherSide = g(['rev-parse', 'HEAD']).trim();

    g(['checkout', '-q', '-b', 'update-branch-style', mergeCommit]);
    // Round-8 review fix (root cause, part 1 of 2): `otherSide` was built
    // directly on top of `mergeCommit`, so `mergeCommit` is a direct
    // ancestor of `otherSide` — a plain `git merge` here FAST-FORWARDS
    // instead of creating a real merge commit, silently collapsing this
    // fixture down to the SAME 1-parent shape the "one version-sync commit
    // on top" test already covers. `--no-ff` forces the real 2-parent
    // merge-of-a-merge commit this test's name and comment describe.
    g(['merge', '-q', '--no-ff', '--no-edit', otherSide]);
    const updateBranchHead = g(['rev-parse', 'HEAD']).trim();

    const result = runScript(['identify', '--head', updateBranchHead, '--cwd', repoDir], repoDir);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, reason: 'unrecognized-shape' });
  });

  test('two plain commits on top is an unrecognized shape', (t) => {
    const { repoDir, g, mergeCommit } = buildMergeCommit();
    t.after(() => cleanup(repoDir));
    g(['checkout', '-q', '-b', 'too-many', mergeCommit]);
    fs.writeFileSync(path.join(repoDir, 'one.txt'), '1\n');
    g(['add', 'one.txt']);
    g(['commit', '-q', '-m', 'one']);
    fs.writeFileSync(path.join(repoDir, 'two.txt'), '2\n');
    g(['add', 'two.txt']);
    g(['commit', '-q', '-m', 'two']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const result = runScript(['identify', '--head', head, '--cwd', repoDir], repoDir);
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stdout).reason, 'unrecognized-shape');
  });

  test('rejects missing --head/--cwd', (t) => {
    const { repoDir, mergeCommit } = buildMergeCommit();
    t.after(() => cleanup(repoDir));
    assert.notEqual(runScript(['identify', '--cwd', repoDir], repoDir).exitCode, 0);
    assert.notEqual(runScript(['identify', '--head', mergeCommit], repoDir).exitCode, 0);
  });
});

describe('backmerge-tree: verify (always via a scratch git worktree, per production usage)', () => {
  function buildMergeCommit(fixtureOpts) {
    const { repoDir, g } = buildFixtureRepo(fixtureOpts);
    g(['checkout', '-q', '-b', 'backmerge', 'next']);
    const stageResult = runScript(['stage', '--main', 'main'], repoDir);
    assert.equal(stageResult.exitCode, 0, stageResult.stderr);
    g(['commit', '-q', '-m', 'chore: back-merge']);
    const mergeCommit = g(['rev-parse', 'HEAD']).trim();
    const nextParent = g(['rev-parse', `${mergeCommit}^1`]).trim();
    const mainParent = g(['rev-parse', `${mergeCommit}^2`]).trim();
    return { repoDir, g, mergeCommit, nextParent, mainParent };
  }

  test('build then verify (head === mergeCommit) resolves ok:true, exit 0', (t) => {
    const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit();
    const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent);
    t.after(() => { remove(); cleanup(repoDir); });

    const result = runScript(
      ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', mergeCommit, '--cwd', scratchDir],
      repoDir,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  });

  test('a version-sync-only extra commit on top, matching MAIN_PARENT\'s real version, is accepted (ok:true, exit 0)', (t) => {
    // package.json is seeded on BOTH next and main from the fixture's shared
    // root commit, so the extra commit here MODIFIES it — the realistic
    // shape (real auto-backmerge.yml input always already has package.json
    // on next; see buildFixtureRepo's own comment). mainPackageVersion makes
    // main's OWN package.json genuinely carry the target version, since
    // verifyBackmergeContent now validates the sync's new value against
    // MAIN_PARENT's real package.json (sec MEDIUM review fix), not an
    // arbitrary value the test happens to pick.
    const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit({
      withPackageJson: { name: 'x', version: '1.0.0' },
      mainPackageVersion: '9.9.9',
    });
    g(['checkout', '-q', '-b', 'vs-branch', mergeCommit]);
    fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({ name: 'x', version: '9.9.9' })}\n`);
    g(['add', 'package.json']);
    g(['commit', '-q', '-m', 'chore: sync version']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'vs');
    t.after(() => { remove(); cleanup(repoDir); });

    const result = runScript(
      ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', head, '--cwd', scratchDir],
      repoDir,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  });

  test('a version-sync commit bumped to a value OTHER than MAIN_PARENT\'s real version is rejected (sec MEDIUM)', (t) => {
    const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit({
      withPackageJson: { name: 'x', version: '1.0.0' },
      mainPackageVersion: '9.9.9',
    });
    g(['checkout', '-q', '-b', 'vs-wrong-branch', mergeCommit]);
    // Bumped to a DIFFERENT value than main's real 9.9.9 — must be rejected
    // even though nothing else in the file changed.
    fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({ name: 'x', version: '1.2.3' })}\n`);
    g(['add', 'package.json']);
    g(['commit', '-q', '-m', 'chore: sync version (wrong value)']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'vswrong');
    t.after(() => { remove(); cleanup(repoDir); });

    const result = runScript(
      ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', head, '--cwd', scratchDir],
      repoDir,
    );
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'version-sync-field-mismatch');
    assert.deepEqual(parsed.fieldMismatches, ['package.json']);
  });

  test('a version-sync commit that ALSO touches dependencies is rejected (field-level, code#7)', (t) => {
    const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit({
      withPackageJson: { name: 'x', version: '1.0.0', dependencies: { y: '1.0.0' } },
      mainPackageVersion: '9.9.9',
    });
    g(['checkout', '-q', '-b', 'vs-dep-branch', mergeCommit]);
    fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({ name: 'x', version: '9.9.9', dependencies: { y: '2.0.0' } })}\n`);
    g(['add', 'package.json']);
    g(['commit', '-q', '-m', 'chore: sync version (but also bump a dependency)']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'vsdep');
    t.after(() => { remove(); cleanup(repoDir); });

    const result = runScript(
      ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', head, '--cwd', scratchDir],
      repoDir,
    );
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'version-sync-field-mismatch');
    assert.deepEqual(parsed.fieldMismatches, ['package.json']);
  });

  test('an extra commit touching a file OUTSIDE the version-sync manifest set is rejected (exit 1)', (t) => {
    const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit();
    g(['checkout', '-q', '-b', 'unrel-branch', mergeCommit]);
    fs.writeFileSync(path.join(repoDir, 'unrelated.txt'), 'unrelated\n');
    g(['add', 'unrelated.txt']);
    g(['commit', '-q', '-m', 'unrelated change']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'unrel');
    t.after(() => { remove(); cleanup(repoDir); });

    const result = runScript(
      ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', head, '--cwd', scratchDir],
      repoDir,
    );
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'extra-commit-out-of-scope');
    assert.deepEqual(parsed.outOfScope, ['unrelated.txt']);
  });

  test('a tampered merge commit (same recorded parents, different tree) fails with tree-mismatch (exit 1)', (t) => {
    const { repoDir, g, nextParent, mainParent } = buildMergeCommit();
    g(['checkout', '-q', '--detach', nextParent]);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'tampered\n');
    g(['add', 'a.txt']);
    const tamperedTree = g(['write-tree']).trim();
    const tamperedCommit = g(['commit-tree', tamperedTree, '-p', nextParent, '-p', mainParent, '-m', 'tampered merge']).trim();

    const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'tamper');
    t.after(() => { remove(); cleanup(repoDir); });

    const result = runScript(
      ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', tamperedCommit, '--head', tamperedCommit, '--cwd', scratchDir],
      repoDir,
    );
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'tree-mismatch');
  });

  // Review fix (HIGH, code#2): a forged merge commit naming two ARBITRARY
  // shas as parents (never actually descended from origin/next / origin/main)
  // must be refused before any tree comparison even runs.
  describe('ancestor checks (review fix, HIGH, code#2)', () => {
    test('a next-parent that is not an ancestor of origin/next is rejected', (t) => {
      const { repoDir, g, mergeCommit, mainParent } = buildMergeCommit();
      g(['checkout', '-q', '-b', 'rogue-root']);
      fs.writeFileSync(path.join(repoDir, 'rogue.txt'), 'rogue\n');
      g(['add', 'rogue.txt']);
      g(['commit', '-q', '-m', 'a commit with no relation to next']);
      const rogue = g(['rev-parse', 'HEAD']).trim();

      const { scratchDir, remove } = addScratchWorktree(repoDir, g, rogue, 'rogue');
      t.after(() => { remove(); cleanup(repoDir); });

      const result = runScript(
        ['verify', '--next', rogue, '--main', mainParent, '--merge-commit', mergeCommit, '--head', mergeCommit, '--cwd', scratchDir],
        repoDir,
      );
      assert.equal(result.exitCode, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.reason, 'next-parent-not-ancestor-of-origin-next');
    });

    // Round-10 review fix (SEC LOW): mainParent must be EXACTLY origin/main's
    // current tip, not merely an ancestor of it — so a commit with no
    // relation to main at all (the old "rogue" fixture) is rejected the
    // same way, just under the new, more precise reason string.
    test('a main-parent unrelated to origin/main entirely is rejected (main-parent-not-current)', (t) => {
      const { repoDir, g, mergeCommit, nextParent } = buildMergeCommit();
      g(['checkout', '-q', '-b', 'rogue-main-root']);
      fs.writeFileSync(path.join(repoDir, 'rogue2.txt'), 'rogue\n');
      g(['add', 'rogue2.txt']);
      g(['commit', '-q', '-m', 'a commit with no relation to main']);
      const rogue = g(['rev-parse', 'HEAD']).trim();

      const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'roguemain');
      t.after(() => { remove(); cleanup(repoDir); });

      const result = runScript(
        ['verify', '--next', nextParent, '--main', rogue, '--merge-commit', mergeCommit, '--head', mergeCommit, '--cwd', scratchDir],
        repoDir,
      );
      assert.equal(result.exitCode, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.reason, 'main-parent-not-current');
    });

    // Round-10 review fix (SEC LOW): the primary new hazard this check
    // closes — a back-merge branch built from an OLDER main commit, where
    // main has SINCE moved (a genuine ancestor, just not the current tip).
    // A mere ancestor check would have accepted this and silently replayed
    // stale main content (e.g. a since-consumed .changeset fragment) back
    // in — must be rejected.
    test('a main-parent that is a genuine ancestor of origin/main, but NOT its current tip, is rejected (main-parent-not-current)', (t) => {
      const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit();
      // Advance main with a further commit AFTER the branch was built,
      // without rebuilding the branch — mainParent is now stale.
      g(['checkout', '-q', 'main']);
      fs.writeFileSync(path.join(repoDir, 'release2.txt'), 'r2\n');
      g(['add', 'release2.txt']);
      g(['commit', '-q', '-m', 'main: a second release landed after the branch was built']);
      const newMainSha = g(['rev-parse', 'HEAD']).trim();
      g(['update-ref', 'refs/remotes/origin/main', newMainSha]);

      const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'stalemain');
      t.after(() => { remove(); cleanup(repoDir); });

      const result = runScript(
        ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', mergeCommit, '--cwd', scratchDir],
        repoDir,
      );
      assert.equal(result.exitCode, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.reason, 'main-parent-not-current');
      assert.equal(parsed.mainParent, mainParent);
      assert.equal(parsed.currentMainSha, newMainSha);
    });

    // The accepted (happy) path: mainParent IS origin/main's current tip.
    test('a main-parent that IS origin/main\'s current tip is accepted', (t) => {
      const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit();
      const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'currentmain');
      t.after(() => { remove(); cleanup(repoDir); });

      const result = runScript(
        ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', mergeCommit, '--cwd', scratchDir],
        repoDir,
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true });
    });

    test('a foreign commit BEFORE the final head (not caught by the single-extra-commit file-scope check) is rejected by the range check', (t) => {
      // verify() does not itself enforce "at most one extra commit" — that
      // shape constraint is identify()'s job (tested separately above).
      // This directly exercises verify()'s OWN rev-list origin/next..head
      // loop: a foreign commit is inserted BEFORE the final head commit, so
      // it is neither mergeCommit, nor the literal head, nor reachable from
      // origin/main — the range check must reject it before ever reaching
      // the tree-replay or file-scope checks.
      const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit();
      g(['checkout', '-q', '-b', 'smuggle-branch', mergeCommit]);
      fs.writeFileSync(path.join(repoDir, 'smuggled.txt'), 'smuggled\n');
      g(['add', 'smuggled.txt']);
      g(['commit', '-q', '-m', 'a commit reachable from neither next nor main']);
      fs.writeFileSync(path.join(repoDir, 'package.json'), '{"version":"9.9.9"}\n');
      g(['add', 'package.json']);
      g(['commit', '-q', '-m', 'chore: sync version']);
      const head = g(['rev-parse', 'HEAD']).trim();

      const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'smuggle');
      t.after(() => { remove(); cleanup(repoDir); });

      const result = runScript(
        ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', head, '--cwd', scratchDir],
        repoDir,
      );
      assert.equal(result.exitCode, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'foreign-commit-in-range');
      assert.equal(parsed.commit, g(['rev-parse', 'smuggle-branch~1']).trim());
    });
  });

  // Round-4 review fix (BLOCKER, code#1), superseded in mechanism by
  // round-6 (BLOCKER, code#2 / sec LOW): native capability manifests
  // (capabilities/<id>/capability.json) are now discovered from the MERGE
  // COMMIT's OWN git tree (listCapabilityManifestsFromTree, filtered by the
  // SAME shape predicate sync-manifest-versions.cjs's glob-based
  // listCapabilityManifests uses) — never any checkout, so the `--trusted`
  // CLI flag is gone entirely (not passed to `verify` anywhere below).
  describe('native capability manifests (round-4 review fix, BLOCKER, code#1; round-6 review fix, BLOCKER, code#2)', () => {
    test('a version-sync commit that stamps every capability manifest is accepted (ok:true, exit 0)', (t) => {
      const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit({
        withPackageJson: { name: 'x', version: '1.0.0' },
        mainPackageVersion: '9.9.9',
        withCapabilities: [
          { id: 'alpha', version: '1.0.0' },
          { id: 'beta', version: '1.0.0' },
        ],
      });
      g(['checkout', '-q', '-b', 'cap-sync-branch', mergeCommit]);
      fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({ name: 'x', version: '9.9.9' })}\n`);
      fs.writeFileSync(path.join(repoDir, 'capabilities', 'alpha', 'capability.json'), `${JSON.stringify({ id: 'alpha', version: '9.9.9' })}\n`);
      fs.writeFileSync(path.join(repoDir, 'capabilities', 'beta', 'capability.json'), `${JSON.stringify({ id: 'beta', version: '9.9.9' })}\n`);
      g(['add', '-A']);
      g(['commit', '-q', '-m', 'chore: sync version (incl. capability manifests)']);
      const head = g(['rev-parse', 'HEAD']).trim();

      const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'capsync');
      t.after(() => { remove(); cleanup(repoDir); });

      const result = runScript(
        ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', head, '--cwd', scratchDir],
        repoDir,
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true });
    });

    test('a capability manifest sync commit that ALSO renames/adds an unrelated field is rejected (field-level)', (t) => {
      const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit({
        withPackageJson: { name: 'x', version: '1.0.0' },
        mainPackageVersion: '9.9.9',
        withCapabilities: [
          { id: 'alpha', version: '1.0.0' },
          { id: 'beta', version: '1.0.0' },
        ],
      });
      g(['checkout', '-q', '-b', 'cap-tamper-branch', mergeCommit]);
      fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({ name: 'x', version: '9.9.9' })}\n`);
      fs.writeFileSync(path.join(repoDir, 'capabilities', 'alpha', 'capability.json'), `${JSON.stringify({ id: 'alpha', version: '9.9.9' })}\n`);
      // beta's sync ALSO adds an unrelated field alongside the version bump —
      // must be rejected even though the version itself is correct.
      fs.writeFileSync(path.join(repoDir, 'capabilities', 'beta', 'capability.json'), `${JSON.stringify({ id: 'beta', version: '9.9.9', extra: true })}\n`);
      g(['add', '-A']);
      g(['commit', '-q', '-m', 'chore: sync version (beta tampered)']);
      const head = g(['rev-parse', 'HEAD']).trim();

      const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'captamper');
      t.after(() => { remove(); cleanup(repoDir); });

      const result = runScript(
        ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', head, '--cwd', scratchDir],
        repoDir,
      );
      assert.equal(result.exitCode, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'version-sync-field-mismatch');
      assert.deepEqual(parsed.fieldMismatches, ['capabilities/beta/capability.json']);
    });

    // Round-6 review fix (BLOCKER, code#2): a capability manifest that
    // exists on `next` but was NEVER on `main` at all must still be
    // discovered and accepted — proves discovery reads mergeCommit's OWN
    // tree (which IS next's tree wholesale, via the -s ours merge), not any
    // checkout of `main` or a shared-root fixture where the capability
    // happens to already exist on both branches.
    test('a capability that exists on next but was never on main is discovered and its version-sync is accepted', (t) => {
      const { repoDir, g } = buildFixtureRepo({
        withPackageJson: { name: 'x', version: '1.0.0' },
        mainPackageVersion: '9.9.9',
      });
      // Introduce the capability ONLY on next, AFTER the shared root commit
      // (main already branched off before this) — never touches main.
      g(['checkout', '-q', 'next']);
      fs.mkdirSync(path.join(repoDir, 'capabilities', 'nextonly'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'capabilities', 'nextonly', 'capability.json'), `${JSON.stringify({ id: 'nextonly', version: '1.0.0' })}\n`);
      g(['add', '-A']);
      g(['commit', '-q', '-m', 'next: introduce a capability that main has never seen']);
      g(['update-ref', 'refs/remotes/origin/next', 'refs/heads/next']);

      g(['checkout', '-q', '-b', 'backmerge-nextonly', 'next']);
      const stageResult = runScript(['stage', '--main', 'main'], repoDir);
      assert.equal(stageResult.exitCode, 0, stageResult.stderr);
      g(['commit', '-q', '-m', 'chore: back-merge']);
      const mergeCommit = g(['rev-parse', 'HEAD']).trim();
      const nextParent = g(['rev-parse', `${mergeCommit}^1`]).trim();
      const mainParent = g(['rev-parse', `${mergeCommit}^2`]).trim();

      g(['checkout', '-q', '-b', 'cap-nextonly-sync', mergeCommit]);
      fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({ name: 'x', version: '9.9.9' })}\n`);
      fs.writeFileSync(path.join(repoDir, 'capabilities', 'nextonly', 'capability.json'), `${JSON.stringify({ id: 'nextonly', version: '9.9.9' })}\n`);
      g(['add', '-A']);
      g(['commit', '-q', '-m', 'chore: sync version (incl. next-only capability)']);
      const head = g(['rev-parse', 'HEAD']).trim();

      const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'nextonly');
      t.after(() => { remove(); cleanup(repoDir); });

      const result = runScript(
        ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', head, '--cwd', scratchDir],
        repoDir,
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true });
    });
  });

  // Round-4 review fix (LOW, code#8): a genuine v2/v3 lockfile sync (both
  // 'version' and 'packages[""].version') is accepted.
  test('a version-sync commit that ALSO bumps package-lock.json (version + packages[""].version) is accepted', (t) => {
    const pkg = { name: 'x', version: '1.0.0' };
    const { repoDir, g, mergeCommit, nextParent, mainParent } = buildMergeCommit({
      withPackageJson: pkg,
      withPackageLock: true,
      mainPackageVersion: '9.9.9',
    });
    g(['checkout', '-q', '-b', 'lock-sync-branch', mergeCommit]);
    fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({ ...pkg, version: '9.9.9' })}\n`);
    const newLock = {
      name: 'x',
      version: '9.9.9',
      lockfileVersion: 3,
      packages: {
        '': { name: 'x', version: '9.9.9' },
        'node_modules/y': { version: '2.0.0', resolved: 'https://example.invalid/y', integrity: 'sha512-abc' },
      },
    };
    fs.writeFileSync(path.join(repoDir, 'package-lock.json'), `${JSON.stringify(newLock, null, 2)}\n`);
    g(['add', 'package.json', 'package-lock.json']);
    g(['commit', '-q', '-m', 'chore: sync version (incl. lockfile)']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const { scratchDir, remove } = addScratchWorktree(repoDir, g, nextParent, 'locksync');
    t.after(() => { remove(); cleanup(repoDir); });

    const result = runScript(
      ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', head, '--cwd', scratchDir],
      repoDir,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  });

  test('rejects missing required flags, including --cwd (verify must never default to the process cwd)', (t) => {
    const { repoDir, mergeCommit, nextParent, mainParent } = buildMergeCommit();
    t.after(() => cleanup(repoDir));
    const full = ['verify', '--next', nextParent, '--main', mainParent, '--merge-commit', mergeCommit, '--head', mergeCommit, '--cwd', repoDir];
    for (const missing of ['--next', '--main', '--merge-commit', '--head', '--cwd']) {
      const idx = full.indexOf(missing);
      const withoutFlag = [...full.slice(0, idx), ...full.slice(idx + 2)];
      const result = runScript(withoutFlag, repoDir);
      assert.notEqual(result.exitCode, 0, `expected a failure with ${missing} omitted`);
    }
  });
});

// ---------------------------------------------------------------------------
// C. GIT_TIMEOUT_MS / timeout handling (review fix, MAJOR, code#8).
//
// scripts/backmerge-tree.cjs has no injected spawn seam (it calls
// execFileSync directly), so this drives it via the standard Node technique
// for verifying subprocess call arguments without actually spawning: patch
// `node:child_process`'s `execFileSync` BEFORE re-requiring the module
// (busting the require cache so the module's own top-level
// `const { execFileSync } = require('node:child_process')` re-resolves
// against the patch), call into the freshly-required module, then restore.
// This is IN-PROCESS the whole time — no real subprocess, no real timeout
// wait, no new timeout-named literal introduced by the test harness itself.
// ---------------------------------------------------------------------------

describe('backmerge-tree: GIT_TIMEOUT_MS / timeout handling (review fix, code#8)', () => {
  const MODULE_PATH = require.resolve('../scripts/backmerge-tree.cjs');
  const cp = require('node:child_process');

  /** Run `fn(freshModule)` with execFileSync replaced by `impl`, then restore both. */
  function withPatchedExecFileSync(impl, fn) {
    const original = cp.execFileSync;
    cp.execFileSync = impl;
    delete require.cache[MODULE_PATH];
    try {
      const freshModule = require('../scripts/backmerge-tree.cjs');
      return fn(freshModule);
    } finally {
      cp.execFileSync = original;
      delete require.cache[MODULE_PATH];
      require('../scripts/backmerge-tree.cjs'); // re-prime the cache with a clean, unpatched copy
    }
  }

  /** Shapes a thrown error exactly like execFileSync's real timeout-kill shape. */
  function makeTimeoutError(message) {
    const err = new Error(message);
    err.killed = true;
    err.signal = 'SIGTERM';
    return err;
  }

  test('git() passes GIT_TIMEOUT_MS as the execFileSync timeout option', () => {
    const calls = [];
    withPatchedExecFileSync(
      (cmd, args, opts) => { calls.push({ cmd, args, opts }); return ''; },
      (mod) => {
        mod.git(['status'], { cwd: '/tmp' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].cmd, 'git');
        assert.equal(calls[0].opts.timeout, mod.GIT_TIMEOUT_MS);
        assert.equal(calls[0].opts.timeout, 30000);
      },
    );
  });

  test('a caller-supplied opts.timeout still wins over the default (override, not a hardcoded floor)', () => {
    // NOT a real subprocess timeout — execFileSync itself is fully replaced
    // by the no-op stub above, so this value never governs any actual spawn
    // wait; it is fixture DATA standing in for "whatever override value a
    // caller happened to pass", asserting only that git() doesn't clobber it.
    const ARBITRARY_OVERRIDE_FIXTURE_MS = 5;
    const calls = [];
    withPatchedExecFileSync(
      (cmd, args, opts) => { calls.push(opts); return ''; },
      (mod) => {
        mod.git(['status'], { cwd: '/tmp', timeout: ARBITRARY_OVERRIDE_FIXTURE_MS });
        assert.equal(calls[0].timeout, ARBITRARY_OVERRIDE_FIXTURE_MS);
      },
    );
  });

  test('isGitTimeoutError recognizes the real execFileSync timeout-kill shape', () => {
    const { isGitTimeoutError } = require('../scripts/backmerge-tree.cjs');
    assert.equal(isGitTimeoutError(makeTimeoutError('git rev-list timed out')), true);
    assert.equal(isGitTimeoutError({ code: 'ETIMEDOUT' }), true);
    assert.equal(isGitTimeoutError({ killed: false, code: 'ENOENT' }), false);
    assert.equal(isGitTimeoutError(null), false);
    assert.equal(isGitTimeoutError(undefined), false);
  });

  test('verifyBackmergeContent: a timed-out git call resolves ok:false (never ok:true — CLAUDE.md fail-closed)', () => {
    // merge-base --is-ancestor (both ancestor checks) succeeds; the next
    // UNGUARDED call, rev-list, times out — reaching the function's own
    // outer catch rather than being swallowed by isAncestor's internal one.
    const impl = (cmd, args) => {
      if (args[0] === 'merge-base') return '';
      throw makeTimeoutError('git rev-list origin/next..HEAD timed out');
    };
    withPatchedExecFileSync(impl, (mod) => {
      const result = mod.verifyBackmergeContent({
        nextParent: 'a'.repeat(40),
        mainParent: 'b'.repeat(40),
        mergeCommit: 'c'.repeat(40),
        head: 'c'.repeat(40),
        cwd: '/tmp',
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'git-timeout');
    });
  });

  test('verifyBackmergeContent: a non-timeout git failure also resolves ok:false, with a distinct reason', () => {
    const impl = (cmd, args) => {
      if (args[0] === 'merge-base') return '';
      const err = new Error('git rev-list: fatal: bad object');
      err.status = 128;
      throw err;
    };
    withPatchedExecFileSync(impl, (mod) => {
      const result = mod.verifyBackmergeContent({
        nextParent: 'a'.repeat(40),
        mainParent: 'b'.repeat(40),
        mergeCommit: 'c'.repeat(40),
        head: 'c'.repeat(40),
        cwd: '/tmp',
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'git-command-failed');
    });
  });

  test('identifyMergeCommit: a timed-out git call resolves ok:false, never a guessed shape', () => {
    const impl = () => { throw makeTimeoutError('git rev-list --parents timed out'); };
    withPatchedExecFileSync(impl, (mod) => {
      const result = mod.identifyMergeCommit({ head: 'c'.repeat(40), cwd: '/tmp' });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'git-timeout');
    });
  });

  // Review fix (MINOR, code#5): fileExistsAtRef / showFileAtRefOrNull must
  // RETHROW a timeout rather than silently collapsing it into the same
  // false/null a genuine "does not exist" read returns — a timeout on
  // fileExistsAtRef inside stageBackmergeTree must never silently SKIP the
  // CHANGELOG.md overlay.
  describe('fileExistsAtRef / showFileAtRefOrNull: timeout is rethrown, never swallowed (code#5)', () => {
    test('fileExistsAtRef rethrows on a timed-out git cat-file', () => {
      withPatchedExecFileSync(
        () => { throw makeTimeoutError('git cat-file timed out'); },
        (mod) => {
          assert.throws(() => mod.fileExistsAtRef('main', 'CHANGELOG.md', { cwd: '/tmp' }), (err) => mod.isGitTimeoutError(err));
        },
      );
    });

    test('fileExistsAtRef still returns false (swallowed) for a genuine non-timeout failure', () => {
      withPatchedExecFileSync(
        () => { const e = new Error('fatal: path does not exist'); e.status = 128; throw e; },
        (mod) => {
          assert.equal(mod.fileExistsAtRef('main', 'CHANGELOG.md', { cwd: '/tmp' }), false);
        },
      );
    });

    test('showFileAtRefOrNull rethrows on a timed-out git show', () => {
      withPatchedExecFileSync(
        () => { throw makeTimeoutError('git show timed out'); },
        (mod) => {
          assert.throws(() => mod.showFileAtRefOrNull('main', 'CHANGELOG.md', { cwd: '/tmp' }), (err) => mod.isGitTimeoutError(err));
        },
      );
    });

    test('showFileAtRefOrNull still returns null (swallowed) for a genuine non-timeout failure', () => {
      withPatchedExecFileSync(
        () => { const e = new Error('fatal: path does not exist'); e.status = 128; throw e; },
        (mod) => {
          assert.equal(mod.showFileAtRefOrNull('main', 'CHANGELOG.md', { cwd: '/tmp' }), null);
        },
      );
    });

    test('a timed-out fileExistsAtRef inside stage propagates as a crash, never silently skips the CHANGELOG.md overlay', () => {
      const impl = (cmd, args) => {
        if (args[0] === 'merge') return ''; // -s ours merge succeeds
        throw makeTimeoutError('git cat-file timed out');
      };
      withPatchedExecFileSync(impl, (mod) => {
        assert.throws(() => mod.stageBackmergeTree({ mainRef: 'main', cwd: '/tmp' }), (err) => mod.isGitTimeoutError(err));
      });
    });

    test('a timed-out fileExistsAtRef inside verify resolves ok:false, reason git-timeout — never ok:true', () => {
      const impl = (cmd, args) => {
        if (args[0] === 'merge-base') return ''; // both ancestor checks succeed
        if (args[0] === 'rev-list') return ''; // empty range, no foreign commits
        if (args[0] === 'checkout') return ''; // detach onto nextParent
        if (args[0] === 'merge') return ''; // -s ours merge succeeds
        if (args[0] === 'cat-file') throw makeTimeoutError('git cat-file (via fileExistsAtRef) timed out during stage');
        return '';
      };
      withPatchedExecFileSync(impl, (mod) => {
        const result = mod.verifyBackmergeContent({
          nextParent: 'a'.repeat(40), mainParent: 'b'.repeat(40), mergeCommit: 'c'.repeat(40), head: 'c'.repeat(40), cwd: '/tmp',
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'git-timeout');
      });
    });

    // Round-7 review fix (NIT, code#2): listCapabilityManifestsFromTree
    // rethrows on a timed-out `git ls-tree`, never swallows it into `[]` —
    // the same rule fileExistsAtRef/showFileAtRefOrNull already follow.
    describe('listCapabilityManifestsFromTree: timeout is rethrown, never swallowed (round-7, NIT, code#2)', () => {
      test('rethrows on a timed-out git ls-tree', () => {
        withPatchedExecFileSync(
          () => { throw makeTimeoutError('git ls-tree timed out'); },
          (mod) => {
            assert.throws(
              () => mod.listCapabilityManifestsFromTree('deadbeef', { cwd: '/tmp' }),
              (err) => mod.isGitTimeoutError(err),
            );
          },
        );
      });

      test('still returns [] (swallowed) for a genuine non-timeout failure (e.g. no capabilities/ at that ref)', () => {
        withPatchedExecFileSync(
          () => { const e = new Error('fatal: not a valid object name'); e.status = 128; throw e; },
          (mod) => {
            assert.deepEqual(mod.listCapabilityManifestsFromTree('deadbeef', { cwd: '/tmp' }), []);
          },
        );
      });

      test('a timed-out git ls-tree inside verify resolves ok:false, reason git-timeout — never silently accepts an unchecked capability manifest', () => {
        const impl = (cmd, args) => {
          if (args[0] === 'merge-base') return ''; // both ancestor checks succeed
          if (args[0] === 'rev-list') return ''; // empty range, no foreign commits
          if (args[0] === 'checkout') return ''; // detach onto nextParent
          if (args[0] === 'merge') return ''; // -s ours merge succeeds
          if (args[0] === 'cat-file') return ''; // CHANGELOG.md exists at mainRef
          if (args[0] === 'write-tree') return 'c'.repeat(40); // matches mergeCommit's own tree below
          if (args[0] === 'rev-parse') return 'c'.repeat(40); // mergeCommit^{tree}
          if (args[0] === 'diff') return 'capabilities/foo/capability.json\n'; // one extra file
          if (args[0] === 'show') return '{"version":"1.2.3"}\n'; // isReleaseVersion-passing target
          if (args[0] === 'ls-tree') throw makeTimeoutError('git ls-tree timed out');
          return '';
        };
        withPatchedExecFileSync(impl, (mod) => {
          const result = mod.verifyBackmergeContent({
            nextParent: 'a'.repeat(40), mainParent: 'b'.repeat(40), mergeCommit: 'c'.repeat(40), head: 'd'.repeat(40), cwd: '/tmp',
          });
          assert.equal(result.ok, false);
          assert.equal(result.reason, 'git-timeout');
        });
      });
    });
  });
});
