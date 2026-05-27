/**
 * Bug #3668: workflow resolver snippets must run from installed user projects.
 *
 * A user project normally does not contain get-shit-done/bin/gsd-tools.cjs.
 * The snippets should still prefer RUNTIME_DIR for local/dev installs, then
 * fall back to the installed gsd-tools binary on PATH.
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WORKFLOW_PATH = path.join(__dirname, '..', 'get-shit-done', 'workflows', 'next.md');

/**
 * Extract the canonical runtime resolver snippet from next.md.
 *
 * Supports two forms:
 * - One-line form (canonical): the entire launcher is a single line starting with
 *   `_GSD_SHIM_NAME="gsd-tools.cjs";` — return that line directly.
 * - Multi-line form (legacy): starts with a `# Runtime launcher:` comment or a
 *   `_GSD_SHIM_NAME=` line followed by separate GSD_TOOLS= and if/elif/else/fi
 *   lines — scan to the closing `fi`.
 */
function extractResolverSnippet() {
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const lines = content.split(/\r?\n/);

  // Find the canonical preamble — prefer _GSD_SHIM_NAME= line (handles both forms)
  let start = lines.findIndex((line) => /^_GSD_SHIM_NAME=/.test(line.trim()));
  if (start === -1) {
    // Fallback: canonical preamble comment (multi-line legacy form)
    start = lines.findIndex((line) =>
      /^\s*#\s*Runtime launcher:.*prefer local gsd-tools\.cjs.*installed gsd-tools on PATH/.test(line)
    );
  }
  if (start === -1) {
    // Last fallback: GSD_TOOLS= with RUNTIME_DIR
    start = lines.findIndex((line) => line.includes('GSD_TOOLS="${RUNTIME_DIR:-'));
  }
  assert.notEqual(
    start,
    -1,
    'next.md must contain the canonical runtime preamble ' +
    '(_GSD_SHIM_NAME= line, # Runtime launcher: comment, or GSD_TOOLS= line with RUNTIME_DIR)'
  );

  // One-line form: the entire launcher (including `if` and `fi`) is on a single line.
  // Detect by checking whether the start line contains a semicolon-separated `if` and `fi`.
  const startLine = lines[start].trim();
  if (/^_GSD_SHIM_NAME=.*;\s*if\s+\[.*\bfi$/.test(startLine)) {
    // Single-line canonical launcher — return it as-is
    return startLine;
  }

  // Multi-line form: scan forward from start to the closing `fi`, tracking if-depth
  let depth = 0;
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^if\s+/.test(t)) depth++;
    if (/^fi(\s|$)/.test(t)) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, 'runtime preamble must end with a closing `fi`');

  return lines.slice(start, end + 1).join('\n');
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-runtime-resolution-'));
}

function runResolver({ cwd, runtimeDir, pathDir }) {
  const script = [
    'set -e',
    extractResolverSnippet(),
    'printf "GSD_TOOLS=%s\\n" "$GSD_TOOLS"',
    'gsd_run query state.json',
  ].join('\n');

  return execFileSync('bash', ['-c', script], {
    cwd,
    env: {
      ...process.env,
      PATH: `${pathDir}${path.delimiter}${process.env.PATH || ''}`,
      RUNTIME_DIR: runtimeDir || '',
    },
    encoding: 'utf8',
  });
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

describe('bug-3668: workflow SDK resolver supports installed user projects', () => {
  test('falls back to installed gsd-tools when project-local runtime copy is absent', () => {
    // Bug #3668: when a user project has no local get-shit-done/bin/gsd-tools.cjs,
    // the elif branch must resolve to the gsd-tools binary on PATH.
    // RUNTIME_DIR points to a dir that has no gsd-tools.cjs.
    const tmp = makeTempDir();
    const project = path.join(tmp, 'user-project');
    const runtimeNoLocal = path.join(tmp, 'runtime-no-local');
    const pathBin = path.join(tmp, 'bin');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(runtimeNoLocal, { recursive: true });

    // Place gsd-tools stub on PATH (installed binary)
    writeExecutable(
      path.join(pathBin, 'gsd-tools'),
      '#!/bin/sh\nprintf "installed:%s %s\\n" "$1" "$2"\n',
    );

    // NO get-shit-done/bin/gsd-tools.cjs in runtimeNoLocal
    const output = runResolver({ cwd: project, runtimeDir: runtimeNoLocal, pathDir: pathBin });

    // GSD_TOOLS must have been reassigned to the PATH binary (not the missing .cjs)
    assert.match(output, /GSD_TOOLS=.+gsd-tools(?:\s|$)/m);
    // The PATH stub must have been invoked
    assert.match(output, /installed:query state\.json/);
  });

  test('preserves RUNTIME_DIR local gsd-tools.cjs preference over PATH fallback', () => {
    const tmp = makeTempDir();
    const project = path.join(tmp, 'user-project');
    const runtime = path.join(tmp, 'runtime');
    const pathBin = path.join(tmp, 'bin');
    fs.mkdirSync(project, { recursive: true });
    writeExecutable(path.join(pathBin, 'gsd-tools'), '#!/bin/sh\nprintf "path-installed:%s %s\\n" "$1" "$2"\n');
    writeExecutable(
      path.join(runtime, 'get-shit-done', 'bin', 'gsd-tools.cjs'),
      '#!/usr/bin/env node\nconsole.log(`runtime:${process.argv[2]} ${process.argv[3]}`);\n',
    );

    const output = runResolver({ cwd: project, runtimeDir: runtime, pathDir: pathBin });

    // Normalize separators so the assertion works on Windows (Git bash emits POSIX paths)
    const norm = output.replace(/\\/g, '/');
    // The resolved bin is the RUNTIME_DIR local runtime (suffix /get-shit-done/bin/gsd-tools.cjs)
    // Use .+ instead of \S* to handle paths with spaces (e.g. /Volumes/Mini Me/...)
    assert.match(norm, /GSD_TOOLS=.+\/get-shit-done\/bin\/gsd-tools\.cjs(?:\s|$)/m);
    assert.match(output, /runtime:query state\.json/);
    assert.doesNotMatch(output, /path-installed:query state\.json/);
  });
});
