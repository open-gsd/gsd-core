'use strict';
// ci-prepare-test-scope.cjs — Write .ci-selected-tests.txt for scoped CI runs.
// Replaces the inline bash "Prepare scoped test list" step.
// Shell-agnostic: invoked as `node scripts/ci-prepare-test-scope.cjs` from any shell.
//
// Required environment variables (set by the workflow step's `env:` block):
//   TEST_SCOPE       — "windows" | "targeted"
//   TARGETED_TESTS   — space-separated test file list (from ci-test-scope.cjs output)
//   WINDOWS_TESTS    — space-separated test file list for the windows lane
//
// Writes: .ci-selected-tests.txt (one file per line, no blanks)
// Exit 0 = success; exit 1 = unknown scope.

const fs = require('fs');
const path = require('path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const scope = process.env.TEST_SCOPE || '';
const targeted = process.env.TARGETED_TESTS || '';
const windows = process.env.WINDOWS_TESTS || '';

const FALLBACK = 'tests/command-contract.test.cjs tests/commands.test.cjs tests/core.test.cjs tests/package-manifest.test.cjs';

function main() {
  let selected;
  if (scope === 'windows') {
    selected = windows;
  } else if (scope === 'targeted') {
    selected = targeted;
  } else {
    throw new ExitError(1, `::error::Unknown test scope: ${scope}`);
  }

  // Trim and fall back to default set if empty.
  if (!selected.trim()) {
    selected = FALLBACK;
  }

  // Split on whitespace, filter blanks, join with newlines.
  const lines = selected.split(/\s+/).filter(Boolean);
  const content = lines.join('\n') + '\n';

  const outPath = path.join(process.cwd(), '.ci-selected-tests.txt');
  fs.writeFileSync(outPath, content, 'utf-8');

  process.stdout.write('Scoped tests:\n');
  process.stdout.write(content);
}

runMain(main);
