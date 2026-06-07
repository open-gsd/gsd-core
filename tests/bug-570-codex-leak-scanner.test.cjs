// allow-test-rule: source-text-is-the-product
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Regression tests for issue #570 — three related sub-bugs in the Codex leak
 * scanner and supporting infrastructure.
 *
 * SUB-BUG A: scanForLeakedPaths recursively scans the entire targetDir,
 *   including pre-existing unrelated files that contain ~/.claude references.
 *   Fix: scan only files listed in gsd-file-manifest.json.
 *
 * SUB-BUG B: convertClaudeToCodexMarkdown replaces "~/.claude/" (with trailing
 *   slash) but NOT bare "~/.claude" (no slash). The scanner regex
 *   /(?:~|\$HOME)\/\.claude\b/ matches without trailing slash.
 *   Fix: add bare word-boundary replacement.
 *
 * SUB-BUG C: writeManifest checks file.endsWith('.md') for the agents/
 *   directory. Codex installs .toml agent files, so they are invisible to the
 *   manifest and thus to any manifest-based scan fix.
 *   Fix: also check .toml.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  install,
  convertClaudeCommandToCodexSkill,
} = require('../bin/install.js');
const { createTempDir, cleanup, captureConsole } = require('./helpers.cjs');

const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');

function withCodexHome(codexHome, fn) {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
}

describe('#570 — Codex leak scanner sub-bugs', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
    }
    tmpRoot = createTempDir('gsd-570-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  // SUB-BUG B
  test('convertClaudeToCodexMarkdown replaces bare ~/.claude (no trailing slash)', () => {
    // convertClaudeToCodexMarkdown is not exported directly; exercise it via
    // convertClaudeCommandToCodexSkill which calls it internally.
    const input = 'configDir = ~/.claude\npath = ~/.claude/hooks/\ndir = $HOME/.claude';
    const out = convertClaudeCommandToCodexSkill(input, 'gsd-test');

    assert.ok(
      !/(?:~|\$HOME)\/\.claude\b/.test(out),
      `Expected no leaked ~/.claude reference after conversion, got:\n${out}`,
    );
  });

  // SUB-BUG C
  test('writeManifest includes .toml agent files for Codex', () => {
    withCodexHome(codexHome, () => install(true, 'codex'));

    const agentsDir = path.join(codexHome, 'agents');
    // Confirm that Codex actually wrote .toml agent files — if none exist the
    // test is vacuous and we should fail loudly.
    const tomlFiles = fs.existsSync(agentsDir)
      ? fs.readdirSync(agentsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.toml'))
      : [];
    assert.ok(
      tomlFiles.length > 0,
      `Precondition: Codex install must write at least one gsd-*.toml in agents/; found none in ${agentsDir}`,
    );

    const manifestPath = path.join(codexHome, 'gsd-file-manifest.json');
    assert.ok(
      fs.existsSync(manifestPath),
      `gsd-file-manifest.json must exist after install; not found at ${manifestPath}`,
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifestKeys = Object.keys(manifest.files || {});

    const tomlManifestKeys = manifestKeys.filter(
      (k) => k.startsWith('agents/gsd-') && k.endsWith('.toml'),
    );
    assert.ok(
      tomlManifestKeys.length > 0,
      `Expected at least one 'agents/gsd-*.toml' key in manifest.files, but found none.\n` +
        `agents/ toml files on disk: ${tomlFiles.join(', ')}\n` +
        `All manifest keys (agents/): ${manifestKeys.filter((k) => k.startsWith('agents/')).join(', ')}`,
    );
  });

  // SUB-BUG A
  test('scanForLeakedPaths does not warn for pre-existing unrelated files in ~/.codex', () => {
    // Write a pre-existing file with ~/.claude references BEFORE install.
    const memoriesDir = path.join(codexHome, 'memories');
    fs.mkdirSync(memoriesDir, { recursive: true });
    const preExistingFile = path.join(memoriesDir, 'raw_memories.md');
    fs.writeFileSync(
      preExistingFile,
      '# Old memories\nI used to work in ~/.claude and $HOME/.claude regularly.\n',
    );

    let captured;
    withCodexHome(codexHome, () => {
      captured = captureConsole(() => install(true, 'codex'));
    });

    const combinedOutput = captured.stderr;

    assert.ok(
      !combinedOutput.includes('memories/raw_memories.md'),
      `scanForLeakedPaths must not warn about pre-existing unrelated file memories/raw_memories.md.\n` +
        `Actual warnings:\n${combinedOutput}`,
    );
  });
});
