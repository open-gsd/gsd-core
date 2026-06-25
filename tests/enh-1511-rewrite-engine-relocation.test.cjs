'use strict';
/**
 * Tests for ADR-1508 Phase 2: rewrite engine relocation to runtime-artifact-conversion.
 * Issue #1511 — verifies the deep public seam signatures and behavior.
 *
 * Tests are behavioral (no source-grep). All filesystem operations use tmp dirs.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

let conversion;
before(() => {
  process.env['GSD_TEST_MODE'] = '1';
  conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
});

// ---------------------------------------------------------------------------
// _computePathPrefix unit tests
// ---------------------------------------------------------------------------

describe('_computePathPrefix', () => {
  test('global under home → $HOME/... form', () => {
    const prefix = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: '/home/u/.cursor',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '$HOME/.cursor/');
  });

  test('non-global → resolvedTarget/ form', () => {
    const prefix = conversion._computePathPrefix({
      isGlobal: false,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: '/project/.cursor',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '/project/.cursor/');
  });

  test('global opencode skips $HOME shorthand', () => {
    // OpenCode uses ~/.config/opencode which breaks $HOME shorthand in content
    const prefix = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: true,
      isWindowsHost: false,
      resolvedTarget: '/home/u/.config/opencode',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '/home/u/.config/opencode/');
  });

  test('global target outside home → resolvedTarget/ form', () => {
    const prefix = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: '/opt/custom-cursor',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '/opt/custom-cursor/');
  });

  test('isWindowsHost tripwire — Windows paths collapse to $HOME/ same as POSIX (no-op today)', () => {
    // Documents CURRENT behavior: isWindowsHost is accepted but not branched on.
    // Both win32=true and win32=false return '$HOME/.cursor/' for a home-relative target.
    // If a future Windows-specific branch is added, this tripwire fails and forces
    // an explicit decision about what to return on Windows.
    const withWindows = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: true,
      resolvedTarget: 'C:/Users/matte/.cursor',
      homeDir: 'C:/Users/matte',
    });
    const withoutWindows = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: 'C:/Users/matte/.cursor',
      homeDir: 'C:/Users/matte',
    });
    assert.equal(withWindows, '$HOME/.cursor/');
    assert.strictEqual(withWindows, withoutWindows);
  });

  test('backslash-style resolvedTarget is normalized to forward slashes (#1615 regression)', () => {
    // path.join on Windows produces backslashes; the returned prefix is
    // substituted into markdown @-references which must use POSIX paths.
    // Without normalization the backslashes leak into workflow file content
    // and break substring checks on Windows CI.
    const prefix = conversion._computePathPrefix({
      isGlobal: false,
      isOpencode: false,
      isWindowsHost: true,
      resolvedTarget: 'C:\\Users\\runner\\AppData\\Local\\Temp\\gsd-1615-windsurf',
      homeDir: 'C:\\Users\\runner',
    });
    assert.strictEqual(prefix, 'C:/Users/runner/AppData/Local/Temp/gsd-1615-windsurf/');
    assert.ok(!prefix.includes('\\'), `prefix must not contain backslashes: ${prefix}`);
  });
});

// ---------------------------------------------------------------------------
// _applyRuntimeRewrites with injected attribution
// ---------------------------------------------------------------------------

describe('_applyRuntimeRewrites — attribution injection', () => {
  const PREFIX = '$HOME/.cursor/';

  test('attribution=null removes Co-Authored-By line', () => {
    const content = '# Hello\n\nSome text\n\nCo-Authored-By: Claude\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', PREFIX, true, null);
    assert.ok(!result.includes('Co-Authored-By:'), 'Co-Authored-By should be removed');
  });

  test('attribution=undefined leaves Co-Authored-By unchanged', () => {
    const content = '# Hello\n\nCo-Authored-By: Claude\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', PREFIX, true, undefined);
    assert.ok(result.includes('Co-Authored-By: Claude'), 'Co-Authored-By should be preserved when attribution=undefined');
  });

  test('attribution=string replaces Co-Authored-By value', () => {
    const content = '# Hello\n\nCo-Authored-By: OldName\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', PREFIX, true, 'NewName <new@example.com>');
    assert.ok(result.includes('Co-Authored-By: NewName <new@example.com>'), 'Co-Authored-By should be replaced');
  });

  test('cursor runtime replaces ~/.claude/ paths', () => {
    const content = 'See ~/.claude/skills/ for more info\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', '/home/u/.cursor/', false, undefined);
    assert.ok(result.includes('/home/u/.cursor/skills/'), 'cursor should replace ~/.claude/ with pathPrefix');
  });
});

// ---------------------------------------------------------------------------
// rewriteStagedSkillBodies — behavioral filesystem test
// ---------------------------------------------------------------------------

describe('rewriteStagedSkillBodies', () => {
  test('rewrites .md files in-place for cursor runtime', () => {
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-staged-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-config-'));
    try {
      // Create a skill dir with a SKILL.md referencing ~/.claude/skills/foo
      // NOTE: the rewrite engine handles path replacement and attribution only.
      // Bash→Shell conversion is done by the stage-1 skill converter, not the engine.
      const skillDir = path.join(stagedDir, 'gsd-test-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      const content = '# Test\n\nSee ~/.claude/skills/foo\n\nAlso ~/.cursor/skills/bar\n';
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);

      // Call with injected homedir + platform for determinism
      conversion.rewriteStagedSkillBodies(stagedDir, {
        runtime: 'cursor',
        configDir,
        scope: 'global',
        homedir: () => '/home/u',
        platform: 'linux',
      });

      const result = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      // cursor rewrites ~/.claude/ → pathPrefix
      // configDir is a tmpdir, not under /home/u, so prefix = resolvedTarget + '/'
      // Mirror the engine's backslash→slash normalization so the assertion holds on Windows.
      const resolvedTarget = path.resolve(configDir).replace(/\\/g, '/');
      assert.ok(result.includes(`${resolvedTarget}/skills/foo`), `Should replace ~/.claude/skills/ with ${resolvedTarget}/skills/`);
      // cursor also rewrites ~/.cursor/ → pathPrefix
      assert.ok(result.includes(`${resolvedTarget}/skills/bar`), `Should replace ~/.cursor/skills/ with ${resolvedTarget}/skills/`);
    } finally {
      cleanup(stagedDir);
      cleanup(configDir);
    }
  });

  test('with injected homedir: global under home uses $HOME prefix', () => {
    // Real absolute path so Windows path.resolve does not re-root a POSIX literal onto a drive.
    // The dir need not exist — the engine only string-processes it.
    const HOME = path.resolve(os.tmpdir(), 'gsd-1511-fake-home');
    const configDir = path.join(HOME, '.cursor');
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-staged-'));
    try {
      const skillDir = path.join(stagedDir, 'gsd-help');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'Use ~/.claude/skills/ here\n');

      conversion.rewriteStagedSkillBodies(stagedDir, {
        runtime: 'cursor',
        configDir,
        scope: 'global',
        homedir: () => HOME,
        platform: process.platform,
      });

      const result = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      assert.ok(result.includes('$HOME/.cursor/skills/'), 'Should use $HOME shorthand when configDir is under homedir');
    } finally {
      cleanup(stagedDir);
    }
  });

  test('non-existent stagedDir is a no-op', () => {
    assert.doesNotThrow(() => {
      conversion.rewriteStagedSkillBodies('/nonexistent/dir', {
        runtime: 'cursor',
        configDir: '/tmp/fake',
        scope: 'global',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// rewriteStagedCommandBodies — returns temp dir, does not mutate source
// ---------------------------------------------------------------------------

describe('rewriteStagedCommandBodies', () => {
  test('returns a temp dir (not the source dir) with rewritten content', () => {
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-cmd-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-config-'));
    let tempDir;
    try {
      // NOTE: rewrite engine handles path replacement + attribution, NOT tool renames.
      fs.writeFileSync(path.join(stagedDir, 'help.md'), '# Help\n\nSee ~/.claude/skills/\n\nSee ~/.cursor/skills/\n');

      tempDir = conversion.rewriteStagedCommandBodies(stagedDir, {
        runtime: 'cursor',
        configDir,
        scope: 'global',
        homedir: () => '/home/u',
        platform: 'linux',
      });

      assert.notEqual(tempDir, stagedDir, 'must return a different dir, never the source');
      assert.ok(fs.existsSync(tempDir), 'returned tempDir should exist');

      const result = fs.readFileSync(path.join(tempDir, 'help.md'), 'utf8');
      // Source dir should be unchanged
      const source = fs.readFileSync(path.join(stagedDir, 'help.md'), 'utf8');
      assert.ok(source.includes('~/.claude/skills/'), 'source file must not be mutated');
      // configDir is /tmp/... (not under /home/u), so prefix = resolvedTarget + '/'
      const resolvedTarget = path.resolve(configDir).replace(/\\/g, '/');
      assert.ok(result.includes(`${resolvedTarget}/skills/`), 'output should have cursor path rewrite applied');
      // ~/.cursor/ also rewrites to prefix
      assert.ok(!result.includes('~/.cursor/'), 'output should have ~/.cursor/ replaced too');
    } finally {
      cleanup(stagedDir);
      cleanup(configDir);
      if (tempDir && tempDir !== stagedDir) {
        cleanup(tempDir);
      }
    }
  });

  test('non-existent stagedDir returns stagedDir unchanged (safe)', () => {
    const result = conversion.rewriteStagedCommandBodies('/nonexistent/dir', {
      runtime: 'cursor',
      configDir: '/tmp/fake',
      scope: 'global',
    });
    assert.equal(result, '/nonexistent/dir', 'should return input path unchanged for missing dir');
  });
});

// ---------------------------------------------------------------------------
// Error-path: applyRuntimeContentRewritesForCommandsInPlace must rm the tempDir
// on any exception and NOT leave an orphaned gsd-cmd-rewrites-* directory.
// ---------------------------------------------------------------------------

describe('applyRuntimeContentRewritesForCommandsInPlace — error-path tempDir cleanup', () => {
  test('rmSync is called on the tempDir when readFileSync throws (deterministic monkeypatch)', () => {
    // Asserting the injected error propagates proves the throw happens AFTER the tempDir is
    // created (the function creates tempDir, then reads .md), so the catch's rmSync cleanup
    // is genuinely exercised — deterministic on every platform/uid.
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-error-path-'));
    fs.writeFileSync(path.join(stagedDir, 'x.md'), '# test\n');

    const before = new Set(
      fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('gsd-cmd-rewrites-'))
    );

    const origReadFileSync = fs.readFileSync;
    let leaked = [];
    try {
      fs.readFileSync = () => { throw new Error('injected read failure'); };

      assert.throws(
        () => conversion.applyRuntimeContentRewritesForCommandsInPlace(stagedDir, 'cursor', '/tmp/x/', false),
        /injected read failure/,
      );

      // Restore before any further fs use so the snapshot read is trustworthy.
      fs.readFileSync = origReadFileSync;

      const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('gsd-cmd-rewrites-'));
      leaked = after.filter(n => !before.has(n));
      assert.deepStrictEqual(leaked, [], `tempDir not cleaned up on error: ${leaked.join(',')}`);
    } finally {
      // Idempotent restore — guard against early-throw paths above.
      fs.readFileSync = origReadFileSync;
      // Clean up the staged dir created for this test.
      cleanup(stagedDir);
      // Clean up any genuinely leaked gsd-cmd-rewrites-* dirs so the runner stays clean.
      for (const n of leaked) {
        cleanup(path.join(os.tmpdir(), n));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Guard: runtime-artifact-layout no longer exports getInstallExports
// ---------------------------------------------------------------------------

describe('layout module no longer exports getInstallExports', () => {
  test('getInstallExports is not on the layout module export', () => {
    process.env['GSD_TEST_MODE'] = '1';
    const layout = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
    assert.equal(
      typeof layout.getInstallExports,
      'undefined',
      'getInstallExports should have been removed from runtime-artifact-layout exports (ADR-1508 Phase 2)',
    );
  });
});

// ---------------------------------------------------------------------------
// DEFECT.GENERATIVE-FIX: single-owner reference-identity guard (#1511)
// Proves install.js binds to the conversion module's implementation, not a
// duplicate local copy. If these fail, a duplicate body was re-introduced.
// ---------------------------------------------------------------------------

describe('single-owner reference-identity guard (ADR-1508 / #1511 Phase 2)', () => {
  let install;
  let conversionCjs;
  before(() => {
    process.env['GSD_TEST_MODE'] = '1';
    install = require('../bin/install.js');
    conversionCjs = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  });

  test('install.computePathPrefix === conversion._computePathPrefix (single implementation)', () => {
    assert.strictEqual(
      install.computePathPrefix,
      conversionCjs._computePathPrefix,
      'install.js must bind computePathPrefix from conversion (not a duplicate body)',
    );
  });

  test('install.applyRuntimeContentRewritesInPlace === conversion.applyRuntimeContentRewritesInPlace (single walk loop)', () => {
    assert.strictEqual(
      install.applyRuntimeContentRewritesInPlace,
      conversionCjs.applyRuntimeContentRewritesInPlace,
      'install.js must bind applyRuntimeContentRewritesInPlace from conversion (not a duplicate walk loop)',
    );
  });

  test('install.applyRuntimeContentRewritesForCommandsInPlace === conversion.applyRuntimeContentRewritesForCommandsInPlace (single copy+rewrite loop)', () => {
    assert.strictEqual(
      install.applyRuntimeContentRewritesForCommandsInPlace,
      conversionCjs.applyRuntimeContentRewritesForCommandsInPlace,
      'install.js must bind applyRuntimeContentRewritesForCommandsInPlace from conversion (not a duplicate copy+rewrite loop)',
    );
  });

  test('install._applyRuntimeRewrites === conversion._applyRuntimeRewrites (single switch engine)', () => {
    assert.strictEqual(
      install._applyRuntimeRewrites,
      conversionCjs._applyRuntimeRewrites,
      'install.js must bind _applyRuntimeRewrites from conversion (not a local shim)',
    );
  });

  // #1675 (ADR-1508): the augment converter family is single-sourced in the
  // conversion module. install.js must re-bind (not re-define) these so there
  // is exactly one body — the generative-drift hazard the dedup removes.
  test('install.convertClaudeToAugmentMarkdown === conversion.convertClaudeToAugmentMarkdown (single converter)', () => {
    assert.strictEqual(
      install.convertClaudeToAugmentMarkdown,
      conversionCjs.convertClaudeToAugmentMarkdown,
      'install.js must bind convertClaudeToAugmentMarkdown from conversion (not a duplicate body)',
    );
  });

  test('install.convertClaudeCommandToAugmentSkill === conversion.convertClaudeCommandToAugmentSkill (single converter)', () => {
    assert.strictEqual(
      install.convertClaudeCommandToAugmentSkill,
      conversionCjs.convertClaudeCommandToAugmentSkill,
      'install.js must bind convertClaudeCommandToAugmentSkill from conversion (not a duplicate body)',
    );
  });

  test('install.convertClaudeAgentToAugmentAgent === conversion.convertClaudeAgentToAugmentAgent (single converter)', () => {
    assert.strictEqual(
      install.convertClaudeAgentToAugmentAgent,
      conversionCjs.convertClaudeAgentToAugmentAgent,
      'install.js must bind convertClaudeAgentToAugmentAgent from conversion (not a duplicate body)',
    );
  });
});
