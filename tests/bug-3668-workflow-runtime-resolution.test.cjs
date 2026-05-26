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

function extractResolverSnippet() {
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.includes('SDK resolution: prefer local gsd-tools.cjs'));
  assert.notEqual(start, -1, 'next.md must contain the SDK resolution snippet');

  const end = lines.findIndex((line, index) => index > start && line === 'fi');
  assert.notEqual(end, -1, 'SDK resolution snippet must end with fi');
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
    '$GSD_SDK query state.json',
  ].join('\n');

  return execFileSync('bash', ['-lc', script], {
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
    const tmp = makeTempDir();
    const project = path.join(tmp, 'user-project');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(project, { recursive: true });
    writeExecutable(path.join(bin, 'gsd-tools'), '#!/bin/sh\nprintf "installed:%s %s\\n" "$1" "$2"\n');

    const output = runResolver({ cwd: project, pathDir: bin });

    assert.match(output, new RegExp(`GSD_TOOLS=${path.join(bin, 'gsd-tools').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(output, /installed:query state\.json/);
  });

  test('preserves RUNTIME_DIR local gsd-tools.cjs preference over PATH fallback', () => {
    const tmp = makeTempDir();
    const project = path.join(tmp, 'user-project');
    const runtime = path.join(tmp, 'runtime');
    const pathBin = path.join(tmp, 'bin');
    fs.mkdirSync(project, { recursive: true });
    writeExecutable(path.join(pathBin, 'gsd-tools'), '#!/bin/sh\nprintf "installed:%s %s\\n" "$1" "$2"\n');
    writeExecutable(
      path.join(runtime, 'get-shit-done', 'bin', 'gsd-tools.cjs'),
      '#!/usr/bin/env node\nconsole.log(`runtime:${process.argv[2]} ${process.argv[3]}`);\n',
    );

    const output = runResolver({ cwd: project, runtimeDir: runtime, pathDir: pathBin });

    assert.match(output, new RegExp(`GSD_TOOLS=${path.join(runtime, 'get-shit-done', 'bin', 'gsd-tools.cjs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(output, /runtime:query state\.json/);
    assert.doesNotMatch(output, /installed:query state\.json/);
  });
});
