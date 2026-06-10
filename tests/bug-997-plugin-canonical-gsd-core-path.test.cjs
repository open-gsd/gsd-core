'use strict';

/**
 * Regression tests for #997.
 *
 * GSD's bundled agents/commands/templates @-include the canonical path
 * `~/.claude/gsd-core/...`. A classic `bin/install.js` install populates that
 * directory; a Claude Code *marketplace plugin* install never does (the plugin
 * manager only unpacks into the version-pinned cache and never runs
 * install.js), so every @-include resolves to nothing and gsd agents fail.
 *
 * The SessionStart hook hooks/gsd-ensure-canonical-path.js bridges the gap by
 * making ~/.claude/gsd-core a real directory whose immutable bundled subdirs
 * are symlinked to the plugin's bundled gsd-core/ tree. These tests drive the
 * hook in a sandboxed HOME against a throwaway plugin layout.
 *
 * Cross-platform note: on Windows the hook creates directory *junctions*, which
 * lstat() does not report as symlinks, so link-ness is asserted via realpath
 * equality (resolves both symlinks and junctions) rather than isSymbolicLink().
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const helpers = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'gsd-ensure-canonical-path.js');
const SUBDIRS = ['references', 'workflows', 'templates', 'contexts', 'bin'];

// Throwaway plugin layout: <root>/plugin/hooks/<hook> + <root>/plugin/gsd-core/<subdirs>,
// with HOME pointed at <root>/home so the hook writes to <home>/.claude/gsd-core.
function makeSandbox(prefix = 'gsd-canonical-') {
  const tmp = helpers.createTempDir(prefix);
  const pluginRoot = path.join(tmp, 'plugin');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true });
  for (const sub of SUBDIRS) {
    fs.mkdirSync(path.join(pluginRoot, 'gsd-core', sub), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'gsd-core', sub, 'probe.md'), `# ${sub} probe\n`);
  }
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.copyFileSync(HOOK_SRC, path.join(pluginRoot, 'hooks', 'gsd-ensure-canonical-path.js'));
  return { tmp, pluginRoot, home };
}

function runHook(hookPath, home) {
  execFileSync('node', [hookPath], { env: { ...process.env, HOME: home, USERPROFILE: home } });
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; }
}
function linksTo(linkPath, targetPath) {
  return fs.realpathSync(linkPath) === fs.realpathSync(targetPath);
}

describe('#997: plugin install canonical ~/.claude/gsd-core path', () => {
  test('bridges bundled subdirs so @-includes resolve', () => {
    const { tmp, pluginRoot, home } = makeSandbox();
    try {
      runHook(path.join(pluginRoot, 'hooks', 'gsd-ensure-canonical-path.js'), home);
      const canonical = path.join(home, '.claude', 'gsd-core');
      for (const sub of SUBDIRS) {
        const entry = path.join(canonical, sub);
        const bundled = path.join(pluginRoot, 'gsd-core', sub);
        assert.ok(linksTo(entry, bundled), `${sub} should resolve to the bundled dir`);
        const probe = path.join(entry, 'probe.md');
        assert.ok(fs.existsSync(probe), `@~/.claude/gsd-core/${sub}/probe.md should resolve`);
        assert.equal(fs.readFileSync(probe, 'utf8'), `# ${sub} probe\n`);
      }
    } finally {
      helpers.cleanup(tmp);
    }
  });

  test('is idempotent', () => {
    const { tmp, pluginRoot, home } = makeSandbox();
    try {
      const hook = path.join(pluginRoot, 'hooks', 'gsd-ensure-canonical-path.js');
      runHook(hook, home);
      runHook(hook, home);
      const refs = path.join(home, '.claude', 'gsd-core', 'references');
      assert.ok(linksTo(refs, path.join(pluginRoot, 'gsd-core', 'references')));
      assert.ok(fs.existsSync(path.join(refs, 'probe.md')));
    } finally {
      helpers.cleanup(tmp);
    }
  });

  test('prunes dangling symlinks left by an older bundle version', () => {
    const { tmp, pluginRoot, home } = makeSandbox();
    try {
      const hook = path.join(pluginRoot, 'hooks', 'gsd-ensure-canonical-path.js');
      runHook(hook, home);
      const dangling = path.join(home, '.claude', 'gsd-core', 'removed-in-new-version');
      fs.symlinkSync(path.join(tmp, 'does-not-exist'), dangling);
      runHook(hook, home);
      assert.ok(!fs.existsSync(dangling) && !isLink(dangling), 'dangling link should be pruned');
    } finally {
      helpers.cleanup(tmp);
    }
  });

  test('preserves real user-generated top-level files', () => {
    const { tmp, pluginRoot, home } = makeSandbox();
    try {
      const hook = path.join(pluginRoot, 'hooks', 'gsd-ensure-canonical-path.js');
      runHook(hook, home);
      const profile = path.join(home, '.claude', 'gsd-core', 'USER-PROFILE.md');
      fs.writeFileSync(profile, 'my profile\n');
      runHook(hook, home);
      assert.ok(!isLink(profile), 'USER-PROFILE.md must stay a real file');
      assert.equal(fs.readFileSync(profile, 'utf8'), 'my profile\n');
    } finally {
      helpers.cleanup(tmp);
    }
  });

  test('no-op when the bundled tree already is the canonical path (classic install)', () => {
    // Classic install: plugin root = <home>/.claude, so the bundled gsd-core
    // lives at <home>/.claude/gsd-core (== canonical). The hook must not
    // convert the real dirs into self-referential symlinks.
    const tmp = helpers.createTempDir('gsd-canonical-classic-');
    try {
      const home = path.join(tmp, 'home');
      const claude = path.join(home, '.claude');
      fs.mkdirSync(path.join(claude, 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(claude, 'gsd-core', 'references'), { recursive: true });
      fs.writeFileSync(path.join(claude, 'gsd-core', 'references', 'real.md'), 'real\n');
      const hook = path.join(claude, 'hooks', 'gsd-ensure-canonical-path.js');
      fs.copyFileSync(HOOK_SRC, hook);
      runHook(hook, home);
      const refs = path.join(claude, 'gsd-core', 'references');
      assert.ok(!isLink(refs) && fs.statSync(refs).isDirectory(),
        'classic-install dirs must remain real, not symlinked');
      assert.equal(fs.readFileSync(path.join(refs, 'real.md'), 'utf8'), 'real\n');
    } finally {
      helpers.cleanup(tmp);
    }
  });

  describe('wiring', () => {
    test('registered as a SessionStart hook in hooks.json', () => {
      const hooksJson = require(path.join(REPO_ROOT, 'hooks', 'hooks.json'));
      const cmds = hooksJson.hooks.SessionStart.flatMap(g => g.hooks.map(h => h.command));
      assert.ok(cmds.some(c => c.includes('gsd-ensure-canonical-path.js')),
        'gsd-ensure-canonical-path.js must be wired as a SessionStart hook');
    });
    test('listed in MANAGED_HOOKS', () => {
      const { MANAGED_HOOKS } = require(path.join(REPO_ROOT, 'hooks', 'managed-hooks-registry.cjs'));
      assert.ok(MANAGED_HOOKS.includes('gsd-ensure-canonical-path.js'));
    });
    test('listed in build-hooks HOOKS_TO_COPY', () => {
      const { HOOKS_TO_COPY } = require(path.join(REPO_ROOT, 'scripts', 'build-hooks.js'));
      assert.ok(HOOKS_TO_COPY.includes('gsd-ensure-canonical-path.js'));
    });
  });
});
