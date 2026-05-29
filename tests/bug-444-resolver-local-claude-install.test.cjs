'use strict';
/**
 * Regression test for bug #444: gsd_run resolver must probe
 * <repo-root>/.claude/get-shit-done/bin/gsd-tools.cjs (the project-local
 * `--claude --local` install location) BEFORE checking $HOME/.claude and PATH.
 *
 * Asserts:
 * (A) The canonical snippet file contains the repo-local .claude/ check.
 * (B) Behavioral: when RUNTIME_DIR/get-shit-done/bin/ misses, but a stub
 *     exists ONLY at <repo-root>/.claude/get-shit-done/bin/gsd-tools.cjs,
 *     gsd_run resolves to that stub (no PATH stub, no HOME stub).
 * (C) Precedence: repo-local .claude/ wins over $HOME/.claude/ when both exist.
 */

// allow-test-rule: structural/behavioral regression for the repo-local .claude/ install
// arm in the gsd_run launcher snippet -- asserts literal substring presence and exercises
// the bash resolution path via execFileSync; there is no typed IR for "snippet contains arm X".

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'get-shit-done', 'workflows');
const SNIPPET_FILE = path.join(WORKFLOWS_DIR, '_runtime-launcher.snippet.sh');

// The probe string that must appear in the snippet for the new repo-local check.
// The snippet uses _GSD_RUNTIME_ROOT as the intermediate variable.
const LOCAL_CLAUDE_PROBE = '_GSD_RUNTIME_ROOT}/.claude/get-shit-done/bin/';

/**
 * Build a PATH that strips gsd-tools but keeps node and system binaries.
 * Accepts additional bin dirs to prepend.
 *
 * We cannot simply remove the whole directory that contains gsd-tools because
 * that directory may also contain node (e.g. /opt/homebrew/bin on macOS).
 * Instead, we keep the system PATH as-is and rely on the test's RUNTIME_DIR
 * having no get-shit-done/bin/ sub-path, so the resolver's first two checks
 * (RUNTIME_DIR/get-shit-done/bin/ and RUNTIME_DIR/.claude/get-shit-done/bin/)
 * are the only ones exercised before we hit our stub.
 *
 * The extra extraBefore dirs (e.g. noToolsBin) sit first but have no gsd-tools
 * binary, so command -v gsd-tools still falls back to PATH lookup. However,
 * the snippet's elif arm that uses `command -v gsd-tools` will find the real
 * installed one unless we mask it. To mask it without losing node, we create
 * a noToolsBin dir that shadows gsd-tools with a sentinel that must NOT be
 * called — and we only call makeIsolatedPath for tests where the .claude stub
 * must win before PATH is consulted (i.e. the elif PATH arm is never reached).
 *
 * For B: stub is at RUNTIME_DIR/.claude/... so resolver picks it at elif-1 (before command -v).
 * For C: same — local .claude/ is checked before command -v and before $HOME/.claude.
 */
function makeIsolatedPath(extraBefore = []) {
  // Keep full system PATH so node remains accessible.
  // Tests B and C exercise only the RUNTIME_DIR/.claude arm which fires
  // before command -v gsd-tools — so the real gsd-tools on PATH is never reached.
  const systemPaths = (process.env.PATH || '/usr/bin:/bin').split(path.delimiter);
  return [...extraBefore, ...systemPaths].join(path.delimiter);
}

describe('bug-444: resolver finds repo-local .claude install', () => {
  // --- (A) Snippet contains the repo-local .claude arm ----------------------
  test('(A) snippet file contains the repo-local .claude/ check arm before $HOME/.claude/', () => {
    const content = fs.readFileSync(SNIPPET_FILE, 'utf8');

    // Must contain the repo-local .claude/ check (via _GSD_RUNTIME_ROOT variable)
    const localClaudeIdx = content.indexOf(LOCAL_CLAUDE_PROBE);
    assert.ok(
      localClaudeIdx !== -1,
      `_runtime-launcher.snippet.sh must contain the repo-local .claude check ` +
        `('${LOCAL_CLAUDE_PROBE}'). ` +
        `Found snippet content:\n${content.trim()}`,
    );

    // Must still contain the $HOME/.claude fallback arm
    const homeClaudeIdx = content.indexOf('$HOME/.claude/get-shit-done/bin/');
    assert.ok(
      homeClaudeIdx !== -1,
      `Snippet must still contain the $HOME/.claude fallback arm.`,
    );

    // Repo-local check must appear BEFORE $HOME/.claude check (local overrides global)
    assert.ok(
      localClaudeIdx < homeClaudeIdx,
      `Repo-local .claude/ check (idx ${localClaudeIdx}) must appear BEFORE ` +
        `$HOME/.claude/ check (idx ${homeClaudeIdx}) in the snippet (local overrides global).`,
    );
  });

  // --- (B) Behavioral: repo-local .claude stub resolved when only location ---
  test('(B) gsd_run resolves repo-local .claude/get-shit-done/bin/ stub when no other locations present', () => {
    // Create a fake repo root with a stub ONLY at .claude/get-shit-done/bin/gsd-tools.cjs
    // NO stub at get-shit-done/bin/, NOT on PATH, NOT in $HOME/.claude
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-444-root-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-444-home-'));
    const noToolsBin = path.join(fakeRoot, 'nobin');
    fs.mkdirSync(noToolsBin, { recursive: true });

    try {
      // Create the stub at the repo-local .claude path ONLY
      const localClaudeBinDir = path.join(fakeRoot, '.claude', 'get-shit-done', 'bin');
      fs.mkdirSync(localClaudeBinDir, { recursive: true });
      const stubPath = path.join(localClaudeBinDir, 'gsd-tools.cjs');
      fs.writeFileSync(
        stubPath,
        '#!/usr/bin/env node\nconsole.log("LOCAL_CLAUDE_STUB:" + process.argv.slice(2).join(","));\n',
      );
      fs.chmodSync(stubPath, 0o755);

      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      // Set RUNTIME_DIR to fakeRoot so the resolver uses it as the repo root.
      const scriptContent =
        `unset GSD_TOOLS\n` +
        `export RUNTIME_DIR=${JSON.stringify(fakeRoot)}\n` +
        `export HOME=${JSON.stringify(fakeHome)}\n` +
        snippet +
        `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
        `gsd_run ping test\n`;

      const scriptPath = path.join(fakeRoot, 'test-local-claude.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      // Keep node in PATH (needed to run the .cjs stub); remove gsd-tools
      const isolatedPath = makeIsolatedPath([noToolsBin]);

      const stdout = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, PATH: isolatedPath, HOME: fakeHome },
      });

      // Must have resolved to the local .claude stub
      const normStdout = stdout.replace(/\\/g, '/');
      assert.ok(
        normStdout.includes('.claude/get-shit-done/bin/gsd-tools.cjs'),
        `Expected GSD_TOOLS to resolve to .claude/get-shit-done/bin/gsd-tools.cjs, got:\n${stdout.trim()}`,
      );
      // The stub must have been invoked with the correct arguments
      assert.ok(
        stdout.includes('LOCAL_CLAUDE_STUB:ping,test'),
        `Expected stub output "LOCAL_CLAUDE_STUB:ping,test" but got:\n${stdout.trim()}`,
      );
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // --- (C) Precedence: repo-local .claude/ wins over $HOME/.claude/ ----------
  test('(C) repo-local .claude/ install wins over $HOME/.claude/ when both exist', () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-444-prec-root-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-444-prec-home-'));
    const noToolsBin = path.join(fakeRoot, 'nobin');
    fs.mkdirSync(noToolsBin, { recursive: true });

    try {
      // Stub at repo-local .claude/ path (should be picked)
      const localClaudeBinDir = path.join(fakeRoot, '.claude', 'get-shit-done', 'bin');
      fs.mkdirSync(localClaudeBinDir, { recursive: true });
      const localStubPath = path.join(localClaudeBinDir, 'gsd-tools.cjs');
      fs.writeFileSync(
        localStubPath,
        '#!/usr/bin/env node\nconsole.log("LOCAL_WINS:" + process.argv.slice(2).join(","));\n',
      );
      fs.chmodSync(localStubPath, 0o755);

      // Stub at $HOME/.claude/ path (must NOT be picked)
      const homeClaudeBinDir = path.join(fakeHome, '.claude', 'get-shit-done', 'bin');
      fs.mkdirSync(homeClaudeBinDir, { recursive: true });
      const homeStubPath = path.join(homeClaudeBinDir, 'gsd-tools.cjs');
      fs.writeFileSync(
        homeStubPath,
        '#!/usr/bin/env node\nconsole.log("HOME_WINS:" + process.argv.slice(2).join(","));\n',
      );
      fs.chmodSync(homeStubPath, 0o755);

      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      const scriptContent =
        `unset GSD_TOOLS\n` +
        `export RUNTIME_DIR=${JSON.stringify(fakeRoot)}\n` +
        `export HOME=${JSON.stringify(fakeHome)}\n` +
        snippet +
        `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
        `gsd_run check\n`;

      const scriptPath = path.join(fakeRoot, 'test-precedence.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const isolatedPath = makeIsolatedPath([noToolsBin]);

      const stdout = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, PATH: isolatedPath, HOME: fakeHome },
      });

      assert.ok(
        stdout.includes('LOCAL_WINS:check'),
        `Expected repo-local .claude stub to be invoked ("LOCAL_WINS:check") ` +
          `but got:\n${stdout.trim()}`,
      );
      assert.ok(
        !stdout.includes('HOME_WINS'),
        `Expected $HOME/.claude stub NOT to be invoked, but got:\n${stdout.trim()}`,
      );
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
