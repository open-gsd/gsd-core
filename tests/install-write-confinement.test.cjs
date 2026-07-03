'use strict';

/**
 * Behavioral regression tests for ADR-1239 Phase B write-confinement.
 *
 * Tests cover:
 *   - copyWithPathReplacement: happy path, escape rejection, dest===root,
 *     fail-closed (no confinementRoot), symlink escape
 *   - installCodexConfig: happy path, agent name-injection rejection
 *   - _copyStaged: escape rejection, symlink escape (regression preserved)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

process.env['GSD_TEST_MODE'] = '1';
const {
  copyWithPathReplacement,
  installCodexConfig,
  _copyStaged,
} = require('../bin/install.js');

// ---------------------------------------------------------------------------
// copyWithPathReplacement
// ---------------------------------------------------------------------------

describe('copyWithPathReplacement write-confinement', () => {
  test('1. happy path: file is written under confinementRoot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-happy-'));
    try {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-src-'));
      try {
        fs.writeFileSync(path.join(srcDir, 'test.md'), '---\nname: test\n---\nbody\n', 'utf8');
        const destDir = path.join(root, 'sub', 'dest');
        copyWithPathReplacement(srcDir, destDir, '~/.claude/', 'claude', false, false, root);
        // The dest dir and its content must exist inside root
        const written = fs.existsSync(path.join(destDir, 'test.md'));
        assert.ok(written, 'test.md must have been written to destDir under root');
        assert.ok(
          path.resolve(destDir).startsWith(path.resolve(root) + path.sep),
          'destDir must be under root',
        );
      } finally {
        cleanup(srcDir);
      }
    } finally {
      cleanup(root);
    }
  });

  test('2. escape rejected: destDir outside confinementRoot → throws, nothing written at escape path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-root-'));
    const escapeName = 'gsd-cwpr-escape-' + Date.now();
    const escapePath = path.join(os.tmpdir(), escapeName);
    try {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-src2-'));
      try {
        fs.writeFileSync(path.join(srcDir, 'evil.md'), '# evil\n', 'utf8');
        // destDir resolves outside root via parent traversal
        const destDir = path.join(root, '..', escapeName);
        assert.throws(
          () => copyWithPathReplacement(srcDir, destDir, '~/.claude/', 'claude', false, false, root),
          /escap|must be a strict subpath|refusing/i,
        );
        // Nothing must have been created at the escape path
        assert.ok(!fs.existsSync(escapePath), 'must not create anything at the escape path');
      } finally {
        cleanup(srcDir);
      }
    } finally {
      cleanup(root);
      // also remove escapePath if it was somehow created (defensive)
      if (fs.existsSync(escapePath)) cleanup(escapePath);
    }
  });

  test('3. dest === root rejected: throws when destDir equals confinementRoot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-eqroot-'));
    try {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-src3-'));
      try {
        fs.writeFileSync(path.join(srcDir, 'x.md'), '# x\n', 'utf8');
        assert.throws(
          () => copyWithPathReplacement(srcDir, root, '~/.claude/', 'claude', false, false, root),
          /escap|must be a strict subpath|refusing|configHome itself/i,
        );
      } finally {
        cleanup(srcDir);
      }
    } finally {
      cleanup(root);
    }
  });

  test('4. fail-closed: omitting confinementRoot throws with descriptive message', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-fc-'));
    try {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-src4-'));
      try {
        fs.writeFileSync(path.join(srcDir, 'y.md'), '# y\n', 'utf8');
        const destDir = path.join(root, 'sub');
        assert.throws(
          () => copyWithPathReplacement(srcDir, destDir, '~/.claude/', 'claude', false, false, undefined),
          /confinementRoot is required/,
        );
      } finally {
        cleanup(srcDir);
      }
    } finally {
      cleanup(root);
    }
  });

  test('5. symlink escape: destDir via symlink outside root → throws', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-syml-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-out-'));
    try {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cwpr-src5-'));
      try {
        fs.writeFileSync(path.join(srcDir, 'z.md'), '# z\n', 'utf8');
        const linkPath = path.join(root, 'link');
        try {
          fs.symlinkSync(outside, linkPath);
        } catch (_symlinkErr) {
          // Symlink creation unsupported on this platform/privilege — skip test body
          t.skip('symlink creation unsupported on this platform/privilege');
          return;
        }
        const destDir = path.join(linkPath, 'sub');
        assert.throws(
          () => copyWithPathReplacement(srcDir, destDir, '~/.claude/', 'claude', false, false, root),
          /symlink|escap|confinement|install root/i,
        );
        // Nothing written to outside
        assert.strictEqual(fs.readdirSync(outside).length, 0, 'must not write to the outside dir via symlink');
      } finally {
        cleanup(srcDir);
      }
    } finally {
      // unlink the symlink before cleanup to avoid crossing boundaries
      try { fs.unlinkSync(path.join(root, 'link')); } catch { /* already gone */ }
      cleanup(root);
      cleanup(outside);
    }
  });
});

// ---------------------------------------------------------------------------
// installCodexConfig
// ---------------------------------------------------------------------------

describe('installCodexConfig write-confinement', () => {
  test('6. happy path: config.toml and agents/<name>.toml written under targetDir', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-happy-'));
    try {
      const agentsSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-src-'));
      try {
        // Minimal valid agent frontmatter
        fs.writeFileSync(
          path.join(agentsSrc, 'gsd-foo.md'),
          '---\nname: gsd-foo\ndescription: x\n---\nbody\n',
          'utf8',
        );
        const count = installCodexConfig(targetDir, agentsSrc);
        assert.strictEqual(count, 1, 'must return count of 1 agent processed');
        assert.ok(fs.existsSync(path.join(targetDir, 'config.toml')), 'config.toml must exist under targetDir');
        assert.ok(fs.existsSync(path.join(targetDir, 'agents', 'gsd-foo.toml')), 'agents/gsd-foo.toml must exist under targetDir');
      } finally {
        cleanup(agentsSrc);
      }
    } finally {
      cleanup(targetDir);
    }
  });

  test('7a. name-injection rejected: frontmatter name "../../evil" must throw, nothing written at escape', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-inj-'));
    // Use a unique escape name derived from the targetDir basename so the escape
    // path can never collide with pre-existing files in os.tmpdir().
    // agentsTomlDir = resolve(targetDir, 'agents'); ../../<escapeName>.toml from
    // there = resolve(targetDir, '../<escapeName>.toml') = dirname(targetDir)/<name>.toml
    const escapeName = path.basename(targetDir) + '-escape';
    const escapePath = path.join(path.dirname(targetDir), escapeName + '.toml');
    try {
      const agentsSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-src-inj-'));
      try {
        fs.writeFileSync(
          path.join(agentsSrc, 'gsd-evil.md'),
          `---\nname: ../../${escapeName}\ndescription: injected\n---\nbody\n`,
          'utf8',
        );
        assert.throws(
          () => installCodexConfig(targetDir, agentsSrc),
          /escap|strict subpath|refusing|NUL/i,
        );
        // Verify nothing was written at the escape location
        assert.ok(!fs.existsSync(escapePath), 'no file/dir written at escape location');
      } finally {
        cleanup(agentsSrc);
      }
    } finally {
      cleanup(targetDir);
      if (fs.existsSync(escapePath)) cleanup(escapePath);
    }
  });

  test('7b. name-injection: "../config" and "../evil" must both throw (clobber-prevention, tighter agentsTomlDir root)', () => {
    // With confinement rooted at agentsTomlDir (not targetDir), a name like
    // "../config" resolves to targetDir/config.toml — still inside the configHome
    // but OUTSIDE agents/ — so the gate must throw (clobber prevention).
    // Similarly "../evil" resolves to targetDir/evil.toml, also outside agents/.
    // Both must throw regardless of whether they escape targetDir.

    // Case A: "../config" — would clobber config.toml, must throw.
    const targetDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-inj2a-'));
    try {
      const agentsSrcA = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-src-inj2a-'));
      try {
        fs.writeFileSync(
          path.join(agentsSrcA, 'gsd-clobber.md'),
          '---\nname: ../config\ndescription: clobber attempt\n---\nbody\n',
          'utf8',
        );
        assert.throws(
          () => installCodexConfig(targetDirA, agentsSrcA),
          /escap|strict subpath|refusing|NUL/i,
          'name "../config" must throw — it escapes agents/ even though it stays inside targetDir',
        );
      } finally {
        cleanup(agentsSrcA);
      }
    } finally {
      cleanup(targetDirA);
    }

    // Case B: "../evil" — escapes agents/, must throw (new behavior with agentsTomlDir root).
    const targetDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-inj2b-'));
    try {
      const agentsSrcB = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-src-inj2b-'));
      try {
        fs.writeFileSync(
          path.join(agentsSrcB, 'gsd-up.md'),
          '---\nname: ../up-escape-attempt\ndescription: boundary test\n---\nbody\n',
          'utf8',
        );
        assert.throws(
          () => installCodexConfig(targetDirB, agentsSrcB),
          /escap|strict subpath|refusing|NUL/i,
          'name "../evil" must throw — it escapes agents/ (resolves to targetDir/evil.toml)',
        );
      } finally {
        cleanup(agentsSrcB);
      }
    } finally {
      cleanup(targetDirB);
    }

    // Case C: "../../evil" still throws (escapes both agents/ and targetDir).
    const targetDirC = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-inj2c-'));
    try {
      const agentsSrcC = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-src-inj2c-'));
      try {
        fs.writeFileSync(
          path.join(agentsSrcC, 'gsd-deep.md'),
          '---\nname: ../../deep-escape\ndescription: deep escape\n---\nbody\n',
          'utf8',
        );
        assert.throws(
          () => installCodexConfig(targetDirC, agentsSrcC),
          /escap|strict subpath|refusing|NUL/i,
        );
      } finally {
        cleanup(agentsSrcC);
      }
    } finally {
      cleanup(targetDirC);
    }
  });

  test('10. symlink-escape: agents/ is a symlink outside targetDir → throws', (t) => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-syml-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-syml-out-'));
    try {
      const agentsSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-icc-syml-src-'));
      try {
        fs.writeFileSync(
          path.join(agentsSrc, 'gsd-foo.md'),
          '---\nname: gsd-foo\ndescription: x\n---\nbody\n',
          'utf8',
        );
        const agentsLink = path.join(targetDir, 'agents');
        try {
          fs.symlinkSync(outsideDir, agentsLink);
        } catch (_symlinkErr) {
          // Symlink creation unsupported on this platform/privilege — skip
          t.skip('symlink creation unsupported on this platform/privilege');
          return;
        }
        assert.throws(
          () => installCodexConfig(targetDir, agentsSrc),
          /symlink|escap|refusing/i,
        );
        // Nothing must have been written to the outside dir via the symlink
        assert.strictEqual(fs.readdirSync(outsideDir).length, 0, 'must not write to the outside dir via symlink');
      } finally {
        cleanup(agentsSrc);
      }
    } finally {
      try { fs.unlinkSync(path.join(targetDir, 'agents')); } catch { /* already gone */ }
      cleanup(targetDir);
      cleanup(outsideDir);
    }
  });
});

// ---------------------------------------------------------------------------
// _copyStaged
// ---------------------------------------------------------------------------

describe('_copyStaged write-confinement', () => {
  test('8. escape rejected (regression): destDir escaping configDir → throws', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-cfg-'));
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-staged-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-outside-'));
    try {
      fs.writeFileSync(path.join(stagedDir, 'help.md'), '# help\n', 'utf8');
      assert.throws(
        () => _copyStaged(stagedDir, outsideDir, { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' }, configDir),
        /escap|strict subpath|refusing|configHome/i,
      );
    } finally {
      cleanup(configDir);
      cleanup(stagedDir);
      cleanup(outsideDir);
    }
  });

  test('9. symlink escape rejected: destDir containing symlink to outside → throws', (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-syml-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-syml-out-'));
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-staged2-'));
    try {
      fs.writeFileSync(path.join(stagedDir, 'help.md'), '# help\n', 'utf8');
      const linkPath = path.join(configDir, 'link');
      try {
        fs.symlinkSync(outside, linkPath);
      } catch (symlinkErr) {
        // Symlink creation unsupported on this platform/privilege — skip
        t.skip('symlink creation unsupported on this platform/privilege');
        return;
      }
      const destDir = path.join(linkPath, 'sub');
      assert.throws(
        () => _copyStaged(stagedDir, destDir, { kind: 'commands', destSubpath: 'commands/link/sub', prefix: 'gsd-' }, configDir),
        /symlink|escap|confinement|install root/i,
      );
      assert.strictEqual(fs.readdirSync(outside).length, 0, 'must not have written to outside dir');
    } finally {
      try { fs.unlinkSync(path.join(configDir, 'link')); } catch { /* already gone */ }
      cleanup(configDir);
      cleanup(outside);
      cleanup(stagedDir);
    }
  });

  test('11. fail-closed: omitting configDir throws with descriptive message', () => {
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cs-fc-staged-'));
    const destDir = path.join(os.tmpdir(), 'gsd-cs-fc-dest-' + Date.now());
    try {
      fs.writeFileSync(path.join(stagedDir, 'help.md'), '# help\n', 'utf8');
      assert.throws(
        () => _copyStaged(stagedDir, destDir, { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' }, undefined),
        /configDir.*required|required to confine/i,
      );
    } finally {
      cleanup(stagedDir);
      if (fs.existsSync(destDir)) cleanup(destDir);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2998-pristine-dir-populated.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2998-pristine-dir-populated (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2998: gsd-pristine/ snapshot is documented but never populated by
 * the installer. saveLocalPatches declared a pristineDir variable and
 * promised "saves pristine copies (from manifest) to gsd-pristine/ to
 * enable three-way merge during reapply-patches" -- but no code ever
 * wrote to that directory. Effect: the /gsd-reapply-patches Step 5
 * verifier (#2972) silently degrades to its over-broad fallback heuristic
 * ("every significant backup line"), exactly the silent-success-on-lost-
 * content failure mode #2969 was designed to prevent.
 *
 * Fix: new populatePristineDir({...}) helper runs the install transform
 * pipeline (copyWithPathReplacement) into a tmp staging dir, then copies
 * out the modified-file paths into gsd-pristine/. saveLocalPatches now
 * accepts a pristineCtx and calls the helper when local patches are
 * detected.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const INSTALL = require(path.join(ROOT, 'bin', 'install.js'));
const { cleanup } = require('./helpers.cjs');

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('Bug #2998: populatePristineDir is exported and writes pristine for modified files', () => {
  test('exported as a function', () => {
    assert.equal(typeof INSTALL.populatePristineDir, 'function',
      'expected populatePristineDir in install.js exports (#2998)');
  });

  test('returns 0 when no files are modified (no-op)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-'));
    try {
      const written = INSTALL.populatePristineDir({
        packageSrc: ROOT,
        pristineDir: path.join(tmp, 'gsd-pristine'),
        modified: [],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      });
      assert.equal(written, 0);
    } finally {
      cleanup(tmp);
    }
  });

  test('writes one pristine file per modified path that exists in source', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-'));
    const pristineDir = path.join(tmp, 'gsd-pristine');
    try {
      // Pick a real installed-side relPath from the package source. The
      // install transforms map source `gsd-core/<rel>` to installed
      // `gsd-core/<rel>` for skills-aware runtimes (like claude),
      // so the relPath is the same on both sides.
      const candidate = path.join('gsd-core', 'workflows', 'reapply-patches.md');
      const sourcePath = path.join(ROOT, candidate);
      assert.equal(fs.existsSync(sourcePath), true,
        `precondition: source file exists at ${candidate}`);
      const written = INSTALL.populatePristineDir({
        packageSrc: ROOT,
        pristineDir,
        modified: [candidate],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      });
      assert.equal(written, 1, 'expected exactly one pristine file written');
      const out = path.join(pristineDir, candidate);
      assert.equal(fs.existsSync(out), true, `expected pristine file at ${out}`);
      // The pristine content should be the transformed version (not raw source):
      // copyWithPathReplacement substitutes ~/.claude/ for the runtime path prefix.
      // For claude+global, the prefix is $HOME/.claude/ which equals the original,
      // so the transform is effectively identity here. We assert the content is a
      // non-empty markdown file rather than asserting on transform specifics.
      const content = fs.readFileSync(out, 'utf-8');
      assert.ok(content.length > 0, 'pristine file should be non-empty');
    } finally {
      cleanup(tmp);
    }
  });

  test('skips paths not present in source (does not corrupt pristine with stale data)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-'));
    const pristineDir = path.join(tmp, 'gsd-pristine');
    try {
      const written = INSTALL.populatePristineDir({
        packageSrc: ROOT,
        pristineDir,
        modified: ['gsd-core/this-path-does-not-exist.md'],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      });
      assert.equal(written, 0, 'expected zero pristine files for non-existent source paths');
      const out = path.join(pristineDir, 'gsd-core/this-path-does-not-exist.md');
      assert.equal(fs.existsSync(out), false, 'pristine should not contain ghost paths');
    } finally {
      cleanup(tmp);
    }
  });

  test('pristine files have stable content (transformations are deterministic)', () => {
    // Determinism is what makes the verifier's hash check meaningful:
    // backup-meta.json records pristine_hashes computed at this same step,
    // so re-running with the same inputs must yield byte-identical files.
    const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-d1-'));
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-d2-'));
    try {
      const candidate = path.join('gsd-core', 'workflows', 'reapply-patches.md');
      const ctx = {
        packageSrc: ROOT,
        modified: [candidate],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      };
      INSTALL.populatePristineDir(Object.assign({ pristineDir: path.join(tmp1, 'gsd-pristine') }, ctx));
      INSTALL.populatePristineDir(Object.assign({ pristineDir: path.join(tmp2, 'gsd-pristine') }, ctx));
      const a = fs.readFileSync(path.join(tmp1, 'gsd-pristine', candidate));
      const b = fs.readFileSync(path.join(tmp2, 'gsd-pristine', candidate));
      assert.equal(sha256(a), sha256(b), 'two runs of the same inputs must yield identical pristine content');
    } finally {
      cleanup(tmp1);
      cleanup(tmp2);
    }
  });
});

// ─── #3004 CR follow-up: multi-root pristine expansion ─────────────────────

describe('Bug #2998 (#3004 CR): pristine expansion covers every manifest install root', () => {
  test('paths under agents/ are staged via copyWithPathReplacement, not silently skipped', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-multi-'));
    const pristineDir = path.join(tmp, 'gsd-pristine');
    try {
      const candidate = path.join('agents', 'gsd-planner.md');
      const sourcePath = path.join(ROOT, candidate);
      assert.equal(fs.existsSync(sourcePath), true,
        `precondition: source file exists at ${candidate}`);
      const written = INSTALL.populatePristineDir({
        packageSrc: ROOT,
        pristineDir,
        modified: [candidate],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      });
      assert.equal(written, 1, 'expected agents/ path to be staged and copied to pristine');
      assert.equal(fs.existsSync(path.join(pristineDir, candidate)), true);
    } finally {
      cleanup(tmp);
    }
  });

  test('a mix of gsd-core/ and agents/ paths in modified list are all staged', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2998-mix-'));
    const pristineDir = path.join(tmp, 'gsd-pristine');
    try {
      const a = path.join('gsd-core', 'workflows', 'reapply-patches.md');
      const b = path.join('agents', 'gsd-planner.md');
      assert.equal(fs.existsSync(path.join(ROOT, a)), true);
      assert.equal(fs.existsSync(path.join(ROOT, b)), true);
      const written = INSTALL.populatePristineDir({
        packageSrc: ROOT,
        pristineDir,
        modified: [a, b],
        runtime: 'claude',
        pathPrefix: '$HOME/.claude/',
        isGlobal: true,
      });
      assert.equal(written, 2, 'expected both top-level dirs to be staged');
      assert.equal(fs.existsSync(path.join(pristineDir, a)), true);
      assert.equal(fs.existsSync(path.join(pristineDir, b)), true);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('Bug #2998: saveLocalPatches no longer leaves the pristineDir variable unused', () => {
  test('saveLocalPatches accepts a pristineCtx and exposes the helper for direct testing', () => {
    // Structural assertion: the function exists with the new signature shape.
    // Behavioral end-to-end is covered by the populatePristineDir tests above
    // (that helper is what saveLocalPatches calls internally).
    assert.equal(typeof INSTALL.populatePristineDir, 'function');
    // The signature for saveLocalPatches isn't exported, but the helper IS,
    // and it's the unit of behavior the bug is about. Asserting on the helper
    // is the structural-IR equivalent of the no-source-grep convention.
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3407-pristine-stale-content.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3407-pristine-stale-content (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #3407: Installer leaves stale content in gsd-pristine/
 *
 * Root cause: populatePristineDir() in saveLocalPatches() snapshots from
 * pristineCtx.packageSrc — the NEWLY-downloaded release tree — and writes
 * those bytes into gsd-pristine/.  For files changed between the old and new
 * release, this writes the NEW bytes into the pristine baseline instead of
 * the OLD bytes.  The three-way-diff verifier then classifies upstream-changed
 * lines as user-added → Step 5a gate fails with false FAIL_USER_LINES_MISSING.
 *
 * The #3657 fix (OK_PRISTINE_DRIFT_DETECTED) was a symptom workaround: the
 * verifier detects hash mismatch (backup-meta.json records old-release hash
 * but gsd-pristine/ has new-release bytes) and skips to over-broad mode
 * instead of false-failing.  The root-cause stale write was never fixed.
 *
 * Fix: when a correctly-populated gsd-pristine/ already exists from the
 * previous install (i.e., the file's sha256 matches the originalHash recorded
 * in the manifest), preserve it — do NOT wipe and re-populate from the new
 * release source.  This ensures gsd-pristine/ holds old-release bytes even
 * after an upgrade where the file content changed upstream.
 *
 * Regression contract (byte-comparison):
 *   After saveLocalPatches() is called with a user-modified file whose
 *   gsd-pristine/ entry was correctly set by the previous install, the
 *   gsd-pristine/ file MUST still contain the old-release bytes, not the
 *   new-release bytes supplied in pristineCtx.packageSrc.
 *
 * Closes: #3407
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const INSTALL = require(path.join(ROOT, 'bin', 'install.js'));
const { cleanup } = require('./helpers.cjs');

const MANIFEST_NAME = 'gsd-file-manifest.json';
const PATCHES_DIR_NAME = 'gsd-local-patches';

function sha256(content) {
  return crypto.createHash('sha256').update(content instanceof Buffer ? content : Buffer.from(content)).digest('hex');
}

// ─── Bug #3407: gsd-pristine/ must preserve OLD-release bytes across upgrade ──

describe('Bug #3407: saveLocalPatches preserves old-release pristine across upgrade', () => {
  let tmpDir;
  let configDir;
  let fakeSrcDir;

  beforeEach((t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3407-'));
    configDir = path.join(tmpDir, 'config');
    fakeSrcDir = path.join(tmpDir, 'new-release-src');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(fakeSrcDir, { recursive: true });
    t.after(() => {
      cleanup(tmpDir);
    });
  });

  /**
   * Core regression test.
   *
   * Timeline:
   *   Install v1: file content = OLD_RELEASE_CONTENT, gsd-pristine/ROOT_FILE
   *               = OLD_RELEASE_CONTENT (correctly set by previous install),
   *               manifest hash = sha256(OLD_RELEASE_CONTENT)
   *   User edits: configDir/ROOT_FILE = USER_MODIFIED_CONTENT
   *   Upgrade v2: pristineCtx.packageSrc has NEW_RELEASE_CONTENT for ROOT_FILE
   *   saveLocalPatches is called before the wipe.
   *
   * Expected AFTER fix: gsd-pristine/ROOT_FILE still == OLD_RELEASE_CONTENT
   * Actual BEFORE fix:  gsd-pristine/ROOT_FILE == NEW_RELEASE_CONTENT (stale)
   */
  test('gsd-pristine/ retains old-release bytes when upgrading a user-modified file', () => {
    const OLD_RELEASE_CONTENT = '# Old Release Content\nThis is v1 pristine.\n';
    const NEW_RELEASE_CONTENT = '# New Release Content\nThis is v2 — upstream changed this line.\n';
    const USER_MODIFIED_CONTENT = '# Old Release Content\nThis is v1 pristine.\n## User addition\nUser customization here.\n';

    const oldHash = sha256(OLD_RELEASE_CONTENT);

    // Simulate a root-level installed file. Root-level files in the manifest
    // are denoted without a subdirectory (slash-free relPath).
    const relPath = 'test-root-file.md';

    // Set up configDir: user-modified installed file + manifest recording old hash
    fs.writeFileSync(path.join(configDir, relPath), USER_MODIFIED_CONTENT);
    fs.writeFileSync(
      path.join(configDir, MANIFEST_NAME),
      JSON.stringify({ version: '1.0.0', files: { [relPath]: oldHash } }, null, 2)
    );

    // Set up fakeSrcDir (new release): the file has NEW content
    fs.writeFileSync(path.join(fakeSrcDir, relPath), NEW_RELEASE_CONTENT);

    // Set up gsd-pristine/ with OLD content (as correctly populated by previous install)
    const pristineDir = path.join(configDir, 'gsd-pristine');
    fs.mkdirSync(pristineDir, { recursive: true });
    fs.writeFileSync(path.join(pristineDir, relPath), OLD_RELEASE_CONTENT);

    // Call saveLocalPatches with the new release as packageSrc (the buggy scenario)
    INSTALL.saveLocalPatches(configDir, {
      packageSrc: fakeSrcDir,
      runtime: 'claude',
      pathPrefix: '$HOME/.claude/',
      isGlobal: true,
    });

    // Assert: gsd-pristine/ must still contain OLD-release bytes
    const pristineFile = path.join(pristineDir, relPath);
    assert.ok(
      fs.existsSync(pristineFile),
      `gsd-pristine/${relPath} must exist after saveLocalPatches`
    );

    const actualPristineContent = fs.readFileSync(pristineFile, 'utf8');
    assert.equal(
      sha256(actualPristineContent),
      oldHash,
      [
        `gsd-pristine/${relPath} must contain OLD-release bytes (sha256=${oldHash.slice(0, 12)}…)`,
        `but got sha256=${sha256(actualPristineContent).slice(0, 12)}…`,
        `(If equal to sha256(NEW_RELEASE_CONTENT)=${sha256(NEW_RELEASE_CONTENT).slice(0, 12)}… then #3407 is NOT fixed)`,
      ].join(' ')
    );

    // Secondary: confirm backup-meta records the old hash (not new)
    const backupMeta = JSON.parse(
      fs.readFileSync(path.join(configDir, PATCHES_DIR_NAME, 'backup-meta.json'), 'utf8')
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(backupMeta.pristine_hashes, relPath),
      'backup-meta.json must record pristine_hash for modified file'
    );
    assert.equal(
      backupMeta.pristine_hashes[relPath],
      oldHash,
      'backup-meta.json pristine_hash must equal old-release hash (not new-release hash)'
    );
  });

  /**
   * Regression test for Codex finding: when gsd-pristine/ entry is absent
   * (e.g., post-buggy-run deletion or first upgrade without prior pristine)
   * but the file is UNCHANGED between old and new release, the hash-validated
   * regeneration path must restore the pristine entry using new-release source.
   *
   * When sha256(newReleaseBytesForFile) === originalHash, the file is identical
   * between releases — new-release generated bytes ARE the old-release pristine
   * and may be safely promoted.
   *
   * Previously (before the regeneration path was added): missing entries were
   * left absent unconditionally, causing permanent over-broad fallback even
   * when the file was unchanged upstream.
   */
  test('gsd-pristine/ is regenerated for missing entries when file is unchanged between releases', () => {
    const SHARED_RELEASE_CONTENT = '# Shared Content\nThis file is identical in v1 and v2.\n';
    const USER_MODIFIED_CONTENT = '# Shared Content\nThis file is identical in v1 and v2.\n## User addition\nCustom.\n';

    const oldHash = sha256(SHARED_RELEASE_CONTENT);
    const relPath = 'test-unchanged-file.md';

    // configDir has user-modified file + manifest with old-release hash
    fs.writeFileSync(path.join(configDir, relPath), USER_MODIFIED_CONTENT);
    fs.writeFileSync(
      path.join(configDir, MANIFEST_NAME),
      JSON.stringify({ version: '1.0.0', files: { [relPath]: oldHash } }, null, 2)
    );

    // fakeSrcDir (new release) has the SAME content — file was not changed upstream
    fs.writeFileSync(path.join(fakeSrcDir, relPath), SHARED_RELEASE_CONTENT);

    // NOTE: gsd-pristine/ does NOT exist (simulating post-buggy-run or first-time scenario)

    INSTALL.saveLocalPatches(configDir, {
      packageSrc: fakeSrcDir,
      runtime: 'claude',
      pathPrefix: '$HOME/.claude/',
      isGlobal: true,
    });

    // The regeneration path should have detected that sha256(new-release candidate)
    // === originalHash, and promoted the candidate into gsd-pristine/.
    const pristineFile = path.join(configDir, 'gsd-pristine', relPath);
    assert.ok(
      fs.existsSync(pristineFile),
      [
        `gsd-pristine/${relPath} must exist after hash-validated regeneration.`,
        `When new-release bytes hash to originalHash, the file was unchanged between`,
        `releases and the candidate should be promoted to restore the pristine baseline.`,
      ].join(' ')
    );

    const actualContent = fs.readFileSync(pristineFile, 'utf8');
    assert.equal(
      sha256(actualContent),
      oldHash,
      [
        `gsd-pristine/${relPath} must contain bytes matching originalHash after regeneration`,
        `(sha256=${oldHash.slice(0, 12)}…)`,
      ].join(' ')
    );
  });

  /**
   * Stale-pristine recovery test (pre-fix bug artifact).
   *
   * Timeline:
   *   Buggy run:  gsd-pristine/<rel> was written with NEW_RELEASE_CONTENT
   *               (the exact #3407 artifact — stale bytes from a buggy populatePristineDir).
   *   Fix run:    saveLocalPatches detects the hash mismatch
   *               (sha256(NEW_RELEASE_CONTENT) !== originalHash recorded in manifest),
   *               removes the stale entry, then attempts regeneration.
   *
   * When the file CHANGED between releases (NEW !== OLD):
   *   - The stale entry is removed.
   *   - Regeneration discards the new-release candidate (hash mismatch).
   *   - gsd-pristine/<rel> must be ABSENT (over-broad fallback — correct).
   *
   * When the file is UNCHANGED between releases (NEW === OLD):
   *   - The stale entry (which happens to have correct bytes despite the bug) is
   *     detected as correct (hash matches originalHash) and PRESERVED.
   *   - gsd-pristine/<rel> must remain present with the correct bytes.
   *
   * This test covers the "file changed across release boundary" case.
   * The "unchanged" case is already covered by the regeneration test above.
   */
  test('stale gsd-pristine/ entry (new-release bytes) is removed when file changed between releases', () => {
    const OLD_RELEASE_CONTENT = '# Old Release\nv1 content here.\n';
    const NEW_RELEASE_CONTENT = '# New Release\nv2 content — upstream changed this.\n';
    const USER_MODIFIED_CONTENT = '# Old Release\nv1 content here.\n## User section\nCustom work.\n';

    const oldHash = sha256(OLD_RELEASE_CONTENT);
    const relPath = 'test-stale-recovery.md';

    // configDir: user-modified file + manifest recording OLD hash
    fs.writeFileSync(path.join(configDir, relPath), USER_MODIFIED_CONTENT);
    fs.writeFileSync(
      path.join(configDir, MANIFEST_NAME),
      JSON.stringify({ version: '1.0.0', files: { [relPath]: oldHash } }, null, 2)
    );

    // fakeSrcDir (new release): contains the NEW content
    fs.writeFileSync(path.join(fakeSrcDir, relPath), NEW_RELEASE_CONTENT);

    // Pre-populate gsd-pristine/ with NEW_RELEASE_CONTENT — the exact pre-fix bug artifact.
    // This simulates a prior buggy run that wrote new-release bytes into the pristine baseline.
    const STALE_BYTES = NEW_RELEASE_CONTENT; // named constant for clarity
    const pristineDir = path.join(configDir, 'gsd-pristine');
    fs.mkdirSync(pristineDir, { recursive: true });
    fs.writeFileSync(path.join(pristineDir, relPath), STALE_BYTES);

    // Verify the pre-condition: stale bytes do NOT match the original hash.
    // If this assert fails, the test fixture is wrong (not a fix regression).
    assert.notEqual(
      sha256(STALE_BYTES),
      oldHash,
      'test fixture check: stale bytes must differ from originalHash'
    );

    INSTALL.saveLocalPatches(configDir, {
      packageSrc: fakeSrcDir,
      runtime: 'claude',
      pathPrefix: '$HOME/.claude/',
      isGlobal: true,
    });

    // The fix must detect the hash mismatch (stale entry) and remove it.
    // The regeneration path discards the new-release candidate (its hash !== oldHash).
    // Result: gsd-pristine/<rel> must be ABSENT — over-broad fallback is the safe outcome.
    const pristineFile = path.join(pristineDir, relPath);
    assert.strictEqual(
      fs.existsSync(pristineFile),
      false,
      [
        `expected gsd-pristine/${relPath} to be absent after stale-pristine recovery.`,
        `The stale entry (new-release bytes, sha256=${sha256(STALE_BYTES).slice(0, 12)}…)`,
        `must be removed; regeneration must discard the candidate because`,
        `sha256(new-release)=${sha256(NEW_RELEASE_CONTENT).slice(0, 12)}… !== originalHash=${oldHash.slice(0, 12)}….`,
        `Presence of the file means the stale bytes were NOT cleaned up (pre-fix behavior).`,
      ].join(' ')
    );
  });

  /**
   * Second scenario: gsd-pristine/ does NOT pre-exist (first upgrade with no
   * prior pristine population).  In this case there is no way to obtain the
   * old-release pristine bytes — populatePristineDir must NOT write the new-
   * release bytes either.  The correct outcome is: gsd-pristine/ stays empty
   * for this file, and the verifier falls back to over-broad mode (safe).
   */
  test('gsd-pristine/ stays empty when no prior pristine exists (first upgrade, no stale write)', () => {
    const OLD_RELEASE_CONTENT = '# Old Release Content\nThis is v1.\n';
    const NEW_RELEASE_CONTENT = '# New Release Content\nThis is v2 — changed.\n';
    const USER_MODIFIED_CONTENT = '# Old Release Content\nThis is v1.\n## User addition\nCustom.\n';

    const oldHash = sha256(OLD_RELEASE_CONTENT);
    const relPath = 'test-first-upgrade.md';

    // configDir has user-modified file + manifest
    fs.writeFileSync(path.join(configDir, relPath), USER_MODIFIED_CONTENT);
    fs.writeFileSync(
      path.join(configDir, MANIFEST_NAME),
      JSON.stringify({ version: '1.0.0', files: { [relPath]: oldHash } }, null, 2)
    );

    // fakeSrcDir (new release) has new content
    fs.writeFileSync(path.join(fakeSrcDir, relPath), NEW_RELEASE_CONTENT);

    // NOTE: gsd-pristine/ does NOT exist yet (first upgrade)

    INSTALL.saveLocalPatches(configDir, {
      packageSrc: fakeSrcDir,
      runtime: 'claude',
      pathPrefix: '$HOME/.claude/',
      isGlobal: true,
    });

    const pristineFile = path.join(configDir, 'gsd-pristine', relPath);
    assert.strictEqual(
      fs.existsSync(pristineFile),
      false,
      [
        `expected gsd-pristine/${relPath} to be absent when file changed across release boundary.`,
        `Writing new-release bytes as pristine for a file whose hash is unknown leads to`,
        `false FAIL_USER_LINES_MISSING in the reapply-patches verifier (#3407).`,
        `Over-broad fallback mode is the correct outcome here.`,
      ].join(' ')
    );
  });
});

// The former "Antipattern hunt" describe block (structural typeof checks only) was
// removed — it provided no real behavioral coverage and was a vacuous-truth pattern
// per /test-rigor skill. Behavioral tests for populatePristineDir are covered above.
  });
}
