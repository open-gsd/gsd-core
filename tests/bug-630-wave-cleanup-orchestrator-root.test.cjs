// allow-test-rule: source-text-is-the-product
// execute-phase.md is the shipped orchestration contract for wave execution and
// cleanup. Bug #630: the two wave-cleanup guards resolved PRIMARY_WT from
// `git worktree list --porcelain`'s first entry — always the main checkout —
// so an orchestrator running from a non-primary (per-phase lane) worktree was
// cd'd off its own lane and tripped the #3174 branch-drift assertion at cleanup,
// refusing merge-back. The fix persists the dispatch-time orchestrator root in
// WAVE_WORKTREE_MANIFEST and pins cleanup to that, falling back to first-entry
// only for pre-#630 manifests.
//
// This file locks the source contract (the .md is the product) AND behaviorally
// proves the pivot by running the shipped manifest-reader one-liner against a
// real non-primary-worktree git topology.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const EXECUTE_PHASE_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');

function readMd() {
  return fs.readFileSync(EXECUTE_PHASE_MD, 'utf8');
}

// Pull the exact `node -e '...'` manifest-reader script shipped in the cleanup
// guard, so the behavioral test exercises the real shipped code, not a copy.
function extractManifestReaderScript() {
  const content = readMd();
  // Anchor on `PRIMARY_WT=$(MANIFEST=...` so we grab the cleanup READER, not the
  // dispatch-time writer one-liner (which shares the `MANIFEST="..." node -e` prefix).
  const m = content.match(/PRIMARY_WT=\$\(MANIFEST="\$WAVE_WORKTREE_MANIFEST" node -e '([^']*)'\)/);
  assert.ok(m, 'expected a `PRIMARY_WT=$(MANIFEST="$WAVE_WORKTREE_MANIFEST" node -e \'...\')` reader in execute-phase.md');
  return m[1];
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('bug #630 — wave-cleanup pins to the orchestrator root, not git-worktree-list first entry', () => {
  test('execute-phase.md is readable', () => {
    assert.ok(readMd().length > 0, 'execute-phase.md must not be empty');
  });

  // ── Source contract (the .md is the product) ──────────────────────────────

  test('dispatch persists the orchestrator root into the manifest (#630)', () => {
    const content = readMd();
    assert.match(
      content,
      /ORCH_ROOT=\$\(git rev-parse --show-toplevel\)/,
      'manifest init must capture the dispatch-time orchestrator root via show-toplevel',
    );
    assert.match(
      content,
      /orchestrator_root:\s*process\.env\.ORCH_ROOT/,
      'manifest init must write orchestrator_root into WAVE_WORKTREE_MANIFEST',
    );
  });

  test('both cleanup guards resolve PRIMARY_WT from the manifest orchestrator_root (#630)', () => {
    const content = readMd();
    const readers = content.match(
      /PRIMARY_WT=\$\(MANIFEST="\$WAVE_WORKTREE_MANIFEST" node -e '[^']*orchestrator_root[^']*'\)/g,
    );
    assert.ok(
      readers && readers.length >= 2,
      `both wave-cleanup guards (templated + cleanup-tail) must read orchestrator_root from the manifest; found ${readers ? readers.length : 0}`,
    );
  });

  test('first-entry resolution survives only as a guarded fallback, never the sole resolver (#630)', () => {
    const content = readMd();
    // Every remaining first-entry resolution must be preceded by the `[ -n "$PRIMARY_WT" ] ||`
    // guard, i.e. it only runs when the manifest lookup produced nothing.
    const firstEntryLines = content.match(/^.*git worktree list --porcelain \| awk '\/\^worktree \/.*$/gm) || [];
    for (const line of firstEntryLines) {
      assert.match(
        line,
        /\[ -n "\$PRIMARY_WT" \] \|\|/,
        `first-entry resolution must be a guarded fallback, not the primary resolver: ${line.trim()}`,
      );
    }
    assert.ok(firstEntryLines.length >= 2, 'expected the fallback in both cleanup guards');
  });

  // ── Behavioral proof of the pivot ─────────────────────────────────────────

  test('shipped manifest reader resolves to the lane worktree, while first-entry resolves to main (#630)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-630-'));
    try {
      const mainDir = path.join(tmpRoot, 'main');
      fs.mkdirSync(mainDir);
      git(mainDir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
      git(mainDir, ['config', 'user.email', 'test@example.com']);
      git(mainDir, ['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(mainDir, 'f.txt'), 'x\n');
      git(mainDir, ['add', '.']);
      git(mainDir, ['commit', '-q', '-m', 'init']);

      // Non-primary worktree on a per-phase lane branch.
      const laneDir = path.join(tmpRoot, 'lane');
      git(mainDir, ['worktree', 'add', '-q', '-b', 'feat/lane', laneDir]);

      const realMain = fs.realpathSync(mainDir);
      const realLane = fs.realpathSync(laneDir);

      // Manifest as written at dispatch: orchestrator_root is the lane (the orchestrator runs there).
      const manifest = path.join(tmpRoot, 'wave.json');
      fs.writeFileSync(manifest, JSON.stringify({ orchestrator_root: realLane, worktrees: [] }) + '\n');

      // Run the EXACT shipped reader one-liner.
      const script = extractManifestReaderScript();
      const resolved = execFileSync('node', ['-e', script], {
        cwd: laneDir,
        env: { ...process.env, MANIFEST: manifest },
        encoding: 'utf8',
      }).trim();

      // The buggy first-entry resolution (run from the lane) yields the MAIN checkout.
      const firstEntry = fs.realpathSync(
        git(laneDir, ['worktree', 'list', '--porcelain'])
          .split('\n')
          .find(l => l.startsWith('worktree '))
          .slice('worktree '.length),
      );

      assert.equal(resolved, realLane, 'manifest reader must resolve to the orchestrator lane worktree');
      assert.equal(firstEntry, realMain, 'sanity: first-entry resolution points at the main checkout (the #630 bug target)');
      assert.notEqual(resolved, firstEntry, 'the fix must diverge from the old first-entry behavior for a lane orchestrator');

      // The #3174 branch assertion now passes (pinned to lane → branch matches EXPECTED_BRANCH);
      // pinning to first-entry (main) would have failed it.
      const expectedBranch = 'feat/lane';
      assert.equal(git(resolved, ['rev-parse', '--abbrev-ref', 'HEAD']), expectedBranch, 'lane pin satisfies the #3174 branch check');
      assert.notEqual(git(firstEntry, ['rev-parse', '--abbrev-ref', 'HEAD']), expectedBranch, 'first-entry pin would have tripped the #3174 branch check');
    } finally {
      cleanup(tmpRoot);
    }
  });

  test('manifest reader falls through (empty output) when orchestrator_root is absent — fallback engages (#630)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-630-fb-'));
    try {
      const manifest = path.join(tmpRoot, 'legacy.json');
      // Pre-#630 manifest shape: no orchestrator_root.
      fs.writeFileSync(manifest, JSON.stringify({ worktrees: [] }) + '\n');
      const script = extractManifestReaderScript();
      const out = execFileSync('node', ['-e', script], {
        env: { ...process.env, MANIFEST: manifest },
        encoding: 'utf8',
      });
      assert.equal(out, '', 'reader must emit nothing for a manifest without orchestrator_root so the first-entry fallback engages');
    } finally {
      cleanup(tmpRoot);
    }
  });
});
