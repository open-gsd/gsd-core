#!/usr/bin/env node
/**
 * Generator for the Validate CJS artifact.
 *
 * Reads the compiled ESM output from sdk/dist/query/validate.js, extracts the
 * pure `phaseVariants` helper function via source-text extraction (it is a
 * closure inside validateHealth, not a module-level export), then emits
 * get-shit-done/bin/lib/validate.generated.cjs.
 *
 * The generated module exports three pure helpers that were missing from
 * verify.cjs (the three drift items from issue #6):
 *
 *   1. phaseVariants(phase) — generates all normalized variants of a phase
 *      token (padded/unpadded/letter-suffix). Used for W006 disk-existence check
 *      and W007 roadmap-membership check in verify.cjs Check 8.
 *
 *   2. buildRoadmapPhaseVariants(roadmapContent) — parses ROADMAP.md and builds
 *      the Set of all variants of all roadmap phases. Used by the W007
 *      check. verify.cjs previously used only raw phase tokens (no variants).
 *
 *   3. buildNotStartedPhaseVariants(roadmapContent) — parses ROADMAP.md unchecked
 *      phase entries and builds a Set of all variants. Used for the W006
 *      unchecked-phase skip. verify.cjs previously added only raw+zero-padded
 *      (dropping letter suffix via parseInt).
 *
 * Extraction approach: since phaseVariants is defined as a closure inside
 * validateHealth (not a module export), it is extracted from the compiled source
 * text using a brace-balanced parser — the same approach used to extract
 * escapeRegex in gen-phase-lifecycle-policy.mjs.
 *
 * Run:    cd sdk && npm run gen:validate
 * Check:  node sdk/scripts/check-validate-fresh.mjs
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #6 (open-gsd/get-shit-done-redux)
 *   - PR #154 (issue #4) — generator pattern precedent
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const BANNER = `'use strict';

/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: sdk/src/query/validate.ts
 * Regenerate: cd sdk && npm run gen:validate
 *
 * Validate Helpers — pure computation helpers for phase variant normalization,
 * roadmap phase variant set construction, and unchecked-phase skip set construction.
 * No I/O. No async. No filesystem operations.
 *
 * These three helpers cure the three drift items from issue #6:
 *   1. phaseVariants() — replaces parseInt-based padded/unpadded check in verify.cjs
 *      Check 8 (W006 disk-existence and W007 roadmap-membership checks).
 *   2. buildRoadmapPhaseVariants() — replaces raw roadmapPhases set in W007 loop.
 *   3. buildNotStartedPhaseVariants() — replaces raw+zero-padded notStartedPhases
 *      in W006 skip logic.
 *
 * I/O adapter pattern (ADR-3524 §4): pure transforms extracted from the SDK.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #6 (open-gsd/get-shit-done-redux)
 *   - PR #154 (issue #4) — generator pattern precedent
 */

`;

/**
 * Extract phaseVariants from compiled validate.js source text.
 *
 * phaseVariants is defined as a const arrow function closure inside validateHealth.
 * It starts with the literal `const phaseVariants = (phase) => {` and ends at the
 * matching closing brace. We re-emit it as a standalone named function declaration.
 */
function extractPhaseVariantsBody(validateSource) {
  const marker = 'const phaseVariants = (phase) => {';
  const start = validateSource.indexOf(marker);
  if (start === -1) throw new Error('Could not find phaseVariants in compiled validate.js');

  // Find the opening brace of the arrow function body
  const braceOpen = validateSource.indexOf('{', start + marker.length - 1);
  let depth = 0;
  let i = braceOpen;
  for (; i < validateSource.length; i++) {
    if (validateSource[i] === '{') depth++;
    else if (validateSource[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  // Extract just the body content (between the braces)
  const bodyContent = validateSource.slice(braceOpen + 1, i);

  // Emit as a standalone named function so verify.cjs can require() and call it.
  return `function phaseVariants(phase) {\n${bodyContent}\n}`;
}

export async function buildValidateCjs() {
  const distUrl = new URL('../dist/query/validate.js', import.meta.url);
  const validateSource = await readFile(fileURLToPath(distUrl), 'utf-8');

  const phaseVariantsBody = extractPhaseVariantsBody(validateSource);

  // buildRoadmapPhaseVariants: parse ROADMAP.md and return {roadmapPhases, roadmapPhaseVariants}
  // roadmapPhases — raw phase tokens as written in headings (used for W006 check)
  // roadmapPhaseVariants — all normalized variants of each roadmap phase (used for W007 check)
  const buildRoadmapPhaseVariantsBody = `function buildRoadmapPhaseVariants(roadmapContent) {
  const roadmapPhases = new Set();
  const roadmapPhaseVariants = new Set();
  const phasePattern = /#{2,4}\\s*Phase\\s+(\\d+[A-Z]?(?:\\.\\d+)*)\\s*:/gi;
  let m;
  while ((m = phasePattern.exec(roadmapContent)) !== null) {
    roadmapPhases.add(m[1]);
    for (const variant of phaseVariants(m[1])) roadmapPhaseVariants.add(variant);
  }
  return { roadmapPhases, roadmapPhaseVariants };
}`;

  // buildNotStartedPhaseVariants: parse ROADMAP.md unchecked entries and return
  // a Set of all variants of each unchecked phase (used for W006 skip logic).
  const buildNotStartedPhaseVariantsBody = `function buildNotStartedPhaseVariants(roadmapContent) {
  const notStartedPhases = new Set();
  const uncheckedPattern = /-\\s*\\[\\s\\]\\s*\\*{0,2}Phase\\s+(\\d+[A-Z]?(?:\\.\\d+)*)[:\\s*]/gi;
  let um;
  while ((um = uncheckedPattern.exec(roadmapContent)) !== null) {
    for (const variant of phaseVariants(um[1])) notStartedPhases.add(variant);
  }
  return notStartedPhases;
}`;

  const parts = [
    BANNER.trimEnd(),
    '',
    phaseVariantsBody,
    '',
    buildRoadmapPhaseVariantsBody,
    '',
    buildNotStartedPhaseVariantsBody,
    '',
    `module.exports = {
  phaseVariants,
  buildRoadmapPhaseVariants,
  buildNotStartedPhaseVariants,
};`,
    '',
  ];

  return parts.join('\n');
}

async function main() {
  const content = await buildValidateCjs();
  const outPath = fileURLToPath(
    new URL('../../get-shit-done/bin/lib/validate.generated.cjs', import.meta.url),
  );
  await writeFile(outPath, content, 'utf-8');
  console.log(`Written: ${outPath}`);
}

// Only run main() when this file is the entry point.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
