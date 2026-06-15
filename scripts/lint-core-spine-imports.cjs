#!/usr/bin/env node
'use strict';

/**
 * Migration-convergence lint for the core re-export spine (issue #1268).
 *
 * The spine (core.cjs) is being staged for retirement: each tranche migrates a
 * set of leaf importers to consume the individual modules directly. This lint
 * makes CI RED the moment a NEW file starts importing the spine, preventing
 * regressions as the tranche work proceeds.
 *
 * Allowlisted importers (the "T0 set") are files that already imported the
 * spine when this lint was introduced. Entries are REMOVED from the allowlist
 * as each tranche migrates a leaf. The allowlist + this script are deleted in
 * T-final.
 *
 * Model: scripts/lint-package-identity-drift.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Core-spine import detection
// ---------------------------------------------------------------------------

/**
 * Matches any import form that targets the core spine at any relative depth,
 * including the TS `import x = require(...)` form, dynamic imports, and bare
 * side-effect imports.
 *
 * Patterns matched (illustrative):
 *   require('./core.cjs')
 *   require('./core')
 *   require('../core.cjs')
 *   require('./lib/core.cjs')
 *   require('../lib/core.cjs')
 *   require('../../lib/core.cjs')
 *   from './core.cjs'
 *   import core = require('../lib/core.cjs')
 *   import('./core.cjs')            dynamic import
 *   await import('../lib/core.cjs') dynamic import
 *   import './core.cjs';            bare side-effect import
 *
 * Patterns NOT matched (boundary after bare `core` is quote or `.cjs`):
 *   require('./core-utils.cjs')
 *   require('./core-schema.cjs')
 *
 * The `import\s+` branch (bare side-effect) will NOT match
 * `import x = require(...)` because a non-quote token follows `import `.
 */
const CORE_IMPORT_RE = /(?:require\(\s*|import\s*\(\s*|from\s+|import\s+)['"](?:\.\.?\/)+(?:lib\/)?core(?:\.cjs)?['"]/;

/**
 * Return true if `line` is a real (non-commented) core-spine import.
 * @param {string} line
 * @returns {boolean}
 */
function lineImportsSpine(line) {
  if (line.trimStart().startsWith('//')) return false;
  return CORE_IMPORT_RE.test(line);
}

// ---------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------

/**
 * Recursively collect files under `dir` matching `extSet`, skipping
 * `node_modules`, `.git`, `.memdb`, and any caller-supplied `skipDirs`.
 * (The caller is responsible for scoping roots; this function does NOT itself
 * skip `tests/` — that exclusion is achieved by not passing `tests/` as a root.)
 *
 * @param {string} dir           - Absolute directory to walk.
 * @param {Set<string>} extSet   - File extensions to include (e.g. new Set(['.cts','.cjs'])).
 * @param {Set<string>} skipDirs - Absolute paths of directories to skip entirely.
 * @param {string[]} acc         - Accumulator (modified in place).
 * @returns {string[]}
 */
function walk(dir, extSet, skipDirs, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.memdb') continue;
      if (skipDirs.has(full)) continue;
      walk(full, extSet, skipDirs, acc);
    } else if (entry.isFile() && extSet.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Pure exported API
// ---------------------------------------------------------------------------

/**
 * Scan `roots` for source files that import the core spine but are not in
 * `allowlistSet`.
 *
 * @param {string[]} roots           - Absolute directories to scan.
 * @param {Set<string>} allowlistSet - Repo-relative POSIX paths that are
 *   allowed to import the spine (the T0 set).
 * @returns {{ file: string, line: number }[]}
 *   Repo-relative POSIX file path and 1-based line number for each violation.
 */
function scanCoreSpineImports(roots, allowlistSet) {
  const repoRoot = path.join(__dirname, '..');

  // gsd-core/bin/lib is excluded (generated artefacts — double-counts src/).
  const skipDirs = new Set([path.join(repoRoot, 'gsd-core', 'bin', 'lib')]);

  // src/*.cts → .cts only; gsd-core/bin/**/*.cjs → .cjs only.
  // Accept either extension in each root; walk will naturally skip unsupported
  // files via extSet filtering.
  const extSet = new Set(['.cts', '.cjs']);

  const violations = [];

  for (const root of roots) {
    const files = walk(root, extSet, skipDirs, []);
    for (const abs of files) {
      // Derive repo-relative POSIX path for allowlist lookup and reporting.
      const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');

      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }

      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lineImportsSpine(lines[i])) {
          if (!allowlistSet.has(rel)) {
            violations.push({ file: rel, line: i + 1 });
          }
          // Do NOT break: report every spine-import line so no violation is masked.
        }
      }
    }
  }

  return violations;
}

/**
 * Load the allowlist JSON and return a Set of repo-relative paths.
 *
 * @param {string} allowlistPath - Absolute path to the JSON file.
 * @returns {Set<string>}
 */
function loadAllowlist(allowlistPath) {
  const raw = fs.readFileSync(allowlistPath, 'utf8');
  const obj = JSON.parse(raw);
  return new Set(obj.allow || []);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main() {
  const repoRoot = path.join(__dirname, '..');
  const allowlistPath = path.join(__dirname, 'lint-core-spine-imports.allowlist.json');

  const allowlistSet = loadAllowlist(allowlistPath);

  const roots = [
    path.join(repoRoot, 'src'),
    path.join(repoRoot, 'gsd-core', 'bin'),
  ];

  const violations = scanCoreSpineImports(roots, allowlistSet);

  if (violations.length === 0) {
    process.stdout.write(
      `ok core-spine-imports: ${allowlistSet.size} allowlisted importer(s), 0 new\n`,
    );
    return;
  }

  process.stderr.write('core-spine-imports: new file(s) importing the core re-export spine detected.\n');
  process.stderr.write('The spine (core.cjs) is being retired (issue #1268). Import the leaf module\n');
  process.stderr.write('directly instead, or add to the allowlist only if genuinely transitional:\n');
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}\n`);
  }
  process.stderr.write(`core-spine-imports: ${violations.length} violation(s)\n`);
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { scanCoreSpineImports, loadAllowlist };
