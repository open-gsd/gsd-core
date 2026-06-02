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
 *         { "name": "<module>", "mutate": "get-shit-done/bin/lib/<module>.cjs", "tests": "<space-joined test files>" },
 *         ...
 *       ]
 *     }
 *   }
 *
 * Exit codes: 0 always (empty matrix is not an error, has_work "false").
 */

const { execFileSync } = require('child_process');
const { readFileSync } = require('fs');

// ── Single source of truth: covered modules ───────────────────────────────────
// Each entry: { cjs: '<built artifact>', tests: ['tests/...', ...] }
// A module is "covered" iff its tests are wired into the Stryker command runner
// (stryker.config.mjs commandRunner.command). Mutating an uncovered module can
// only ever produce survived mutants — so we scope strictly to these 6.
const COVERED = {
  'context-utilization': {
    cjs: 'get-shit-done/bin/lib/context-utilization.cjs',
    tests: [
      'tests/context-utilization.property.test.cjs',
    ],
  },
  'prompt-budget': {
    cjs: 'get-shit-done/bin/lib/prompt-budget.cjs',
    tests: [
      'tests/prompt-budget.property.test.cjs',
      'tests/prompt-budget.unit.test.cjs',
    ],
  },
  frontmatter: {
    cjs: 'get-shit-done/bin/lib/frontmatter.cjs',
    tests: [
      'tests/frontmatter.property.test.cjs',
    ],
  },
  'adr-parser': {
    cjs: 'get-shit-done/bin/lib/adr-parser.cjs',
    tests: [
      'tests/adr-parser.property.test.cjs',
      'tests/adr-parser.test.cjs',
      'tests/adr-parser.unit.test.cjs',
    ],
  },
  'config-schema': {
    cjs: 'get-shit-done/bin/lib/config-schema.cjs',
    tests: [
      'tests/config-schema.property.test.cjs',
    ],
  },
  'active-workstream-store': {
    cjs: 'get-shit-done/bin/lib/active-workstream-store.cjs',
    tests: [
      'tests/active-workstream-store.test.cjs',
    ],
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
      process.exit(0);
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
    console.log(`    mutate: ${shard.mutate}`);
    console.log(`    tests:  ${shard.tests}`);
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
    console.error(`mutation-matrix: ${err.message}`);
    process.exit(2);
  }
}

main();
