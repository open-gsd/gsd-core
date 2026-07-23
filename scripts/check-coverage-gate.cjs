#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const summaryPath = path.join(process.cwd(), 'coverage', 'coverage-summary.json');
if (!fs.existsSync(summaryPath)) {
  console.error('check-coverage-gate: coverage/coverage-summary.json not found.');
  console.error('Ensure c8 runs with --reporter json-summary before this script.');
  process.exitCode = 1;
  return;
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const errors = [];

const OVERALL_LINES = 70;
const OVERALL_BRANCHES = 60;
const PER_FILE_BRANCHES = 70;
const PER_FILE_FILES = [
  'gsd-core/bin/lib/state.cjs',
  'gsd-core/bin/lib/phase.cjs',
  'gsd-core/bin/lib/verify.cjs',
  'gsd-core/bin/lib/init.cjs',
];

const overall = summary.total;
if (overall.lines.pct < OVERALL_LINES) {
  errors.push(`Overall lines ${overall.lines.pct}% < ${OVERALL_LINES}%`);
}
if (overall.branches.pct < OVERALL_BRANCHES) {
  errors.push(`Overall branches ${overall.branches.pct}% < ${OVERALL_BRANCHES}%`);
}

for (const file of PER_FILE_FILES) {
  const key = Object.keys(summary).find((k) => k.endsWith(file));
  if (!key) {
    errors.push(`${file}: not found in coverage summary`);
    continue;
  }
  const pct = summary[key].branches.pct;
  if (pct < PER_FILE_BRANCHES) {
    errors.push(`${file}: branches ${pct}% < ${PER_FILE_BRANCHES}%`);
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`ERROR: ${e}`);
  process.exitCode = 1;
}
