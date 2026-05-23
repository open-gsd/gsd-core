#!/usr/bin/env node
/**
 * Generator for the Validate CJS artifact.
 *
 * Reads the compiled ESM output from sdk/dist/query/validate.js, extracts the
 * pure helpers and constants, then emits
 * get-shit-done/bin/lib/validate.generated.cjs.
 *
 * The generated module exports seven items (three from issue #6, four from #26):
 *
 *   Issue #6 drift items:
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
 *   Issue #26 drift items:
 *   4. phaseDirNameRe (PHASE_DIR_NAME_RE) — regex constant for W005 phase
 *      directory naming check. /^\d{2,}(?:\.\d+)*-[\w-]+$/ accepts multi-digit
 *      prefixes. verify.cjs Check 6 previously had an inline copy.
 *
 *   5. PHASE_TOKEN_FROM_DIR_RE — regex constant used by forEachArchivedPhaseToken()
 *      to extract the phase token from a directory name. verify.cjs had an inline copy.
 *
 *   6. MILESTONE_ARCHIVE_DIR_RE — regex constant used to identify milestone archive
 *      directories under .planning/milestones/. verify.cjs had an inline copy.
 *
 *   7. canonicalPlanStem(stem) — converts a PLAN file stem to its canonical form for
 *      PLAN/SUMMARY matching (I001 check). '68-01-scaffolding' → '68-01'.
 *      verify.cjs Check 7 previously had an inline copy.
 *
 * Extraction approach: phaseVariants is a closure inside validateHealth (not a module
 * export), extracted via brace-balanced source-text parsing. Named constants and top-level
 * functions (PHASE_DIR_NAME_RE, PHASE_TOKEN_FROM_DIR_RE, MILESTONE_ARCHIVE_DIR_RE,
 * canonicalPlanStem) are extracted by simple line-scanning from the compiled source.
 *
 * Run:    cd sdk && npm run gen:validate
 * Check:  node sdk/scripts/check-validate-fresh.mjs
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #6 (open-gsd/get-shit-done-redux)
 *   - Issue #26 (open-gsd/get-shit-done-redux) — #26 extends issue #6's generator
 *   - PR #154 (issue #4) — generator pattern precedent
 *   - PR #156 (issue #6) — validate.ts generator that #26 extends
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
 * Validate Helpers — pure computation helpers and regex constants extracted from
 * sdk/src/query/validate.ts. No I/O. No async. No filesystem operations.
 *
 * Issue #6 drift items (three helpers):
 *   1. phaseVariants() — replaces parseInt-based padded/unpadded check in verify.cjs
 *      Check 8 (W006 disk-existence and W007 roadmap-membership checks).
 *   2. buildRoadmapPhaseVariants() — replaces raw roadmapPhases set in W007 loop.
 *   3. buildNotStartedPhaseVariants() — replaces raw+zero-padded notStartedPhases
 *      in W006 skip logic.
 *
 * Issue #26 drift items (four constants/helpers):
 *   4. phaseDirNameRe — W005 phase directory naming regex (was inline in verify.cjs Check 6).
 *   5. PHASE_TOKEN_FROM_DIR_RE — extracts phase token from dir name (was inline in
 *      verify.cjs forEachArchivedPhaseToken / collectDiskPhases).
 *   6. MILESTONE_ARCHIVE_DIR_RE — identifies milestone archive directories (was inline).
 *   7. canonicalPlanStem() — I001 PLAN/SUMMARY stem canonicalization (was inline in Check 7).
 *
 * I/O adapter pattern (ADR-3524 §4): pure transforms extracted from the SDK.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #6 (open-gsd/get-shit-done-redux)
 *   - Issue #26 (open-gsd/get-shit-done-redux)
 *   - PR #154 (issue #4) — generator pattern precedent
 *   - PR #156 (issue #6) — validate.ts generator that #26 extends
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

/**
 * Extract a top-level const RegExp assignment from the source.
 *
 * Looks for the line `const <name> = /<pattern>/<flags>;` and returns the full
 * assignment statement as a `module.exports`-compatible const declaration
 * (renaming to the export name when it differs from the source name).
 *
 * @param {string} source - Compiled JS source text
 * @param {string} sourceName - The const name as it appears in the compiled output
 * @param {string} [exportName] - The name to export under (defaults to sourceName)
 */
function extractConstRegExp(source, sourceName, exportName) {
  const nameToUse = exportName ?? sourceName;
  const lines = source.split('\n');
  // Match both `const <name> = ...` and `export const <name> = ...`
  const suffix = `const ${sourceName} = `;
  const line = lines.find((l) => l === suffix.trimStart() + l.slice(suffix.trimStart().length)
    || l.startsWith(suffix) || l.startsWith(`export ${suffix}`));
  // Simpler: find a line that contains `const <name> = ` (anywhere after optional export)
  const matchLine = lines.find((l) => {
    const trimmed = l.replace(/^export\s+/, '');
    return trimmed.startsWith(`const ${sourceName} = `);
  });
  if (!matchLine) throw new Error(`Could not find "const ${sourceName} = ..." in compiled validate.js`);
  // Extract just the value (after `const <name> = `)
  const assignIdx = matchLine.indexOf(`const ${sourceName} = `);
  const valueStart = assignIdx + `const ${sourceName} = `.length;
  const value = matchLine.slice(valueStart).replace(/;$/, '').trim();
  return `const ${nameToUse} = ${value};`;
}

/**
 * Extract a top-level named function declaration from the source.
 *
 * Matches `function <name>(<params>) {` and extracts the complete function body
 * using a brace-balanced parser.
 *
 * @param {string} source - Compiled JS source text
 * @param {string} name - The function name as it appears in the compiled output
 */
function extractTopLevelFunction(source, name) {
  // Match a top-level function declaration (not prefixed by spaces/async/export)
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Could not find top-level function "${name}" in compiled validate.js`);

  const braceOpen = source.indexOf('{', start);
  let depth = 0;
  let i = braceOpen;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

export async function buildValidateCjs() {
  const distUrl = new URL('../dist/query/validate.js', import.meta.url);
  const validateSource = await readFile(fileURLToPath(distUrl), 'utf-8');

  const phaseVariantsBody = extractPhaseVariantsBody(validateSource);

  // Issue #26: extract regex constants and canonicalPlanStem from compiled output.
  //
  // phaseDirNameRe — the PHASE_DIR_NAME_RE constant added to validate.ts for W005.
  //   Named 'phaseDirNameRe' in the export (camelCase for JS convention).
  const phaseDirNameReLine = extractConstRegExp(validateSource, 'PHASE_DIR_NAME_RE', 'phaseDirNameRe');

  // PHASE_TOKEN_FROM_DIR_RE — extracts phase token from a directory name like "64-auth-service".
  //   Exported under its original name for direct use in verify.cjs.
  const phaseTokenFromDirReLine = extractConstRegExp(validateSource, 'PHASE_TOKEN_FROM_DIR_RE');

  // MILESTONE_ARCHIVE_DIR_RE — matches milestone archive dir names like "v1.0-phases".
  const milestoneArchiveDirReLine = extractConstRegExp(validateSource, 'MILESTONE_ARCHIVE_DIR_RE');

  // canonicalPlanStem(stem) — I001 PLAN/SUMMARY stem canonicalization.
  //   '68-01-scaffolding' → '68-01'. Top-level named function in the compiled output.
  const canonicalPlanStemBody = extractTopLevelFunction(validateSource, 'canonicalPlanStem');

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
    // Issue #26: regex constants extracted from compiled validate.js
    '// ── Issue #26: regex constants (W005, W006-archived) ────────────────────────',
    phaseDirNameReLine,
    phaseTokenFromDirReLine,
    milestoneArchiveDirReLine,
    '',
    // Issue #26: canonicalPlanStem (I001)
    '// ── Issue #26: I001 canonicalization ────────────────────────────────────────',
    canonicalPlanStemBody,
    '',
    // Issue #6: phaseVariants closure (W006/W007)
    '// ── Issue #6: phase variant helpers (W006/W007) ──────────────────────────────',
    phaseVariantsBody,
    '',
    buildRoadmapPhaseVariantsBody,
    '',
    buildNotStartedPhaseVariantsBody,
    '',
    `module.exports = {
  // Issue #26 exports (W005 regex, W006-archived regex constants, I001 helper)
  phaseDirNameRe,
  PHASE_TOKEN_FROM_DIR_RE,
  MILESTONE_ARCHIVE_DIR_RE,
  canonicalPlanStem,
  // Issue #6 exports (W006/W007 phase variant helpers)
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
