'use strict';

/**
 * Platform-sensitive tests split out of tests/state.test.cjs (#5074).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. The tests below carry the platform signal, so
 * they live here; tests/state.test.cjs stays signal-free and runs on Linux only.
 * Linux lanes run both files. Add a new platform-sensitive test HERE, not in the
 * base file — the generator fails if a split base regains a platform signal.
 *
 * Moved tests and why each needs a real OS:
 * - "(h) a SYMLINKED project path still resolves — repo pinning compares identity,
 *   not spelling" — creates a real symlink via fs.symlinkSync and asserts
 *   readStateHeadFreshness treats the symlinked path as the same repo; symlink
 *   creation/semantics differ under unprivileged Windows (symlink-keyword).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('readStateHeadFreshness — property invariants (#2573)', () => {
  const { runGit } = require('./helpers/process-seam.cjs');
  const { after } = require('node:test');
  const { cleanup } = require('./helpers.cjs');
  const { readStateHeadFreshness } = require('../gsd-core/bin/lib/state.cjs');

  const propDirs = [];
  after(() => { while (propDirs.length) cleanup(propDirs.pop()); });

  test('(h) a SYMLINKED project path still resolves — repo pinning compares identity, not spelling', (t) => {
    // Guard against over-tightening (g). `git rev-parse --show-toplevel` reports
    // the REAL path while the project root arrives as the caller spelled it, and
    // those differ routinely: macOS temp dirs (/var/folders → /private/var/folders),
    // any symlinked checkout, Windows casing. A raw string compare would report a
    // perfectly normal project as unknown — the inverse of the bug (g) fixes, and
    // exactly what broke the macOS and Windows CI shards.
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-symreal-'));
    propDirs.push(realDir);
    const g = (argv) => runGit(argv, { cwd: realDir }).stdout;
    g(['init', '-q']); g(['config', 'user.email', 't@t.com']); g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(realDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(realDir, 'a.txt'), 'a\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const linkDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-symlink-')), 'proj');
    propDirs.push(path.dirname(linkDir));
    try {
      fs.symlinkSync(realDir, linkDir, 'dir');
    } catch {
      t.skip('symlink creation unavailable (e.g. unprivileged Windows) — nothing to assert');
      return;
    }

    const r = readStateHeadFreshness(linkDir, head);
    assert.strictEqual(r.commit_stale, false,
      'a symlinked project path is the SAME repo — it must resolve, not degrade to unknown');
    assert.strictEqual(r.commits_behind, 0);
  });
});
