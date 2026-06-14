#!/usr/bin/env node
'use strict';

/**
 * scripts/mutation-matrix.cjs
 *
 * Single source of truth for the ADR-457 Stryker mutation gate dynamic matrix.
 *
 * Computes which covered modules changed vs a base ref and emits a GitHub
 * Actions matrix JSON so CI can run one Stryker shard per changed module in
 * parallel rather than a single serial run over all modules.
 *
 * Usage:
 *   node scripts/mutation-matrix.cjs --base origin/next
 *   printf 'src/config-schema.cts\n' | node scripts/mutation-matrix.cjs
 *   node scripts/mutation-matrix.cjs --base origin/next --print
 *
 * Output (stdout, default): JSON object
 *   {
 *     "has_work": "true"|"false",
 *     "matrix": {
 *       "include": [
 *         { "name": "<module>", "mutate": "gsd-core/bin/lib/<module>.cjs", "tests": "<space-joined test files>" },
 *         ...
 *       ]
 *     }
 *   }
 *
 * Exit codes: 0 always (empty matrix is not an error, has_work "false").
 */

const { execFileSync } = require('child_process');
const { readFileSync } = require('fs');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

// ── Per-module mutation score ratchet ─────────────────────────────────────────
// ADR-456 / issue #1187: every covered module declares a minScore floor.
//
// HOW THE RATCHET WORKS:
//   • minScore locks in the current measured mutation score (minus a 1–2 pt
//     margin for run-to-run timeout variance).
//   • CI fails a shard if the module's live score drops below its minScore.
//   • Raise minScore (never lower) as a module's tests improve.
//   • The goal is every module reaching TARGET_MUTATION_SCORE (80).
//
// GOODHART SAFETY: scores are improved by writing genuine behavioural
// assertions that kill real mutants — never by adding brittle exact-string
// matches on incidental output. A justified `// Stryker disable` on a
// confirmed equivalent mutant is acceptable.
//
// HOW TO UPDATE:
//   1. Run the per-module Stryker shard locally.
//   2. Note the reported score.
//   3. Set minScore = floor(score) - 1 (never lower than current value).
//   4. Open a PR — the CI gate will enforce the new floor on every future run.

/** Long-run target for all modules (ADR-456). */
const TARGET_MUTATION_SCORE = 80;

// ── Single source of truth: covered modules ───────────────────────────────────
// Each entry: { cjs: '<built artifact>', tests: ['tests/...', ...], minScore: N }
//
// minScore is the CI break threshold for this module's shard.
// Floors are measured scores minus 1–2 pts for run-to-run variance.
// Measured 2026-06-13 (issue #1187):
//   context-utilization   79.5% → floor 79
//   prompt-budget         99.6% → floor 90   (conservative; high score is robust)
//   frontmatter           63.5% → floor 62
//   adr-parser            69.5% → floor 68
//   config-schema         69.7% → floor 68
//   active-workstream-store 81.9% → floor 80
const COVERED = {
  'context-utilization': {
    cjs: 'gsd-core/bin/lib/context-utilization.cjs',
    tests: [
      'tests/context-utilization.property.test.cjs',
    ],
    // After mutation-killer assertions added in #1187: measured 92.31% (2026-06-14).
    // 3 survivors are __esModule boilerplate (genuinely equivalent CJS interop mutants).
    // minScore raised to TARGET (80) — module now meets ADR-456 goal.
    minScore: 80,
  },
  'prompt-budget': {
    cjs: 'gsd-core/bin/lib/prompt-budget.cjs',
    tests: [
      'tests/prompt-budget.property.test.cjs',
      'tests/prompt-budget.unit.test.cjs',
    ],
    minScore: 90,
  },
  frontmatter: {
    cjs: 'gsd-core/bin/lib/frontmatter.cjs',
    tests: [
      'tests/frontmatter.property.test.cjs',
      'tests/frontmatter.unit.test.cjs',
    ],
    minScore: 62,
  },
  'adr-parser': {
    cjs: 'gsd-core/bin/lib/adr-parser.cjs',
    tests: [
      'tests/adr-parser.property.test.cjs',
      'tests/adr-parser.test.cjs',
      'tests/adr-parser.unit.test.cjs',
    ],
    minScore: 68,
  },
  'config-schema': {
    cjs: 'gsd-core/bin/lib/config-schema.cjs',
    tests: [
      'tests/config-schema.property.test.cjs',
    ],
    minScore: 68,
  },
  'active-workstream-store': {
    cjs: 'gsd-core/bin/lib/active-workstream-store.cjs',
    tests: [
      'tests/active-workstream-store.test.cjs',
      'tests/active-workstream-store.unit.test.cjs',
    ],
    minScore: 80,
  },
  'core-utils': {
    cjs: 'gsd-core/bin/lib/core-utils.cjs',
    tests: [
      'tests/core-utils.test.cjs',
    ],
    minScore: 75,  // measured 77.52% (2026-06-14, issue #1187); floor = 77 - 2
  },
};

// ── Files that, when changed, invalidate ALL modules ─────────────────────────
// Changes to the Stryker config, this script itself, or any covered test file
// affect all mutation scores and must force a full re-run.
const GLOBAL_TRIGGERS = new Set([
  'stryker.config.mjs',
  'scripts/mutation-matrix.cjs',
]);

// Also flag all test files that belong to any covered module as global triggers.
for (const mod of Object.values(COVERED)) {
  for (const t of mod.tests) {
    GLOBAL_TRIGGERS.add(t);
  }
}

// ── Argument parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { base: null, print: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      out.base = argv[++i];
      if (!out.base || out.base.startsWith('--')) {
        throw new Error('--base requires a value');
      }
    } else if (arg.startsWith('--base=')) {
      out.base = arg.slice('--base='.length);
      if (!out.base) throw new Error('--base requires a value');
    } else if (arg === '--print') {
      out.print = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage:',
        '  node scripts/mutation-matrix.cjs --base <ref> [--print]',
        '  printf "src/foo.cts\\n" | node scripts/mutation-matrix.cjs [--print]',
        '',
        'Options:',
        '  --base <ref>   Git ref to diff against (default: origin/${GITHUB_BASE_REF:-next})',
        '  --print        Human-readable output instead of JSON',
      ].join('\n'));
      throw new ExitError(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

// ── Changed-file resolution ───────────────────────────────────────────────────
function resolveChangedFiles(args) {
  // When --base is provided, always use git diff (regardless of stdin).
  // When --base is absent AND stdin is not a TTY (isTTY is falsy / undefined),
  // read a newline-delimited file list from stdin.
  if (!args.base && process.stdin.isTTY !== true) {
    const raw = readFileSync(process.stdin.fd, 'utf8');
    return raw.split('\n').map(l => l.trim()).filter(Boolean);
  }

  // Otherwise (--base given, or stdin is a real TTY), diff against the base ref.
  const defaultBase = `origin/${process.env.GITHUB_BASE_REF || 'next'}`;
  const base = args.base || defaultBase;
  const stdout = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8',
  });
  return stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

// ── Module classification ─────────────────────────────────────────────────────
function computeMatrix(changedFiles) {
  // Check for global triggers first — if any hit, include every covered module.
  const allModuleNames = Object.keys(COVERED);
  for (const f of changedFiles) {
    if (GLOBAL_TRIGGERS.has(f)) {
      return allModuleNames;
    }
  }

  // Otherwise find which modules have their src/*.cts changed.
  const changed = new Set();
  for (const f of changedFiles) {
    // Match src/<module>.cts (top-level src/, not nested)
    const m = f.match(/^src\/([^/]+)\.cts$/);
    if (m && COVERED[m[1]]) {
      changed.add(m[1]);
    }
  }
  return [...changed];
}

// ── Output formatting ─────────────────────────────────────────────────────────
function buildResult(moduleNames) {
  const include = moduleNames.map(name => ({
    name,
    mutate: COVERED[name].cjs,
    tests: COVERED[name].tests.join(' '),
    minScore: COVERED[name].minScore,
  }));

  return {
    has_work: include.length > 0 ? 'true' : 'false',
    matrix: { include },
  };
}

function printHuman(result, changedFiles) {
  console.log(`Changed files (${changedFiles.length}):`);
  for (const f of changedFiles) console.log(`  ${f}`);
  console.log('');
  console.log(`has_work: ${result.has_work}`);
  console.log(`Shards (${result.matrix.include.length}):`);
  for (const shard of result.matrix.include) {
    console.log(`  [${shard.name}]`);
    console.log(`    mutate:   ${shard.mutate}`);
    console.log(`    tests:    ${shard.tests}`);
    console.log(`    minScore: ${shard.minScore}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const changedFiles = resolveChangedFiles(args);
    const moduleNames = computeMatrix(changedFiles);
    const result = buildResult(moduleNames);

    if (args.print) {
      printHuman(result, changedFiles);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    if (err instanceof ExitError) throw err;
    console.error(`mutation-matrix: ${err.message}`);
    throw new ExitError(2);
  }
}

// Export internals for programmatic use (tests/mutation-matrix-ratchet.test.cjs).
// The require.main guard prevents main() from running when this file is require()d.
module.exports = { COVERED, TARGET_MUTATION_SCORE };

if (require.main === module) runMain(main);
