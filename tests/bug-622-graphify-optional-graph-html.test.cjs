// allow-test-rule: source-text-is-the-product
// This test extracts the deployed Step 3 shell block from commands/gsd/graphify.md
// and executes it to prove that a skipped graph.html (due to the graphify HTML viz
// node limit) does not abort the chain (#622). The deployed markdown text IS the
// product surface — the block the runtime executes — so asserting on its execution
// behavior requires reading the source text.

'use strict';

/**
 * Regression test for bug #622.
 *
 * The `/gsd-graphify build` Step 3 shell chain in commands/gsd/graphify.md
 * aborted when `graph.html` was intentionally skipped (graph exceeds the HTML
 * viz node limit, default 5000). The unconditional `cp graphify-out/graph.html`
 * failed with "cannot stat", and the `&&` chain aborted before the
 * GRAPH_REPORT.md copy, snapshot, and status steps ran.
 *
 * Fix: guard the graph.html copy with
 *   `{ [ -f graphify-out/graph.html ] && cp … || true; }`
 * so the chain continues when the file is absent.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');

// Path to the command doc (relative to repo root)
const GRAPHIFY_MD = path.join(__dirname, '..', 'commands', 'gsd', 'graphify.md');

/**
 * Extract the Step 3 fenced bash block from graphify.md.
 * The block starts with the line `graphify update .` and ends at the next
 * closing ``` fence.
 *
 * Returns the bash source text (without the fence lines themselves).
 */
function extractStep3Block() {
  const content = fs.readFileSync(GRAPHIFY_MD, 'utf-8');
  // Capture from the `graphify update .` line through the next closing ``` fence.
  const match = content.match(/```bash\r?\n(graphify update \.[^\0]*?)```/);
  return match ? match[1].trim() : null;
}

// ─── shared sandbox dirs ──────────────────────────────────────────────────────

let sandbox;
let fakeBin;
let fakeHome;

before(() => {
  sandbox = createTempDir('gsd-622-sandbox-');
  fakeBin = createTempDir('gsd-622-fakebin-');
  fakeHome = createTempDir('gsd-622-fakehome-');
});

after(() => {
  cleanup(sandbox);
  cleanup(fakeBin);
  cleanup(fakeHome);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Write a minimal fake `graphify` executable into fakeBin.
 * It just exits 0 so the `graphify update .` step succeeds.
 */
function writeFakeGraphify() {
  const exe = path.join(fakeBin, 'graphify');
  fs.writeFileSync(exe, ['#!/bin/sh', 'exit 0'].join('\n'), { mode: 0o755 });
}

/**
 * Write a minimal gsd-tools.cjs stub into fakeHome that exits 0 for any
 * invocation (covers the `graphify build snapshot` and `graphify status` steps).
 */
function writeFakeGsdTools() {
  const binDir = path.join(fakeHome, '.claude', 'gsd-core', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'gsd-tools.cjs'),
    ['#!/usr/bin/env node', 'process.exit(0);'].join('\n'),
    { mode: 0o755 },
  );
}

/**
 * Populate the sandbox with the minimal directory structure and output files
 * that a real `graphify update .` would produce. `includeHtml` controls
 * whether graphify-out/graph.html is created (simulating the node-limit skip
 * when false).
 */
function populateSandbox(includeHtml) {
  // graphify-out/ — simulates graphify CLI output directory
  const outDir = path.join(sandbox, 'graphify-out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'graph.json'), '{}');
  fs.writeFileSync(path.join(outDir, 'GRAPH_REPORT.md'), '# report');
  if (includeHtml) {
    fs.writeFileSync(path.join(outDir, 'graph.html'), '<html/>');
  }

  // .planning/graphs/ — destination directory
  const graphsDir = path.join(sandbox, '.planning', 'graphs');
  fs.mkdirSync(graphsDir, { recursive: true });
}

/**
 * Execute the extracted Step 3 block in the sandbox.
 */
function runBlock(block) {
  return spawnSync('bash', ['-c', block], {
    cwd: sandbox,
    env: {
      ...process.env,
      PATH: fakeBin + ':' + process.env.PATH,
      HOME: fakeHome,
    },
    encoding: 'utf8',
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('bug #622: graph.html absence must not abort the Step 3 shell chain', () => {
  let block;

  before(() => {
    block = extractStep3Block();
  });

  test('Step 3 bash block is present in graphify.md (sanity gate)', () => {
    assert.ok(block !== null, 'Step 3 bash block starting with "graphify update ." was not found in commands/gsd/graphify.md');
    assert.ok(block.length > 0, 'Extracted bash block must not be empty');
  });

  test('graph.html absent: chain exits 0 and all other artifacts are copied (#622 regression)', (t) => {
    // Use t.after for per-test cleanup so sandbox is fresh for each test
    t.after(() => {
      // Remove and recreate sandbox so the next test starts with an empty dir
      cleanup(sandbox);
      fs.mkdirSync(sandbox, { recursive: true });
    });

    writeFakeGraphify();
    writeFakeGsdTools();
    populateSandbox(false); // no graph.html — simulates node-limit skip

    const result = runBlock(block);

    // Chain must not abort
    assert.equal(result.status, 0, [
      'Expected exit 0 but got ' + result.status,
      'stderr: ' + result.stderr,
      'stdout: ' + result.stdout,
    ].join('\n'));

    // graph.json was copied (step before the guarded line)
    assert.ok(
      fs.existsSync(path.join(sandbox, '.planning', 'graphs', 'graph.json')),
      '.planning/graphs/graph.json must be copied even when graph.html is absent',
    );

    // GRAPH_REPORT.md was copied (step AFTER the guarded line — key regression assertion)
    assert.ok(
      fs.existsSync(path.join(sandbox, '.planning', 'graphs', 'GRAPH_REPORT.md')),
      '.planning/graphs/GRAPH_REPORT.md must be copied (the chain must not abort at graph.html)',
    );

    // graph.html must NOT exist in the destination (correctly skipped)
    assert.ok(
      !fs.existsSync(path.join(sandbox, '.planning', 'graphs', 'graph.html')),
      '.planning/graphs/graph.html must NOT be created when source is absent',
    );
  });

  test('graph.html present: chain exits 0 and graph.html is copied (happy path)', (t) => {
    t.after(() => {
      cleanup(sandbox);
      fs.mkdirSync(sandbox, { recursive: true });
    });

    writeFakeGraphify();
    writeFakeGsdTools();
    populateSandbox(true); // include graph.html

    const result = runBlock(block);

    assert.equal(result.status, 0, [
      'Expected exit 0 but got ' + result.status,
      'stderr: ' + result.stderr,
      'stdout: ' + result.stdout,
    ].join('\n'));

    // graph.html must exist in the destination (normal copy)
    assert.ok(
      fs.existsSync(path.join(sandbox, '.planning', 'graphs', 'graph.html')),
      '.planning/graphs/graph.html must be copied when the source file is present',
    );

    // Other artifacts also copied
    assert.ok(
      fs.existsSync(path.join(sandbox, '.planning', 'graphs', 'graph.json')),
      '.planning/graphs/graph.json must be copied',
    );
    assert.ok(
      fs.existsSync(path.join(sandbox, '.planning', 'graphs', 'GRAPH_REPORT.md')),
      '.planning/graphs/GRAPH_REPORT.md must be copied',
    );
  });
});
