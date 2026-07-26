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
 * A bare config-field mention is not coverage: the same line must direct how
 * user-facing output is rendered, or the workflow must load a known directive.
 *
 * Exit 0 if every workflow is covered; exit 1 with a per-file listing if not.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const DIRECTIVE_REFS = [
  'references/response-language-directive.md',
  'references/execute-phase-response-language.md',
];
// verify-phase.md is not entered directly: execute-phase.md injects the exact
// response-language contract into the gsd-verifier dispatch prompt. Pin both
// ends so deleting or weakening that dispatch makes the lint fail closed.
const PARENT_INJECTED_WORKFLOWS = new Map([
  ['verify-phase.md', {
    parent: 'execute-phase.md',
    directive: 'Use response_language {response_language} for all user-facing prose; preserve code and paths.',
  }],
]);
const DIRECTIVE_ACTION_RE = /\b(?:apply|present|render|respond|translate|use|write|must|should)\b/i;
const USER_OUTPUT_RE = /\b(?:explanations?|language|narration|output|prompts?|prose|questions?|templates?|user-facing)\b/i;

function findMarkdownFilesRecursive(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findMarkdownFilesRecursive(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files.sort();
}

function hasResponseLanguageCoverage(content) {
  if (DIRECTIVE_REFS.some((ref) => content.includes(ref))) return true;

  return content.split(/\r?\n/).some((line) =>
    /\bresponse_language\b/i.test(line) &&
    DIRECTIVE_ACTION_RE.test(line) &&
    USER_OUTPUT_RE.test(line)
  );
}

function findViolations(workflowsDir) {
  return findMarkdownFilesRecursive(workflowsDir).filter((file) => {
    const relative = path.relative(workflowsDir, file).replaceAll(path.sep, '/');
    const injection = PARENT_INJECTED_WORKFLOWS.get(relative);
    if (injection) {
      const parentPath = path.join(workflowsDir, injection.parent);
      if (
        fs.existsSync(parentPath) &&
        fs.readFileSync(parentPath, 'utf8').includes(injection.directive)
      ) return false;
    }
    const content = fs.readFileSync(file, 'utf8');
    return !hasResponseLanguageCoverage(content);
  });
}

function main(workflowsDir = WORKFLOWS_DIR, io = console) {
  const files = findMarkdownFilesRecursive(workflowsDir);
  const violations = findViolations(workflowsDir);

  if (violations.length > 0) {
    io.error(
      `lint-response-language-coverage: ${violations.length} workflow(s) have no response-language coverage (#2529).\n` +
      `Each workflow must either @-reference a recognized response-language directive\n` +
      `or carry its own inline \`response_language\` directive (unless its parent injects one):\n\n` +
      violations.map((file) => `  - ${path.relative(workflowsDir, file).replaceAll(path.sep, '/')}`).join('\n'),
    );
    return 1;
  }

  io.log(`lint-response-language-coverage: OK (${files.length} workflows covered)`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  findMarkdownFilesRecursive,
  findViolations,
  hasResponseLanguageCoverage,
  main,
};
