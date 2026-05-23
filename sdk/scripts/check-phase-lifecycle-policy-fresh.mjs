#!/usr/bin/env node
/**
 * Freshness check for phase-lifecycle-policy.generated.cjs.
 *
 * Regenerates the expected CJS content in-memory (without writing to disk) and
 * compares it to the committed file. Exits 0 if they match, 1 if stale.
 *
 * Uses the same pattern as check-project-root-fresh.mjs: imports
 * buildPhaseLifecyclePolicyCjs() from the generator directly.
 *
 * Run: node sdk/scripts/check-phase-lifecycle-policy-fresh.mjs
 * (Requires sdk/dist to be built first — `npm run build` in sdk/.)
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #4 (open-gsd/get-shit-done-redux)
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Import the generator function directly (avoids duplicating logic).
const { buildPhaseLifecyclePolicyCjs } = await import('./gen-phase-lifecycle-policy.mjs');

const expected = await buildPhaseLifecyclePolicyCjs();

const committedPath = resolve(here, '..', '..', 'get-shit-done', 'bin', 'lib', 'phase-lifecycle-policy.generated.cjs');
const committed = await readFile(committedPath, 'utf-8');

if (expected === committed) {
  console.log('phase-lifecycle-policy.generated.cjs is fresh');
  process.exit(0);
} else {
  console.error('phase-lifecycle-policy.generated.cjs is STALE.');
  console.error('Regenerate: cd sdk && npm run gen:phase-lifecycle-policy');
  process.exit(1);
}
