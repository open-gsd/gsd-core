// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression tests for bug #1991
 *
 * Cline is listed in GSD documentation as a supported runtime but was
 * completely absent from bin/install.js. Running `npx @opengsd/gsd-core`
 * did not show Cline as an option in the interactive menu.
 *
 * Fixed: Cline is now a first-class runtime that:
 * - Appears in the interactive menu and --all flag
 * - Supports the --cline CLI flag
 * - Writes .clinerules to the install directory
 * - Installs gsd-core/ engine with path replacement
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  getDirName,
  getConfigDirFromHome,
  convertClaudeToCliineMarkdown,
  install,
  finishInstall,
} = require('../bin/install.js');

const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');

describe('Cline runtime directory mapping', () => {
  test('getDirName returns .cline for local installs', () => {
    assert.strictEqual(getDirName('cline'), '.cline');
  });

  test('getGlobalConfigDir returns ~/.cline for global installs', () => {
    assert.strictEqual(getGlobalConfigDir('cline'), path.join(os.homedir(), '.cline'));
  });

  test('getConfigDirFromHome returns .cline fragment', () => {
    assert.strictEqual(getConfigDirFromHome('cline', false), "'.cline'");
    assert.strictEqual(getConfigDirFromHome('cline', true), "'.cline'");
  });
});

describe('getGlobalConfigDir (Cline)', () => {
  let originalClineConfigDir;

  beforeEach(() => {
    originalClineConfigDir = process.env.CLINE_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalClineConfigDir !== undefined) {
      process.env.CLINE_CONFIG_DIR = originalClineConfigDir;
    } else {
      delete process.env.CLINE_CONFIG_DIR;
    }
  });

  test('returns ~/.cline with no env var or explicit dir', () => {
    delete process.env.CLINE_CONFIG_DIR;
    const result = getGlobalConfigDir('cline');
    assert.strictEqual(result, path.join(os.homedir(), '.cline'));
  });

  test('returns explicit dir when provided', () => {
    const result = getGlobalConfigDir('cline', '/custom/cline-path');
    assert.strictEqual(result, '/custom/cline-path');
  });

  test('respects CLINE_CONFIG_DIR env var', () => {
    process.env.CLINE_CONFIG_DIR = '~/custom-cline';
    const result = getGlobalConfigDir('cline');
    assert.strictEqual(result, path.join(os.homedir(), 'custom-cline'));
  });

  test('explicit dir takes priority over CLINE_CONFIG_DIR', () => {
    process.env.CLINE_CONFIG_DIR = '~/from-env';
    const result = getGlobalConfigDir('cline', '/explicit/path');
    assert.strictEqual(result, '/explicit/path');
  });

  test('does not break other runtimes', () => {
    assert.strictEqual(getGlobalConfigDir('claude'), path.join(os.homedir(), '.claude'));
    assert.strictEqual(getGlobalConfigDir('codex'), path.join(os.homedir(), '.codex'));
  });
});

describe('Cline markdown conversion', () => {
  test('convertClaudeToCliineMarkdown exists and is a function', () => {
    assert.strictEqual(typeof convertClaudeToCliineMarkdown, 'function');
  });

  test('replaces Claude Code brand with Cline', () => {
    const result = convertClaudeToCliineMarkdown('Use Claude Code to run');
    assert.ok(!result.includes('Claude Code'));
    assert.ok(result.includes('Cline'));
  });

  test('replaces .claude/ paths with .cline/', () => {
    const result = convertClaudeToCliineMarkdown('See ~/.claude/gsd-core/');
    assert.ok(!result.includes('.claude/'), `Expected no .claude/ in: ${result}`);
    assert.ok(result.includes('.cline/'));
  });

  test('replaces CLAUDE.md references', () => {
    const result = convertClaudeToCliineMarkdown('See CLAUDE.md for config');
    assert.ok(!result.includes('CLAUDE.md'));
    assert.ok(result.includes('.clinerules'));
  });

  test('replaces .claude/skills/ with .cline/skills/', () => {
    const result = convertClaudeToCliineMarkdown('skills at .claude/skills/gsd-executor');
    assert.ok(!result.includes('.claude/skills/'));
    assert.ok(result.includes('.cline/skills/'));
  });
});

describe('Cline install (local)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-cline-test-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install creates .clinerules directory with gsd.md (#787 directory form)', () => {
    install(false, 'cline');
    const clinerulesDir = path.join(tmpDir, '.clinerules');
    assert.ok(fs.existsSync(clinerulesDir), '.clinerules must exist after cline install');
    assert.ok(fs.statSync(clinerulesDir).isDirectory(), '.clinerules must be a directory (#787)');
    assert.ok(fs.existsSync(path.join(clinerulesDir, 'gsd.md')), '.clinerules/gsd.md must exist');
  });

  test('.clinerules/gsd.md contains GSD instructions', () => {
    install(false, 'cline');
    const ruleFile = path.join(tmpDir, '.clinerules', 'gsd.md');
    const content = fs.readFileSync(ruleFile, 'utf8');
    assert.ok(content.includes('GSD') || content.includes('gsd'), '.clinerules/gsd.md must reference GSD');
  });

  test('install creates gsd-core engine directory', () => {
    install(false, 'cline');
    const engineDir = path.join(tmpDir, 'gsd-core');
    assert.ok(fs.existsSync(engineDir), 'gsd-core directory must exist after install');
  });

  test('finishInstall does not throw ERR_INVALID_ARG_TYPE for cline runtime (regression: null settingsPath guard)', () => {
    // install() returns settingsPath: null for cline — finishInstall() must not call
    // writeSettings(null, ...) or it crashes with ERR_INVALID_ARG_TYPE.
    // Before fix: isCline was missing from the writeSettings guard in finishInstall().
    // After fix:  !isCline is in the guard, matching codex/copilot/cursor/windsurf/trae.
    assert.doesNotThrow(
      () => finishInstall(null, null, null, false, 'cline', false, tmpDir),
      'finishInstall must not throw when called with null settingsPath for cline runtime'
    );
  });

  test('settings.json is not written for cline runtime', () => {
    finishInstall(null, null, null, false, 'cline', false, tmpDir);
    const settingsJson = path.join(tmpDir, 'settings.json');
    assert.ok(!fs.existsSync(settingsJson), 'settings.json must not be written for cline runtime');
  });

  test('installed engine files have no leaked .claude paths', () => {
    install(false, 'cline');
    const engineDir = path.join(tmpDir, 'gsd-core');
    if (!fs.existsSync(engineDir)) return; // skip if engine not installed

    function scanDir(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith('.md') || entry.name.endsWith('.cjs') || entry.name.endsWith('.js')) {
          // CHANGELOG.md is a historical record and is not path-converted — skip it
          if (entry.name === 'CHANGELOG.md') continue;
          // Converter source contains literal Claude source-path templates used before
          // runtime-specific install rewrites; this test is only for deployed Cline payload leaks.
          if (entry.name === 'runtime-artifact-conversion.cjs') continue;
          const content = fs.readFileSync(fullPath, 'utf8');
          // Check for GSD install paths that should have been substituted.
          // profile-pipeline.cjs intentionally references ~/.claude/projects (Claude Code
          // session data) as a runtime feature — that is not a leaked install path.
          const hasLeaked = /~\/\.claude\/(?:gsd-core|commands|agents|hooks)|HOME\/\.claude\/(?:gsd-core|commands|agents|hooks)/.test(content);
          assert.ok(!hasLeaked, `Found leaked GSD .claude install path in ${fullPath}`);
        }
      }
    }
    scanDir(engineDir);
  });
});
