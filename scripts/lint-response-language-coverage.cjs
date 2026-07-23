#!/usr/bin/env node
/**
 * lint-response-language-coverage.cjs
 *
 * Enforces #2529: every workflow must be covered by the response-language
 * contract, so a workflow can never ship English-only when the user has
 * configured `response_language`.
 *
 * A workflow file passes when it contains EITHER:
 *   - a reference to the shared directive
 *     (`references/response-language-directive.md`), OR
 *   - its own inline `response_language` directive (the ~half of the catalog
 *     that already carried one before #2529, plus workflow-specific extracts
 *     like `references/execute-phase-response-language.md`).
 *
 * The check is intentionally a substring test, mirroring the shape of the
 * failure it guards against: the historical gap was files with ZERO mention
 * of `response_language` at all (44 of 91 at the time of #2529) — those ran
 * fully in English regardless of configuration.
 *
 * Exit 0 if every workflow is covered; exit 1 with a per-file listing if not.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const SHARED_REF = 'references/response-language-directive.md';

function findMarkdownFilesRecursive(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findMarkdownFilesRecursive(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files.sort();
}

function findViolations(workflowsDir) {
  return findMarkdownFilesRecursive(workflowsDir).filter((file) => {
    const content = fs.readFileSync(file, 'utf8');
    return !content.includes(SHARED_REF) && !content.includes('response_language');
  });
}

function main() {
  const files = findMarkdownFilesRecursive(WORKFLOWS_DIR);
  const violations = findViolations(WORKFLOWS_DIR);

  if (violations.length > 0) {
    console.error(
      `lint-response-language-coverage: ${violations.length} workflow(s) have no response-language coverage (#2529).\n` +
      `Each workflow must either @-reference the shared directive (@~/.claude/gsd-core/${SHARED_REF})\n` +
      `or carry its own inline \`response_language\` directive:\n\n` +
      violations.map((file) => `  - gsd-core/workflows/${path.relative(WORKFLOWS_DIR, file).replaceAll(path.sep, '/')}`).join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  console.log(`lint-response-language-coverage: OK (${files.length} workflows covered)`);
}

if (require.main === module) main();

module.exports = { findMarkdownFilesRecursive, findViolations };
