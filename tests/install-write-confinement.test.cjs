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
