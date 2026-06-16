// allow-test-rule: source-text-is-the-product
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Regression tests for issue #983 — Trae and Windsurf converters leak
 * unreplaced bare `~/.claude` / `$HOME/.claude` references.
 *
 * Both converters rewrote only trailing-slash `.claude/` forms, so bare
 * home-path references (configDir = ~/.claude, $HOME/.claude) survived
 * conversion and pointed users at the wrong config dir.
 *
 * Fix: add bare word-boundary replacements mirroring Cline (#782) and
 * Codex (#570) precedent, with a negative lookahead to preserve `.claude-plugin`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  convertClaudeToWindsurfMarkdown,
  convertClaudeToTraeMarkdown,
  _applyRuntimeRewrites,
} = require('../bin/install.js');

// ─── Windsurf converter bare-form tests ─────────────────────────────────────

describe('convertClaudeToWindsurfMarkdown — bare ~/.claude and CLAUDE_CONFIG_DIR (#983)', () => {
  test('bare ~/.claude rewritten to ~/.devin (#1085: workspace dir is now .devin)', () => {
    const input = 'Config dir: (~/.claude), skills at ~/.claude/skills';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('~/.devin'), 'must rewrite to ~/.devin');
  });

  test('$HOME/.claude rewritten to $HOME/.devin (#1085: workspace dir is now .devin)', () => {
    const input = 'RUNTIME_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('$HOME/.devin'), 'must rewrite to $HOME/.devin');
  });

  test('CLAUDE_CONFIG_DIR rewritten to WINDSURF_CONFIG_DIR', () => {
    const input = 'Use CLAUDE_CONFIG_DIR or $HOME/.claude to configure';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      result.includes('WINDSURF_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must become WINDSURF_CONFIG_DIR',
    );
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must be gone',
    );
  });

  test('.claude-plugin is NOT corrupted (preserved as-is)', () => {
    const input = 'The .claude-plugin/plugin.json manifest enables plugin install.';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      result.includes('.claude-plugin'),
      `.claude-plugin must be preserved; got: ${result}`,
    );
    assert.ok(
      !result.includes('.windsurf-plugin'),
      `.windsurf-plugin must not appear; got: ${result}`,
    );
  });

  test('no bare ~/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToWindsurfMarkdown(raw);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare ~/.claude',
    );
  });

  test('no $HOME/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToWindsurfMarkdown(raw);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare $HOME/.claude',
    );
  });

  test('no CLAUDE_CONFIG_DIR in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToWindsurfMarkdown(raw);
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'converted surface.md must not contain CLAUDE_CONFIG_DIR',
    );
  });
});

// ─── Trae converter bare-form tests ─────────────────────────────────────────

describe('convertClaudeToTraeMarkdown — bare ~/.claude and CLAUDE_CONFIG_DIR (#983)', () => {
  test('bare ~/.claude rewritten to ~/.trae', () => {
    const input = 'Config dir: (~/.claude), skills at ~/.claude/skills';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('~/.trae'), 'must rewrite to ~/.trae');
  });

  test('$HOME/.claude rewritten to $HOME/.trae', () => {
    const input = 'RUNTIME_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('$HOME/.trae'), 'must rewrite to $HOME/.trae');
  });

  test('CLAUDE_CONFIG_DIR rewritten to TRAE_CONFIG_DIR', () => {
    const input = 'Use CLAUDE_CONFIG_DIR or $HOME/.claude to configure';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      result.includes('TRAE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must become TRAE_CONFIG_DIR',
    );
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must be gone',
    );
  });

  test('.claude-plugin is NOT corrupted (preserved as-is)', () => {
    const input = 'The .claude-plugin/plugin.json manifest enables plugin install.';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      result.includes('.claude-plugin'),
      `.claude-plugin must be preserved; got: ${result}`,
    );
    assert.ok(
      !result.includes('.trae-plugin'),
      `.trae-plugin must not appear; got: ${result}`,
    );
  });

  test('no bare ~/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToTraeMarkdown(raw);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare ~/.claude',
    );
  });

  test('no $HOME/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToTraeMarkdown(raw);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare $HOME/.claude',
    );
  });

  test('no CLAUDE_CONFIG_DIR in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToTraeMarkdown(raw);
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'converted surface.md must not contain CLAUDE_CONFIG_DIR',
    );
  });
});

// ─── _applyRuntimeRewrites install-path tests (windsurf) ────────────────────
//
// These tests exercise the ACTUAL install path that causes the user-facing leak.
// The converter functions are called at stage time to produce a Windsurf-branded
// copy, but _applyRuntimeRewrites is the path that runs at INSTALL time and
// rewrites any surviving ~/.claude / $HOME/.claude refs in the staged files.
//
// FAIL-BEFORE proof: prior to this PR, windsurf used /~\/\.claude\b/ which
// fires on "~/.claude-plugin" because \b matches between 'e' and '-'.  Running
// the test below against the old regex (`\b`) would:
//   - let bare $HOME/.claude survive (it used only /~\/\.claude\b/, missing $HOME form), AND
//   - corrupt "~/.claude-plugin" → "~/.windsurf-plugin".
// Both assertions in the test below would fail on the old code.
//
// PASS-AFTER: the fix changes to (?![\w-]) so:
//   - bare ~/.claude / $HOME/.claude (not followed by word-char or hyphen) → rewritten
//   - ~/.claude-plugin preserved (the '-' after 'e' is in [\w-])
//
// NOTE on pathPrefix choice: we use '~/.windsurf/' (a simple home-relative
// prefix) rather than '$HOME/.codeium/windsurf/' so that the corruption of
// '~/.claude-plugin' → '~/.windsurf-plugin' is directly detectable via
// result.includes('.windsurf-plugin').
describe('_applyRuntimeRewrites(windsurf) — install-path bare-form + .claude-plugin (#983)', () => {
  // Use ~/  prefix (local-style) so that the .windsurf-plugin corruption is
  // directly detectable as a substring of the result.
  const WINDSURF_PATH_PREFIX = '~/.windsurf/';

  // Compound content: covers every form the fix must handle.
  // IMPORTANT: we use ~/.claude-plugin (home-relative form) to exercise the
  // corruption that the old \b regex caused. The \b fires between 'e' and '-',
  // so ~/.claude-plugin → ~/.windsurf-plugin under the old code. That would
  // break the preservation assertion below. The (?![\w-]) fix prevents this.
  const COMPOUND_INPUT = [
    'Config dir: ~/.claude',
    'Also: $HOME/.claude',
    'Slash form: ~/.claude/skills/foo.md',
    'Plugin installed at: ~/.claude-plugin/plugin.json',
    'Env var: CLAUDE_CONFIG_DIR',
  ].join('\n');

  test('bare ~/.claude rewritten to ~/.windsurf (no trailing slash)', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be gone; got:\n${result}`,
    );
    assert.ok(
      result.includes('~/.windsurf'),
      `must contain normalized pathPrefix; got:\n${result}`,
    );
  });

  test('bare $HOME/.claude rewritten to ~/.windsurf (install-path normalizes both home forms)', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be gone; got:\n${result}`,
    );
  });

  test('zero surviving bare ~/.claude or $HOME/.claude refs in compound input', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    const bareClaudePattern = /(?:~|\$HOME)\/\.claude(?![\w-])/;
    assert.ok(
      !bareClaudePattern.test(result),
      `no bare ~/.claude / $HOME/.claude must survive; got:\n${result}`,
    );
  });

  test('~/.claude-plugin is NOT corrupted to ~/.windsurf-plugin — was the \\b corruption', () => {
    // FAIL-BEFORE: old /~\/\.claude\b/ rewrote ~/.claude-plugin → ~/.windsurf-plugin
    // because \b fires between 'e' and '-'.
    // PASS-AFTER: (?![\w-]) sees '-' and skips the match, preserving ~/.claude-plugin.
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      result.includes('~/.claude-plugin'),
      `~/.claude-plugin must be preserved; got:\n${result}`,
    );
    assert.ok(
      !result.includes('~/.windsurf-plugin'),
      `~/.windsurf-plugin must NOT appear (was the \\b corruption); got:\n${result}`,
    );
  });

  test('slash form ~/.claude/ is also rewritten (pre-existing coverage)', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      !result.includes('~/.claude/'),
      `slash form ~/.claude/ must be gone; got:\n${result}`,
    );
  });

  test('CLAUDE_CONFIG_DIR is NOT rewritten by _applyRuntimeRewrites (converter responsibility)', () => {
    // _applyRuntimeRewrites does NOT handle CLAUDE_CONFIG_DIR for windsurf;
    // that rewrite is done by convertClaudeToWindsurfMarkdown at stage time.
    // This test documents the boundary and guards against scope creep.
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      result.includes('CLAUDE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR is not rewritten by _applyRuntimeRewrites — that is converter scope',
    );
  });
});

// ─── _applyRuntimeRewrites install-path tests (trae) ────────────────────────
//
// Trae had bare-form handling before this PR (via \b) and the converter uses
// (?![\w-]).  The pre-existing \b in _applyRuntimeRewrites DOES corrupt
// .claude-plugin → .trae-plugin (known limitation, out of scope for #983).
// We document this here but do NOT assert preservation for trae, and we do NOT
// fix the pre-existing trae \b lines (that would be a separate concern).
//
// What we DO assert: trae bare ~/.claude / $HOME/.claude refs are rewritten
// (the install path cleans them), which is the core #983 fix for trae.
describe('_applyRuntimeRewrites(trae) — install-path bare-form (#983)', () => {
  const TRAE_PATH_PREFIX = '$HOME/.trae/';

  const TRAE_INPUT = [
    'Config dir: ~/.claude',
    'Also: $HOME/.claude',
    'Slash form: ~/.claude/skills/foo.md',
    // Note: .claude-plugin is intentionally omitted from assertions here because
    // the pre-existing trae case uses \b which corrupts it (known limitation,
    // out of scope for #983 — do not fix here).
  ].join('\n');

  test('bare ~/.claude rewritten to $HOME/.trae (trae install path)', () => {
    const result = _applyRuntimeRewrites(TRAE_INPUT, 'trae', TRAE_PATH_PREFIX);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be gone; got:\n${result}`,
    );
  });

  test('bare $HOME/.claude rewritten to $HOME/.trae (trae install path)', () => {
    const result = _applyRuntimeRewrites(TRAE_INPUT, 'trae', TRAE_PATH_PREFIX);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be gone; got:\n${result}`,
    );
  });

  test('slash form ~/.claude/ also rewritten (trae install path)', () => {
    const result = _applyRuntimeRewrites(TRAE_INPUT, 'trae', TRAE_PATH_PREFIX);
    assert.ok(
      !result.includes('~/.claude/'),
      `slash form ~/.claude/ must be gone; got:\n${result}`,
    );
  });
});
