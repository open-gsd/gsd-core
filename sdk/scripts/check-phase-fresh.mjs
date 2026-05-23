#!/usr/bin/env node
/**
 * Freshness check for phase.generated.cjs.
 *
 * Regenerates the expected CJS content in-memory (without writing to disk) and
 * compares it to the committed file. Exits 0 if they match, 1 if stale.
 *
 * Uses the same pattern as check-project-root-fresh.mjs: imports buildPhaseCjs()
 * from the generator directly rather than duplicating the build logic.
 *
 * Run: node sdk/scripts/check-phase-fresh.mjs
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
const { buildPhaseCjs } = await import('./gen-phase.mjs');

const expected = await buildPhaseCjs();

const committedPath = resolve(here, '..', '..', 'get-shit-done', 'bin', 'lib', 'phase.generated.cjs');
const committed = await readFile(committedPath, 'utf-8');

if (expected === committed) {
  console.log('phase.generated.cjs is fresh');
  process.exit(0);
} else {
  console.error('phase.generated.cjs is STALE.');
  console.error('Regenerate: cd sdk && npm run gen:phase');
  process.exit(1);
}
