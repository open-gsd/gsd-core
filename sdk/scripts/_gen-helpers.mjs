/**
 * Shared helpers for gen-*.mjs generator scripts.
 *
 * Provides requireFreshDist(), a pre-generation guard that verifies the
 * compiled sdk/dist artifact is newer than its TypeScript source. If the
 * dist file is missing or stale, the function exits 1 with a clear,
 * actionable error message so the developer knows to run `npm run build:sdk`.
 *
 * Single source of truth — import from here rather than duplicating the mtime
 * logic in each generator.
 *
 * @example
 *   import { requireFreshDist } from './_gen-helpers.mjs';
 *   requireFreshDist('sdk/dist/query/secrets.js', 'sdk/src/query/secrets.ts');
 */

import { statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from this file's location (sdk/scripts/ → repo root)
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * Assert that a compiled dist file is at least as new as its TypeScript source.
 *
 * Design notes:
 *   - Single Responsibility: each generator is responsible for verifying its
 *     own preconditions before touching dist. This keeps the guard co-located
 *     with the code that depends on it.
 *   - Composability: callers that have already built can call generators
 *     directly; the guard is a cheap mtime check, not a rebuild trigger.
 *   - Debuggability: the error message names both paths and both mtimes so the
 *     developer can see at a glance what is stale and what to do about it.
 *   - Performance: two synchronous statSync calls — effectively zero cost
 *     relative to the import/transform work the generator does next.
 *
 * NOT auto-building: auto-building inside the generator couples it to the
 * build toolchain, bloats its dependency graph, and removes composability —
 * a caller that already built cannot skip the redundant rebuild. The guard
 * pattern is the correct separation: tell the developer what to do, not do it
 * for them.
 *
 * @param {string} distPath - Repo-relative path to the compiled dist file,
 *   e.g. 'sdk/dist/query/secrets.js'
 * @param {string} tsSourcePath - Repo-relative path to the TypeScript source
 *   file, e.g. 'sdk/src/query/secrets.ts'
 */
export function requireFreshDist(distPath, tsSourcePath) {
  const distAbs = resolve(REPO_ROOT, distPath);
  const tsAbs = resolve(REPO_ROOT, tsSourcePath);

  if (!existsSync(distAbs)) {
    console.error(
      `ERROR: ${distPath} does not exist. Run \`npm run build:sdk\` first.`,
    );
    process.exit(1);
  }

  if (!existsSync(tsAbs)) {
    console.error(
      `ERROR: ${tsSourcePath} does not exist. Cannot verify dist freshness.`,
    );
    process.exit(1);
  }

  const distMtime = statSync(distAbs).mtimeMs;
  const tsMtime = statSync(tsAbs).mtimeMs;

  if (distMtime < tsMtime) {
    console.error(
      `ERROR: ${distPath} is stale relative to ${tsSourcePath} ` +
        `(dist mtime ${new Date(distMtime).toISOString()}, ` +
        `ts mtime ${new Date(tsMtime).toISOString()}). ` +
        `Run \`npm run build:sdk\` first.`,
    );
    process.exit(1);
  }
}
