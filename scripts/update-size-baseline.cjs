#!/usr/bin/env node
'use strict';

/**
 * @file update-size-baseline.cjs
 *
 * Regenerates the committed per-file workflow size baseline
 * (`tests/workflow-size-baseline.json`) from the current workflow files.
 *
 * Run via `npm run size:baseline` whenever a workflow file legitimately grows
 * or shrinks.  Growth must still be justified in the PR; this script only
 * records the new reality so the CI guard (issue #1074) can diff against it.
 *
 * Idempotent: running it twice with no file changes produces no diff.
 */

const fs = require('fs');
const path = require('path');
const { measureWorkflows, WORKFLOWS_DIR } = require('./workflow-size.cjs');

const BASELINE_PATH = path.join(__dirname, '..', 'tests', 'workflow-size-baseline.json');

/**
 * Serialize a size map to the on-disk baseline format: keys sorted, 2-space
 * indent, trailing newline (so the file is a stable, minimal-diff artifact).
 *
 * @param {Object<string, number>} sizes
 * @returns {string}
 */
function serializeBaseline(sizes) {
  const sorted = {};
  for (const key of Object.keys(sizes).sort()) sorted[key] = sizes[key];
  return JSON.stringify(sorted, null, 2) + '\n';
}

/**
 * Write the baseline file from the measured workflow sizes.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]      - Workflows dir to measure (default canonical).
 * @param {string} [opts.outPath]  - Baseline file to write (default canonical).
 * @returns {{ outPath: string, count: number, content: string }}
 */
function generateBaseline({ dir = WORKFLOWS_DIR, outPath = BASELINE_PATH } = {}) {
  const sizes = measureWorkflows(dir);
  const content = serializeBaseline(sizes);
  fs.writeFileSync(outPath, content);
  return { outPath, count: Object.keys(sizes).length, content };
}

if (require.main === module) {
  const { outPath, count } = generateBaseline();
  process.stdout.write(
    `Wrote ${count} workflow sizes to ${path.relative(process.cwd(), outPath)}\n`
  );
}

module.exports = { generateBaseline, serializeBaseline, BASELINE_PATH };
