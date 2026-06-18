/**
 * Tests for findProjectRoot — Project-Root Resolution Module
 * (#1414, part of Resolution Provenance epic #1411)
 *
 * Covers heuristic (4) (nearest-ancestor .planning/ walk-up) plus targeted
 * regression cases for sub_repos and .git-precedence interactions. Does NOT
 * exhaustively re-test every prior heuristic.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findProjectRoot } = require('../gsd-core/bin/lib/project-root.cjs');
const { cleanup } = require('./helpers.cjs');

// ─── helpers ────────────────────────────────────────────────────────────────

/** Create nested path under base (all segments), returns the leaf dir path. */
function mkDeep(base, ...segments) {
  const full = path.join(base, ...segments);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

// ─── describe block ──────────────────────────────────────────────────────────

describe('findProjectRoot nearest-.planning resolution (#1414)', () => {
  let tmpDir;
  // Saved HOME/USERPROFILE env vars for tests that override them.
  let savedHome;
  let savedUserProfile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pr-test-'));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
  });

  afterEach(() => {
    cleanup(tmpDir);
    // Restore HOME/USERPROFILE unconditionally.
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
  });

  // HAPPY: invoked from a plain descendant (no .git/.planning in between)
  test('resolves ancestor .planning/ when invoked from a descendant subdirectory', () => {
    // Layout:
    //   tmpDir/
    //     .planning/           ← project root
    //     src/
    //       deep/
    //         nested/          ← startDir (no .planning/, no .git)
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    const nested = mkDeep(tmpDir, 'src', 'deep', 'nested');

    const result = findProjectRoot(nested);
    assert.strictEqual(result, tmpDir,
      'findProjectRoot should walk up and return the ancestor dir that has .planning/');
  });

  // HAPPY (determinism): resolution from root and from descendant must be identical
  test('resolution from project root and from descendant are byte-identical', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    const nested = mkDeep(tmpDir, 'lib', 'utils');

    const fromRoot = findProjectRoot(tmpDir);
    const fromDescendant = findProjectRoot(nested);

    assert.strictEqual(fromRoot, fromDescendant,
      'Resolution from project root and from descendant must produce the same path');
  });

  // BOUNDARY (exact): descendant exactly FIND_PROJECT_ROOT_MAX_DEPTH-1 levels below
  // .planning/ ancestor (i.e. 9 hops when MAX_DEPTH=10) → must resolve.
  // One level beyond (11 levels = 10 hops) → must return startDir.
  test('resolves when descendant is exactly FIND_PROJECT_ROOT_MAX_DEPTH-1 levels below ancestor .planning/', () => {
    // FIND_PROJECT_ROOT_MAX_DEPTH = 10.
    // 9 levels of nesting = 9 parent hops = within bound → must resolve.
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    const deep = mkDeep(tmpDir, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'); // 9 levels

    const result = findProjectRoot(deep);
    assert.strictEqual(result, tmpDir,
      'Should resolve when exactly FIND_PROJECT_ROOT_MAX_DEPTH-1 levels deep (9 hops, bound=10)');
  });

  // BOUNDARY (exact): descendant exactly one level BEYOND FIND_PROJECT_ROOT_MAX_DEPTH
  // (10 levels of nesting = 10 parent hops = at bound; 11 levels = 11 hops = beyond).
  // The loop runs while depth2 < MAX_DEPTH (10), so depth2 reaches 9 after checking
  // 10 parents; the 11th level parent is never checked → returns startDir.
  test('returns startDir when descendant exceeds FIND_PROJECT_ROOT_MAX_DEPTH', () => {
    // 11 levels deep — exceeds the depth=10 bound
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    const tooDeep = mkDeep(tmpDir, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'); // 11 levels

    const result = findProjectRoot(tooDeep);
    assert.strictEqual(result, tooDeep,
      'Should return startDir when ancestor .planning/ is beyond FIND_PROJECT_ROOT_MAX_DEPTH');
  });

  // BOUNDARY: own .planning/ guard unchanged — startDir with .planning/ returns startDir
  test('returns startDir when startDir itself has .planning/ (own-guard unchanged)', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });

    const result = findProjectRoot(tmpDir);
    assert.strictEqual(result, tmpDir,
      'When startDir has .planning/ it should be returned as-is (heuristic 0 guard)');
  });

  // HOME-ROOTED PROJECT: a project whose root is exactly $HOME must be resolvable
  // from a descendant. Previously the `if (parent2 === home) break` fired BEFORE
  // the .planning check, making $HOME-rooted projects unresolvable. After the
  // reorder, $HOME itself is checked before the break fires.
  test('resolves a project rooted at $HOME from a descendant (home checked before break)', () => {
    // Make tmpDir act as $HOME by setting both HOME and USERPROFILE.
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    // Create a .planning/ directly inside "home" (tmpDir).
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });

    // Invoke from a subdirectory of "home".
    const sub = mkDeep(tmpDir, 'sub', 'dir');

    const result = findProjectRoot(sub);
    assert.strictEqual(result, tmpDir,
      'findProjectRoot must resolve a project rooted exactly at $HOME (home checked before break)');
  });

  // NEGATIVE/REGRESSION: sub_repos workspace — child sub-repo has its OWN .planning/
  // but NO .git — invoked from inside the child → must still resolve to PARENT workspace.
  // Why: heuristic (1) sub_repos claims the child (matched by name in sub_repos array)
  // before heuristic (4) runs; because the child has no independent .git root, the
  // sub_repos entry is the controlling signal. This test is the real guard that
  // heuristic (4) does NOT hijack sub_repos resolution.
  test('sub_repos workspace: child with own .planning/ (no .git) still resolves to parent workspace', () => {
    // Layout:
    //   workspaceRoot/
    //     .planning/
    //       config.json   ← sub_repos: ['child']
    //     child/
    //       .planning/   ← child has its own .planning/ but NO .git (the trap for heuristic 4)
    //       src/
    //         code.js    ← startDir (descendant of child)
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pr-subrepos-'));
    try {
      fs.mkdirSync(path.join(workspaceRoot, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, '.planning', 'config.json'),
        JSON.stringify({ sub_repos: ['child'] })
      );
      // Child repo with its own .planning/ but NO .git
      fs.mkdirSync(path.join(workspaceRoot, 'child', '.planning'), { recursive: true });
      const childSrc = mkDeep(workspaceRoot, 'child', 'src');

      const result = findProjectRoot(childSrc);
      assert.strictEqual(result, workspaceRoot,
        'sub_repos heuristic must win over nearest-.planning/ walk-up: should resolve to workspace root, not child');
    } finally {
      cleanup(workspaceRoot);
    }
  });

  // REGRESSION (pre-existing heuristic-3 behavior, orthogonal to heuristic 4):
  // A sub_repos workspace where the child has BOTH its own .planning/ AND its own
  // .git/ — invoked from inside the child — RESOLVES TO THE CHILD (not the parent).
  // Pre-existing heuristic-3 precedence: a sub-repo that is itself a full project
  // (.git + .planning) resolves to itself; this is orthogonal to heuristic 4 and
  // tracked separately. Documents current behavior.
  test('sub_repos child with BOTH .planning/ and .git/ resolves to child itself (heuristic-3 precedence)', () => {
    // Layout:
    //   workspaceRoot/
    //     .planning/
    //       config.json   ← sub_repos: ['child']
    //     child/
    //       .planning/   ← child has own .planning/
    //       .git/        ← child ALSO has own .git/ → heuristic-3 makes it self-resolving
    //       src/         ← startDir
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pr-subrepos-git-'));
    try {
      fs.mkdirSync(path.join(workspaceRoot, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, '.planning', 'config.json'),
        JSON.stringify({ sub_repos: ['child'] })
      );
      const childDir = path.join(workspaceRoot, 'child');
      fs.mkdirSync(path.join(childDir, '.planning'), { recursive: true });
      fs.mkdirSync(path.join(childDir, '.git'), { recursive: true });
      const childSrc = mkDeep(childDir, 'src');

      const result = findProjectRoot(childSrc);
      // Pre-existing heuristic-3 precedence: child is a full project (.git + .planning)
      // → resolves to the child, not the workspace root.
      assert.strictEqual(result, childDir,
        'A sub-repo with both .planning/ and .git/ should resolve to itself (heuristic-3 precedence)');
    } finally {
      cleanup(workspaceRoot);
    }
  });

  // REGRESSION (multiRepo: true, no sub_repos): a workspace whose .planning/config.json
  // has { "multiRepo": true } but no sub_repos array, with a child dir containing .git,
  // invoked from inside the child — pins pre-existing heuristic-2 behavior.
  test('multiRepo:true (no sub_repos) with child .git: pins pre-existing heuristic-2 behavior', () => {
    // Layout:
    //   workspaceRoot/
    //     .planning/
    //       config.json   ← { multiRepo: true }  (no sub_repos)
    //     child/
    //       .git/         ← child has its own git repo
    //       src/          ← startDir
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pr-multirepo-'));
    try {
      fs.mkdirSync(path.join(workspaceRoot, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, '.planning', 'config.json'),
        JSON.stringify({ multiRepo: true })
      );
      const childDir = path.join(workspaceRoot, 'child');
      fs.mkdirSync(path.join(childDir, '.git'), { recursive: true });
      const childSrc = mkDeep(childDir, 'src');

      // Run once to observe actual behavior, then assert that value to lock it.
      // Pre-existing heuristic-2: multiRepo:true + isInsideGitRepo → returns workspaceRoot.
      const result = findProjectRoot(childSrc);
      assert.strictEqual(result, workspaceRoot,
        'multiRepo:true with a child .git returns the workspace root (pins pre-existing heuristic-2 behavior)');
    } finally {
      cleanup(workspaceRoot);
    }
  });

  // NEGATIVE: no .planning/ anywhere in ancestry (within bound) → returns startDir
  test('returns startDir when no .planning/ exists anywhere in ancestry within bound', () => {
    // tmpDir has NO .planning/ — it's a plain directory
    const nested = mkDeep(tmpDir, 'src', 'lib');

    const result = findProjectRoot(nested);
    assert.strictEqual(result, nested,
      'Should return startDir unchanged when no ancestor has .planning/ within the depth bound');
  });
});
