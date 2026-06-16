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

// Suite sentinels understood by run-tests.cjs (scripts/run-tests.cjs SUITES).
// A sentinel resolves to its live file set at run time, so — unlike an explicit
// filename — it can never reference a since-deleted test file.
const SUITE_SENTINELS = ['all', 'unit', 'integration', 'install', 'security', 'slow'];

// Fast smoke set used when scope detection yields no targeted tests. Each entry
// MUST resolve via run-tests.cjs: an existing repo-relative test file or a
// SUITE_SENTINELS token. A stale filename here (a test deleted by a refactor)
// is exactly what broke CI in #1329 — `tests/core.test.cjs`, deleted in #1291,
// was still listed and crashed every scoped lane that hit this fallback. The
// parity guard in tests/bug-641-files-from-suite-token.test.cjs fails the
// moment an entry stops resolving; resolveSelection() filters at write time so
// a stale entry degrades instead of crashing the lane.
const FALLBACK = [
  'tests/command-contract.test.cjs',
  'tests/commands.test.cjs',
  'tests/package-manifest.test.cjs',
];

// Last-resort selector when every FALLBACK entry has been deleted: the whole
// unit suite, resolved live by run-tests.cjs (the #408/#641 sentinel path).
const FALLBACK_SENTINEL = 'unit';

// An entry is runnable if it is a suite sentinel or an existing file under root.
function isResolvable(entry, root) {
  return SUITE_SENTINELS.includes(entry) || fs.existsSync(path.join(root, entry));
}

// Resolve the scoped test selection for the lane. Pure (no I/O beyond the
// existence probe under `root`) so it can be unit-tested directly.
function resolveSelection({ scope, targeted, windows, root }) {
  let selected;
  if (scope === 'windows') {
    selected = windows;
  } else if (scope === 'targeted') {
    selected = targeted;
  } else {
    throw new ExitError(1, `::error::Unknown test scope: ${scope}`);
  }

  // Detected list passes through verbatim: affected-tests-lib.cjs already filters
  // deleted files, and the list may legitimately carry a suite sentinel.
  const detected = (selected || '').split(/\s+/).filter(Boolean);
  if (detected.length > 0) {
    return detected;
  }

  // Empty detection → smoke fallback, existence-filtered so a stale entry can
  // never crash the scoped lane (#1329). If nothing survives, use the unit
  // sentinel, which run-tests.cjs always resolves.
  const survivors = FALLBACK.filter((f) => isResolvable(f, root));
  return survivors.length > 0 ? survivors : [FALLBACK_SENTINEL];
}

function main() {
  const root = process.cwd();
  const lines = resolveSelection({
    scope: process.env.TEST_SCOPE || '',
    targeted: process.env.TARGETED_TESTS || '',
    windows: process.env.WINDOWS_TESTS || '',
    root,
  });

  const content = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(root, '.ci-selected-tests.txt'), content, 'utf-8');

  process.stdout.write('Scoped tests:\n');
  process.stdout.write(content);
}

if (require.main === module) {
  runMain(main);
}

module.exports = { FALLBACK, FALLBACK_SENTINEL, SUITE_SENTINELS, resolveSelection, main };
