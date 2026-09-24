#!/usr/bin/env node
'use strict';

/**
 * PR-branch `.planning/` path-classification drift guard (ADR-4910 §8, epic
 * #4906 Phase 5; issues #4605, #4606).
 *
 * `src/pr-branch-patterns.cts` (compiled to
 * `gsd-core/bin/lib/pr-branch-patterns.cjs`) is the single-source-of-truth
 * registry for the three `.planning/` path-classification values
 * `gsd-core/workflows/pr-branch.md` needs: `TRANSIENT_DIRS_SRC`,
 * `STRUCTURAL_RE_SRC`, and `MILESTONE_PHASES_RE_SRC`. A workflow markdown
 * file has no module system — it cannot `require()` that `.cts` source at
 * runtime — so its `create_pr_branch`/`verify` steps carry a hand-copied
 * mirror of each value inside a `NAME="..."` bash assignment. This guard
 * asserts each mirror still matches its canonical value VERBATIM, so the two
 * copies can never silently drift apart (the exact bug class ADR-2143 §3
 * names for markdown-mirrored source-of-truth values, applied here to a
 * bash-variable mirror instead of a pipe-table header).
 *
 * Modeled directly on `scripts/lint-table-schema-drift.cjs`: a standalone
 * node script (not a node:test), pure detector function + `scanRepo` seam,
 * wired into `lint:ci`, exit 0 clean / exit 1 + message on drift.
 */

const fs = require('node:fs');
const path = require('node:path');

// Canonical-source-constant name -> the exact bash variable name it mirrors
// inside gsd-core/workflows/pr-branch.md.
const PATTERN_VARS = {
  TRANSIENT_DIRS_SRC: 'TRANSIENT_DIRS',
  STRUCTURAL_RE_SRC: 'STRUCTURAL_RE',
  MILESTONE_PHASES_RE_SRC: 'MILESTONE_PHASES_RE',
};

const WORKFLOW_REL_PATH = path.join('gsd-core', 'workflows', 'pr-branch.md');

/** Build the exact `NAME="value"` bash assignment line for one pattern. */
function buildAssignment(bashVar, value) {
  return `${bashVar}="${value}"`;
}

/**
 * Pure: given `patterns` (a `{ SRC_CONST_NAME: value }` map, shaped like the
 * `pr-branch-patterns.cjs` seam) and a `readFile(relPath) -> string|null`
 * accessor, find every pattern whose exact `NAME="value"` assignment does
 * not appear verbatim in the canonical workflow file. Returns
 * `[{ constName, bashVar, expected, reason }]`; empty when clean.
 */
function findPrBranchPatternDrift(patterns, readFile, vars = PATTERN_VARS, workflowPath = WORKFLOW_REL_PATH) {
  const violations = [];
  const content = readFile(workflowPath);

  for (const [constName, bashVar] of Object.entries(vars)) {
    const value = patterns[constName];
    if (typeof value !== 'string') {
      violations.push({
        constName,
        bashVar,
        expected: null,
        reason: `${constName} missing or not a string in the pr-branch-patterns seam`,
      });
      continue;
    }

    if (content == null) {
      violations.push({
        constName,
        bashVar,
        expected: buildAssignment(bashVar, value),
        reason: 'source file not found or unreadable',
      });
      continue;
    }

    const expected = buildAssignment(bashVar, value);
    if (!content.includes(expected)) {
      violations.push({
        constName,
        bashVar,
        expected,
        reason: 'assignment not found verbatim in canonical workflow file',
      });
    }
  }
  return violations;
}

/**
 * Load the built seam and scan the real repo tree. Returns the same shape as
 * `findPrBranchPatternDrift`. If the seam hasn't been built yet (`npm run
 * build:lib`), reports a single actionable violation rather than throwing.
 */
function scanRepo(root) {
  const seamPath = path.join(root, 'gsd-core', 'bin', 'lib', 'pr-branch-patterns.cjs');
  let seam;
  try {
    seam = require(seamPath);
  } catch (e) {
    return [{
      constName: null,
      bashVar: null,
      expected: null,
      reason: `cannot load the pr-branch-patterns seam at ${path.relative(root, seamPath)} — run 'npm run build:lib' first (${e.message})`,
    }];
  }

  const readFile = (relPath) => {
    try {
      return fs.readFileSync(path.join(root, relPath), 'utf8');
    } catch {
      return null;
    }
  };

  return findPrBranchPatternDrift(seam, readFile);
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write(
      'ok pr-branch-pattern-drift: every pr-branch-patterns.cts constant appears verbatim in gsd-core/workflows/pr-branch.md\n',
    );
    return;
  }
  process.stderr.write(
    'pr-branch-pattern-drift: pr-branch-patterns.cts constant(s) whose assignment is absent from gsd-core/workflows/pr-branch.md (ADR-4910 §8, #4605).\n',
  );
  process.stderr.write(
    'Either update gsd-core/workflows/pr-branch.md to mirror the canonical value verbatim, or update\n'
      + 'src/pr-branch-patterns.cts to match — the two must never drift.\n',
  );
  for (const v of violations) {
    const id = v.bashVar ? `${v.constName} (${v.bashVar})` : (v.constName ?? '?');
    const expected = v.expected ? ` — expected ${JSON.stringify(v.expected)}` : '';
    process.stderr.write(`  ${id}: ${v.reason}${expected}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findPrBranchPatternDrift, scanRepo, buildAssignment, PATTERN_VARS, WORKFLOW_REL_PATH,
};
