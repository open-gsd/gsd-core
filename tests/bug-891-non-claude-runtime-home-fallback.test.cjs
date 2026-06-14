'use strict';
/**
 * Regression test for bug #891: gsd_run launcher must probe non-Claude
 * runtime homes before emitting the hard error.
 *
 * The last-resort $HOME/.claude/gsd-core branch is Claude Code-specific.
 * Every non-Claude runtime (Hermes, Cursor, Codex, Copilot, Windsurf, …)
 * installs gsd-core into a *different* directory that the shim never tried,
 * causing a false-positive fatal ERROR on all non-Claude runtimes when
 * RUNTIME_DIR is not set and gsd-tools is not on PATH.
 *
 * Asserts:
 * (A) Snippet contains all expected non-Claude runtime home probes (structural).
 * (B) HERMES_HOME behavioral: when RUNTIME_DIR misses and gsd-tools is NOT on
 *     PATH, a stub at ${HERMES_HOME}/gsd-core/bin/gsd-tools.cjs is invoked.
 * (C) Default Hermes path behavioral: stub at $HOME/.hermes/gsd-core/bin/
 *     gsd-tools.cjs is invoked when HERMES_HOME is not set.
 * (D) Resolution order: non-Claude homes are probed BEFORE the hard error,
 *     and AFTER the $HOME/.claude branch.
 * (E) Propagation: all workflow .md files using gsd_run contain each probe
 *     (sync-runtime-launcher.cjs was re-run after editing the snippet).
 */

// allow-test-rule: structural/behavioral regression for non-Claude runtime-home
// fallback arms in the gsd_run launcher snippet -- asserts literal substring
// presence for each runtime-home probe and exercises the bash resolution paths
// via execFileSync; there is no typed IR for "snippet contains arm X".

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const SNIPPET_FILE = path.join(WORKFLOWS_DIR, '_runtime-launcher.snippet.sh');

// Every non-Claude runtime home probe the snippet must contain.
// Key: runtime name (for diagnostics). Value: the substring that must appear
// in the snippet (the env-var-with-default expansion that probes that runtime's
// gsd-core install location). Mirrors src/runtime-homes.cts getGlobalConfigDir().
const EXPECTED_RUNTIME_PROBES = {
  hermes:      '.hermes}/gsd-core/bin/',
  cursor:      '.cursor}/gsd-core/bin/',
  codex:       '.codex}/gsd-core/bin/',
  gemini:      '.gemini}/gsd-core/bin/',
  copilot:     '.copilot}/gsd-core/bin/',
  windsurf:    '.codeium/windsurf}/gsd-core/bin/',
  augment:     '.augment}/gsd-core/bin/',
  trae:        '.trae}/gsd-core/bin/',
  qwen:        '.qwen}/gsd-core/bin/',
  codebuddy:   '.codebuddy}/gsd-core/bin/',
  cline:       '.cline}/gsd-core/bin/',
  grok:        '.agents}/gsd-core/bin/',
  antigravity: '.gemini/antigravity}/gsd-core/bin/',
  opencode:    'opencode}/gsd-core/bin/',
  kilo:        'kilo}/gsd-core/bin/',
};

/**
 * Collect all workflow .md files recursively.
 */
function collectWorkflowFiles() {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  }
  walk(WORKFLOWS_DIR);
  return results;
}

/**
 * Extract all bash/sh/shell fenced blocks from markdown content.
 */
function extractShellBlocks(content) {
  const allLines = content.split('\n');
  const blocks = [];
  let inBlock = false;
  let blockLang = null;
  let blockLines = [];
  let blockIndent = '';
  let closingPattern = null;

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (!inBlock) {
      const fenceOpen = line.match(/^(\s*)```(\w+)?\s*$/);
      if (fenceOpen) {
        inBlock = true;
        blockIndent = fenceOpen[1];
        blockLang = (fenceOpen[2] || '').toLowerCase();
        blockLines = [];
        closingPattern = new RegExp('^' + blockIndent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '```\\s*$');
        continue;
      }
    } else {
      if (closingPattern.test(line)) {
        if (['bash', 'sh', 'shell', 'zsh', ''].includes(blockLang)) {
          blocks.push({ lines: blockLines });
        }
        inBlock = false;
        blockLang = null;
        blockLines = [];
        blockIndent = '';
        closingPattern = null;
        continue;
      }
      blockLines.push(line);
    }
  }
  return blocks;
}

/**
 * Build a PATH with no gsd-tools binary so the PATH fallback branch is skipped,
 * while guaranteeing that a bare `node` lookup still resolves regardless of whether
 * the real node binary co-locates with a global gsd-tools shim (e.g. fnm/nvm/Homebrew).
 *
 * Strategy (POSIX only): create a temp dir containing only a `node` symlink →
 * process.execPath, prepend it to the gsd-tools-filtered PATH.  The filtered
 * PATH excludes any directory that contains an executable `gsd-tools`.
 *
 * On Windows the co-location bug does not apply (gsd-tools resolves via .cmd/.ps1,
 * not the bare binary probed here), and symlinks may require elevated privileges,
 * so we skip the symlink step entirely on that platform.
 *
 * The caller is responsible for cleaning up `result.nodeBinDir` when non-null
 * (pass it to `cleanup()` in a `t.after` or `finally` block).
 *
 * @returns {{ isolatedPath: string, nodeBinDir: string|null }}
 */
function buildIsolatedPath() {
  const filteredPath = (process.env.PATH || '/usr/bin:/bin')
    .split(path.delimiter)
    .filter((p) => {
      try { fs.accessSync(path.join(p, 'gsd-tools'), fs.constants.X_OK); return false; }
      catch { return true; }
    })
    .join(path.delimiter);

  // Windows: no symlink (see JSDoc above); callers must handle nodeBinDir === null.
  if (process.platform === 'win32') {
    return { isolatedPath: filteredPath, nodeBinDir: null };
  }

  const nodeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-node-'));
  try {
    fs.symlinkSync(process.execPath, path.join(nodeBinDir, 'node'));
  } catch (err) {
    cleanup(nodeBinDir);
    throw err;
  }

  return { isolatedPath: nodeBinDir + path.delimiter + filteredPath, nodeBinDir };
}

describe('bug-891: non-Claude runtime home fallback arms', () => {

  // ── (A) Structural: snippet contains all expected non-Claude probes ───────
  test('(A) snippet contains all non-Claude runtime home probes', () => {
    const snippetContent = fs.readFileSync(SNIPPET_FILE, 'utf8');

    const missing = [];
    for (const [runtime, probe] of Object.entries(EXPECTED_RUNTIME_PROBES)) {
      if (!snippetContent.includes(probe)) {
        missing.push(`${runtime}: expected snippet to contain "${probe}"`);
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `_runtime-launcher.snippet.sh is missing fallback probes for non-Claude runtimes:\n` +
        missing.join('\n') +
        `\n\nAdd elif arms for each runtime home (e.g. "\${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/...")` +
        ` before the hard-error else. Current snippet:\n${snippetContent.trim()}`,
    );
  });

  // ── (A2) Structural: probes appear AFTER .claude arm but BEFORE hard error ─
  test('(A2) non-Claude probes appear after .claude/gsd-core arm and before hard error', () => {
    const snippetContent = fs.readFileSync(SNIPPET_FILE, 'utf8');
    const claudePos = snippetContent.indexOf('.claude/gsd-core/bin/');
    const errorPos  = snippetContent.indexOf('exit 1');

    assert.ok(claudePos !== -1, 'Snippet must still contain .claude/gsd-core/bin/ arm (regression guard)');
    assert.ok(errorPos  !== -1, 'Snippet must contain exit 1 (hard-error guard)');

    for (const [runtime, probe] of Object.entries(EXPECTED_RUNTIME_PROBES)) {
      const probePos = snippetContent.indexOf(probe);
      assert.ok(
        probePos !== -1,
        `Snippet must contain probe for ${runtime} ("${probe}")`,
      );
      assert.ok(
        probePos < errorPos,
        `${runtime} probe must appear before "exit 1" in snippet (found at ${probePos}, exit 1 at ${errorPos})`,
      );
    }
  });

  // ── (B0) Regression: buildIsolatedPath keeps node resolvable when node and ──
  //        gsd-tools co-locate in the same PATH directory.                     ─
  //
  // Machine-independence guarantee: PATH is set to ONLY two controlled dirs —
  // fakeBinDir (holds both fake gsd-tools AND a node symlink) plus a fresh
  // empty dir (no executables at all). The real system PATH is NOT appended.
  //
  //   Old logic: filters out fakeBinDir → only the empty dir remains → node
  //              UNresolvable → assertion (ii) FAILS (true-red on any machine).
  //   New logic: prepends its own nodeBinDir → node resolvable despite fakeBinDir
  //              being filtered → both assertions pass.
  test(
    '(B0) buildIsolatedPath: node is resolvable and gsd-tools is not when they share a PATH dir',
    { skip: process.platform === 'win32' ? 'POSIX-only co-location scenario' : false },
    (t) => {
      // Build a fake bin dir that contains BOTH a gsd-tools executable and a node
      // symlink, simulating a dev setup (fnm/nvm/Homebrew) where both land in the
      // same bin directory.
      const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-colocated-'));
      // A second fresh empty dir — contains neither gsd-tools nor node.
      const emptyDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-empty-'));
      t.after(() => cleanup(fakeBinDir));
      t.after(() => cleanup(emptyDir));

      // Fake gsd-tools shim (executable file)
      const fakeGsdTools = path.join(fakeBinDir, 'gsd-tools');
      fs.writeFileSync(fakeGsdTools, '#!/bin/sh\necho fake-gsd-tools\n');
      fs.chmodSync(fakeGsdTools, 0o755);

      // node symlink pointing at the real interpreter (co-located with gsd-tools)
      fs.symlinkSync(process.execPath, path.join(fakeBinDir, 'node'));

      // Set PATH to ONLY the two controlled dirs (no real system dirs).
      // This makes the test machine-independent: on any machine, the only place
      // node *could* come from before the fix is fakeBinDir — which gets filtered.
      const origPath = process.env.PATH;
      process.env.PATH = fakeBinDir + path.delimiter + emptyDir;
      let result;
      try {
        result = buildIsolatedPath();
      } finally {
        process.env.PATH = origPath;
      }
      t.after(() => cleanup(result.nodeBinDir));

      const returnedDirs = result.isolatedPath.split(path.delimiter);

      // (i) gsd-tools must NOT be resolvable on the returned PATH
      const gsdToolsResolvable = returnedDirs.some((dir) => {
        try { fs.accessSync(path.join(dir, 'gsd-tools'), fs.constants.X_OK); return true; }
        catch { return false; }
      });
      assert.equal(
        gsdToolsResolvable,
        false,
        'gsd-tools must not be resolvable on the isolated PATH (home-fallback would be bypassed)',
      );

      // (ii) node must BE resolvable on the returned PATH (the new nodeBinDir makes it so)
      const nodeResolvable = returnedDirs.some((dir) => {
        try { fs.accessSync(path.join(dir, 'node'), fs.constants.X_OK); return true; }
        catch { return false; }
      });
      assert.equal(
        nodeResolvable,
        true,
        'node must be resolvable on the isolated PATH (launcher runs: node "$GSD_TOOLS" "$@")',
      );
    },
  );

  // ── (B) Behavioral: HERMES_HOME stub is resolved ──────────────────────────
  test('(B) gsd_run resolves ${HERMES_HOME}/gsd-core/bin/ stub when set and local+PATH both miss', () => {
    const fakeHome       = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-home-b-'));
    const fakeHermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-hermes-'));
    const fakeRuntime    = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-rt-'));
    const { isolatedPath, nodeBinDir } = buildIsolatedPath();
    try {
      const hermesBinDir = path.join(fakeHermesHome, 'gsd-core', 'bin');
      fs.mkdirSync(hermesBinDir, { recursive: true });

      const stubPath = path.join(hermesBinDir, 'gsd-tools.cjs');
      fs.writeFileSync(
        stubPath,
        '#!/usr/bin/env node\nconsole.log("HERMES_HOME_STUB:" + process.argv.slice(2).join(","));\n',
      );
      fs.chmodSync(stubPath, 0o755);

      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      // Export HOME to an isolated temp dir (no .claude install there) so the
      // $HOME/.claude arm is skipped and we fall through to the HERMES_HOME arm.
      const scriptContent =
        `unset GSD_TOOLS\n` +
        `export HOME=${JSON.stringify(fakeHome)}\n` +
        `export RUNTIME_DIR=${JSON.stringify(fakeRuntime)}\n` +
        `export HERMES_HOME=${JSON.stringify(fakeHermesHome)}\n` +
        snippet +
        `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
        `gsd_run ping test\n`;

      const scriptPath = path.join(fakeRuntime, 'test-hermes-home.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const stdout = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, PATH: isolatedPath, HOME: fakeHome, HERMES_HOME: fakeHermesHome },
      });

      const normStdout = stdout.replace(/\\/g, '/');
      assert.ok(
        normStdout.includes('gsd-core/bin/'),
        `Expected GSD_TOOLS to resolve into hermes gsd-core/bin/, got:\n${stdout.trim()}`,
      );
      assert.ok(
        stdout.includes('HERMES_HOME_STUB:ping,test'),
        `Expected stub output "HERMES_HOME_STUB:ping,test", got:\n${stdout.trim()}`,
      );
    } finally {
      cleanup(fakeHome);
      cleanup(fakeHermesHome);
      cleanup(fakeRuntime);
      if (nodeBinDir) cleanup(nodeBinDir);
    }
  });

  // ── (C) Behavioral: default .hermes path used when HERMES_HOME not set ────
  test('(C) gsd_run resolves $HOME/.hermes/gsd-core/bin/ stub when HERMES_HOME is unset', () => {
    const fakeHome    = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-home-'));
    const fakeRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-891-rt2-'));
    const { isolatedPath, nodeBinDir } = buildIsolatedPath();
    try {
      const hermesBinDir = path.join(fakeHome, '.hermes', 'gsd-core', 'bin');
      fs.mkdirSync(hermesBinDir, { recursive: true });

      const stubPath = path.join(hermesBinDir, 'gsd-tools.cjs');
      fs.writeFileSync(
        stubPath,
        '#!/usr/bin/env node\nconsole.log("HERMES_DEFAULT_STUB:" + process.argv.slice(2).join(","));\n',
      );
      fs.chmodSync(stubPath, 0o755);

      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      const scriptContent =
        `unset GSD_TOOLS HERMES_HOME\n` +
        `export RUNTIME_DIR=${JSON.stringify(fakeRuntime)}\n` +
        `export HOME=${JSON.stringify(fakeHome)}\n` +
        snippet +
        `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
        `gsd_run status\n`;

      const scriptPath = path.join(fakeRuntime, 'test-hermes-default.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const stdout = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, PATH: isolatedPath, HOME: fakeHome },
      });

      const normStdout = stdout.replace(/\\/g, '/');
      assert.ok(
        normStdout.includes('.hermes/gsd-core/bin/'),
        `Expected GSD_TOOLS to resolve into .hermes/gsd-core/bin/, got:\n${stdout.trim()}`,
      );
      assert.ok(
        stdout.includes('HERMES_DEFAULT_STUB:status'),
        `Expected stub output "HERMES_DEFAULT_STUB:status", got:\n${stdout.trim()}`,
      );
    } finally {
      cleanup(fakeHome);
      cleanup(fakeRuntime);
      if (nodeBinDir) cleanup(nodeBinDir);
    }
  });

  // ── (D) Resolution order: claude < hermes < hard-error ───────────────────
  test('(D) resolution order: .claude probe comes before hermes probe, hermes before hard error', () => {
    const snippetContent = fs.readFileSync(SNIPPET_FILE, 'utf8');
    const claudePos  = snippetContent.indexOf('.claude/gsd-core/bin/');
    const hermesPos  = snippetContent.indexOf('.hermes}/gsd-core/bin/');
    const errorPos   = snippetContent.indexOf('exit 1');

    assert.ok(claudePos  !== -1, 'Snippet must contain .claude/gsd-core/bin/ arm');
    assert.ok(hermesPos  !== -1, 'Snippet must contain .hermes}/gsd-core/bin/ arm');
    assert.ok(errorPos   !== -1, 'Snippet must contain exit 1 hard-error');

    assert.ok(
      claudePos < hermesPos,
      `Expected .claude probe (at ${claudePos}) before .hermes probe (at ${hermesPos})`,
    );
    assert.ok(
      hermesPos < errorPos,
      `Expected .hermes probe (at ${hermesPos}) before exit 1 (at ${errorPos})`,
    );
  });

  // ── (E) Propagation: workflow .md files using gsd_run contain hermes probe ─
  test('(E) all workflow .md files using gsd_run contain the hermes runtime home probe', () => {
    const HERMES_PROBE = '.hermes}/gsd-core/bin/';
    const files = collectWorkflowFiles();
    assert.ok(files.length > 0, 'expected at least one workflow .md file');

    const missing = [];
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      const blocks = extractShellBlocks(content);
      const allBlockLines = blocks.flatMap((b) => b.lines);
      const fileHasGsdRun = allBlockLines.some((l) => /\bgsd_run\b/.test(l));
      if (!fileHasGsdRun) continue;
      const allContent = allBlockLines.join('\n');
      if (!allContent.includes(HERMES_PROBE)) {
        missing.push(path.relative(WORKFLOWS_DIR, f));
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `These workflow files use gsd_run but are missing the hermes runtime home probe ("${HERMES_PROBE}"). ` +
        `Run \`node scripts/sync-runtime-launcher.cjs\` to propagate:\n` +
        missing.join('\n'),
    );
  });
});
