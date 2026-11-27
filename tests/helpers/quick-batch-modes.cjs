'use strict';

/**
 * quick-batch-modes.cjs — fixtures shared by tests/gsd-quick-batch-modes.test.cjs
 * (in-process CLI rows) and tests/gsd-quick-batch-modes.process.test.cjs (the
 * shipped workflow bash blocks run by a real bash), #6532.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools } = require('../helpers.cjs');

const TASKS = ['- first task', '- second task'].join('\n');

function writeTasks(dir) {
  const file = path.join(dir, '.planning', 'tasks.md');
  fs.writeFileSync(file, TASKS + '\n');
  return file;
}

function batchesDir(dir) {
  return path.join(dir, '.planning', 'quick-batches');
}

function manifestPath(dir, batchId) {
  return path.join(batchesDir(dir), batchId, 'BATCH.json');
}

function readManifest(dir, batchId) {
  return JSON.parse(fs.readFileSync(manifestPath(dir, batchId), 'utf-8'));
}

/** `quick-batch create` through the real CLI; `options` is the raw `--options` value or undefined. */
function create(dir, options) {
  const args = ['--json-errors', 'quick-batch', 'create', '--file', writeTasks(dir), '--raw'];
  if (options !== undefined) args.push('--options', options);
  return runGsdTools(args, dir);
}

function createOk(dir, options) {
  const r = create(dir, options);
  assert.ok(r.success, `create failed: ${r.error}`);
  return JSON.parse(r.output).batchId;
}

module.exports = { writeTasks, batchesDir, manifestPath, readManifest, create, createOk };
