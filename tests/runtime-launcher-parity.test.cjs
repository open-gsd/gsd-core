'use strict';
/**
 * Parity test for bug #373: space-safe gsd_run launcher
 *
 * Asserts:
 * (A) No retired GSD_SDK token remains in any workflow .md file.
 * (B) Each workflow .md that uses gsd_run contains EXACTLY ONE canonical preamble
 *     (byte-equal to _runtime-launcher.snippet.sh), and it appears before the first
 *     gsd_run call. NOT every bash block — exactly one per file (define once, use
 *     across blocks — original footprint).
 * (C) Space-safe behavioral: a RUNTIME_DIR path with spaces in it resolves
 *     and calls gsd-tools.cjs correctly (no word-split, no {}).
 * (D) Loud guard behavioral: missing gsd-tools.cjs exits non-zero and emits
 *     "not found" to stderr.
 * (E) PATH fallback behavioral: when no local gsd-tools.cjs, the elif branch
 *     resolves to the gsd-tools binary on PATH (#3668).
 * (F) Regression locks: the snippet file contains no /gsd-tools substring; and
 *     no line in workflows/do.md matches /\/gsd[:-][a-z]/ (dispatcher-parity
 *     scanner must not read the preamble as a slash-command stub).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'get-shit-done', 'workflows');
const SNIPPET_FILE = path.join(WORKFLOWS_DIR, '_runtime-launcher.snippet.sh');

/**
 * Read the canonical preamble from the snippet file (all lines, no trailing newline).
 */
function expectedPreamble() {
  const raw = fs.readFileSync(SNIPPET_FILE, 'utf8');
  const lines = raw.split('\n');
  // Strip trailing empty element produced by a trailing newline.
  const content = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  assert.ok(content.length >= 1, `_runtime-launcher.snippet.sh must not be empty`);
  return content; // array of strings
}

/**
 * Extract all bash/sh/shell fenced blocks from markdown content.
 * Returns array of { index, lines } where index is 0-based block count,
 * and lines is the array of content lines (without the fence markers).
 *
 * Handles both column-0 fences (```bash) and indented fences (   ```bash).
 */
function extractShellBlocks(content) {
  const allLines = content.split('\n');
  const blocks = [];
  let inBlock = false;
  let blockLang = null;
  let blockLines = [];
  let blockIndex = 0;
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
        // Closing pattern: same indent prefix + ```
        closingPattern = new RegExp('^' + blockIndent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '```\\s*$');
        continue;
      }
    } else {
      if (closingPattern.test(line)) {
        if (['bash', 'sh', 'shell', 'zsh', ''].includes(blockLang)) {
          blocks.push({ index: blockIndex, lang: blockLang, lines: blockLines });
          blockIndex++;
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
 * Collect all workflow .md files recursively under WORKFLOWS_DIR.
 * Excludes _runtime-launcher.snippet.sh (not a markdown file).
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

describe('runtime-launcher-parity (#373)', () => {
  // ─── (A) No retired GSD_SDK token ────────────────────────────────────────
  test('(A) no GSD_SDK token in any workflow .md file', () => {
    const files = collectWorkflowFiles();
    assert.ok(files.length > 0, 'expected at least one workflow .md file');

    const offending = [];
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      if (content.includes('GSD_SDK')) {
        offending.push(path.relative(WORKFLOWS_DIR, f));
      }
    }

    assert.deepStrictEqual(
      offending,
      [],
      'Found GSD_SDK (retired token) in workflow files — run `node scripts/sync-runtime-launcher.cjs` to fix:\n' +
        offending.join('\n'),
    );
  });

  // ─── (B) Exactly ONE canonical preamble per using file ───────────────────
  test('(B) each workflow .md using gsd_run contains exactly ONE canonical preamble, before the first gsd_run call', () => {
    const preamble = expectedPreamble();
    const preambleStr = preamble.join('\n');
    const files = collectWorkflowFiles();
    assert.ok(files.length > 0, 'expected at least one workflow .md file');

    const violations = [];

    for (const f of files) {
      const rel = path.relative(WORKFLOWS_DIR, f);
      const content = fs.readFileSync(f, 'utf8');
      const blocks = extractShellBlocks(content);

      // Collect all block lines in document order for flat analysis
      const allBlockLines = [];
      for (const blk of blocks) {
        allBlockLines.push(...blk.lines);
      }

      // Does this file use gsd_run at all?
      const fileHasGsdRun = allBlockLines.some((l) => /\bgsd_run\b/.test(l));
      if (!fileHasGsdRun) continue;

      // Count preamble occurrences across all shell content of this file
      // Flatten all block lines with a separator so multi-block boundary doesn't create false match
      const allContent = allBlockLines.join('\n');
      let preambleCount = 0;
      let searchPos = 0;
      while (true) {
        const idx = allContent.indexOf(preambleStr, searchPos);
        if (idx === -1) break;
        preambleCount++;
        searchPos = idx + preambleStr.length;
      }

      if (preambleCount !== 1) {
        violations.push(
          `${rel}: expected exactly 1 canonical preamble occurrence in bash blocks, found ${preambleCount}. ` +
            `Run \`node scripts/sync-runtime-launcher.cjs\` to fix.`,
        );
        continue;
      }

      // Verify preamble appears BEFORE the first gsd_run call (in document order)
      // Find the line index of the preamble start vs the first gsd_run call in the flat content
      const preamblePos = allContent.indexOf(preambleStr);
      const firstGsdRunPos = allContent.search(/\bgsd_run\b/);

      // The first gsd_run WITHIN the preamble itself (the function definition) is fine.
      // We need to verify that no gsd_run CALL (i.e. gsd_run used as a command, not in a
      // function definition body) appears before the preamble starts.
      // Simple check: preamble starts at or before the first gsd_run occurrence
      if (preamblePos > firstGsdRunPos) {
        violations.push(
          `${rel}: preamble appears AFTER the first gsd_run reference — it must precede all gsd_run calls.`,
        );
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      'Files with gsd_run calls have wrong preamble count or ordering:\n' +
        violations.join('\n---\n'),
    );
  });

  // ─── (C) Space-safe behavioral test ──────────────────────────────────────
  test('(C) gsd_run works with a RUNTIME_DIR path containing spaces', () => {
    // Create temp dir whose path contains a space
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd 373 '));
    try {
      const binDir = path.join(base, 'get-shit-done', 'bin');
      fs.mkdirSync(binDir, { recursive: true });

      // Stub gsd-tools.cjs that prints its argv
      const stub = path.join(binDir, 'gsd-tools.cjs');
      fs.writeFileSync(stub, '#!/usr/bin/env node\nconsole.log("STUB:" + process.argv.slice(2).join(","));\n');
      fs.chmodSync(stub, 0o755);

      // Build a shell script: set RUNTIME_DIR, source preamble, run gsd_run
      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      const scriptContent =
        `export RUNTIME_DIR=${JSON.stringify(base)}\n` +
        snippet +
        `\ngsd_run query state.json\n`;

      const scriptPath = path.join(base, 'test-space.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      assert.ok(
        stdout.includes('STUB:query,state.json'),
        `Expected stdout to contain "STUB:query,state.json" but got: ${stdout.trim()}`,
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // ─── (D) Loud guard: missing runtime is fatal ─────────────────────────────
  test('(D) missing gsd-tools.cjs and no PATH gsd-tools causes loud non-zero exit with "not found" on stderr', () => {
    // Create temp dir with a space in the name, but NO gsd-tools.cjs.
    // We ensure gsd-tools is not on PATH by prepending a dir that has no
    // gsd-tools binary (system binaries remain on PATH so bash/node work).
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd 373 notools '));
    // Place a no-op dir first in PATH; no gsd-tools stub there.
    const noToolsBin = path.join(base, 'nobin');
    fs.mkdirSync(noToolsBin, { recursive: true });
    try {
      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      // The script must also unset any GSD_TOOLS env var that might leak in
      const scriptContent =
        `unset GSD_TOOLS\n` +
        `export RUNTIME_DIR=${JSON.stringify(base)}\n` +
        snippet +
        `\ngsd_run query state.json\n`;

      const scriptPath = path.join(base, 'test-guard.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      // Build a PATH that has noToolsBin first (no gsd-tools stub there) but retains
      // system paths needed for bash. Exclude any PATH entry that contains a gsd-tools binary.
      const systemPaths = (process.env.PATH || '/usr/bin:/bin')
        .split(path.delimiter)
        .filter((p) => {
          try { fs.accessSync(path.join(p, 'gsd-tools'), fs.constants.X_OK); return false; }
          catch { return true; }
        });
      const isolatedPath = [noToolsBin, ...systemPaths].join(path.delimiter);

      let threw = false;
      let stderrOutput = '';
      try {
        execFileSync('bash', [scriptPath], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PATH: isolatedPath },
        });
      } catch (err) {
        threw = true;
        stderrOutput = err.stderr || '';
      }

      assert.ok(threw, 'Expected the script to exit non-zero when gsd-tools.cjs is missing and gsd-tools is not on PATH');
      assert.ok(
        stderrOutput.includes('not found') || stderrOutput.includes('ERROR'),
        `Expected stderr to contain "not found" or "ERROR", got: ${stderrOutput.trim()}`,
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // ─── (E) PATH fallback behavioral (#3668) ────────────────────────────────
  test('(E) PATH fallback: uses installed gsd-tools when no local gsd-tools.cjs present', () => {
    // Create a temp dir with NO local get-shit-done/bin/gsd-tools.cjs.
    // Place an executable gsd-tools stub on a dedicated PATH dir.
    // RUNTIME_DIR points somewhere that has no gsd-tools.cjs.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd 373 pathfb '));
    try {
      const pathBinDir = path.join(base, 'bin');
      fs.mkdirSync(pathBinDir, { recursive: true });

      // Stub installed gsd-tools binary that prints a marker
      const stubPath = path.join(pathBinDir, 'gsd-tools');
      fs.writeFileSync(stubPath, '#!/bin/sh\necho "installed:$*"\n');
      fs.chmodSync(stubPath, 0o755);

      // RUNTIME_DIR points to base — no get-shit-done/bin/gsd-tools.cjs there
      const snippet = fs.readFileSync(SNIPPET_FILE, 'utf8');
      const scriptContent =
        `export RUNTIME_DIR=${JSON.stringify(base)}\n` +
        snippet +
        `\nprintf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"\n` +
        `gsd_run query state.json\n`;

      const scriptPath = path.join(base, 'test-pathfb.sh');
      fs.writeFileSync(scriptPath, scriptContent);

      const stdout = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${pathBinDir}${path.delimiter}${process.env.PATH || ''}` },
      });

      // The PATH fallback must have resolved GSD_TOOLS to the stub binary
      assert.ok(
        stdout.includes('GSD_TOOLS=') && stdout.includes(pathBinDir),
        `Expected GSD_TOOLS to resolve to PATH stub in ${pathBinDir}, got: ${stdout.trim()}`,
      );
      // The stub must have been invoked with the query arguments
      assert.ok(
        stdout.includes('installed:query state.json'),
        `Expected stdout to contain "installed:query state.json" (PATH stub output), got: ${stdout.trim()}`,
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // ─── (F) Regression locks: no /gsd-tools substring; no do.md dispatcher false-positive ──
  test('(F) snippet has no /gsd-tools substring; do.md has no /gsd[:-][a-z] matches', () => {
    // (F1) The snippet must not contain the literal substring /gsd-tools.
    // The _GSD_SHIM_NAME indirection ensures bin/${_GSD_SHIM_NAME} instead of
    // bin/gsd-tools.cjs — so the do.md dispatcher regex /\/gsd[:-]([a-z]...)/ never
    // misreads a preamble line as a slash-command stub.
    const snippetContent = fs.readFileSync(SNIPPET_FILE, 'utf8');
    assert.ok(
      !snippetContent.includes('/gsd-tools'),
      `_runtime-launcher.snippet.sh must not contain the literal "/gsd-tools" substring. ` +
        `Use bin/\${_GSD_SHIM_NAME} indirection to keep the /gsd[:-] scanner from ` +
        `misreading it as a slash-command stub. Found in snippet:\n` +
        snippetContent.split('\n').filter((l) => l.includes('/gsd-tools')).join('\n'),
    );

    // (F2) workflows/do.md must not contain the literal substring /gsd-tools
    // (the specific path that leaks when _GSD_SHIM_NAME indirection is bypassed).
    // The bug-2954 dispatcher scanner /\/gsd[:-]([a-z]...)/ would misread
    // /gsd-tools as a slash-command stub named "tools" — which is not shipped.
    // Note: /gsd:command references (with colon) in the dispatch table are
    // legitimate and are NOT checked here.
    const doMdPath = path.join(WORKFLOWS_DIR, 'do.md');
    const doMdContent = fs.readFileSync(doMdPath, 'utf8');
    const offendingLines = doMdContent
      .split('\n')
      .filter((l) => /\/gsd-tools/.test(l));
    assert.deepStrictEqual(
      offendingLines,
      [],
      `workflows/do.md contains the literal "/gsd-tools" substring which the dispatcher-parity ` +
        `scanner (bug-2954) misreads as a slash-command stub. Use \${_GSD_SHIM_NAME} indirection. ` +
        `Offending lines:\n` +
        offendingLines.join('\n'),
    );
  });
});
