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
 * A workflow FRAGMENT (`<workflow>/<modes|steps|templates>/<name>.md`, the shape
 * the #1671 fragment epic extracts) additionally passes when its parent workflow
 * names that exact fragment path and is itself covered — see
 * `inheritsParentCoverage`, which proves the inheritance per file instead of
 * granting it to a directory.
 *
 * Exit 0 only when workflows were actually found AND every one of them is
 * covered; exit 1 with a per-file listing if not. "No violations" alone is not
 * a pass: a run that inspected nothing has established nothing.
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
const INLINE_RESPONSE_LANGUAGE_DIRECTIVE =
  'Apply response_language to all user-facing prose; preserve code, paths, and identifiers.';
// These lazy-loaded modes/steps/templates cannot rely on an eager @-reference.
// Pin their shared wording (plus settings-advanced's former bare field mention)
// so a partial typo or rewording cannot silently split the contract.
const EXACT_INLINE_DIRECTIVE_WORKFLOWS = new Set([
  'discuss-phase/modes/advisor.md',
  'discuss-phase/modes/all.md',
  'discuss-phase/modes/analyze.md',
  'discuss-phase/modes/auto.md',
  'discuss-phase/modes/batch.md',
  'discuss-phase/modes/chain.md',
  'discuss-phase/modes/default.md',
  'discuss-phase/modes/power.md',
  'discuss-phase/modes/text.md',
  'discuss-phase/templates/context.md',
  'discuss-phase/templates/discussion-log.md',
  'execute-phase/steps/codebase-drift-gate.md',
  'execute-phase/steps/executor-isolation-dispatch.md',
  'execute-phase/steps/per-plan-worktree-gate.md',
  'execute-phase/steps/post-merge-gate.md',
  'execute-phase/steps/gap-closure-artifacts.md',
  'execute-phase/steps/partial-wave.md',
  'execute-phase/steps/regression-gate.md',
  'execute-phase/steps/regression-gate-run.md',
  'execute-phase/steps/worktree-recovery-policy.md',
  'help/modes/brief.md',
  'help/modes/default.md',
  'help/modes/full.md',
  'help/modes/topic.md',
  'plan-phase/steps/adr-ingest-express-path.md',
  'plan-phase/steps/chunked-planning-mode.md',
  'plan-phase/steps/closed-phase-gate.md',
  'plan-phase/steps/prd-express-gate.md',
  'plan-phase/steps/research-only-early-exit.md',
  'plan-phase/steps/research-only-modifiers.md',
  'plan-phase/steps/reviews-prerequisite.md',
  'plan-phase/steps/stall-detection-helpers.md',
  'plan-phase/steps/prd-express-path.md',
  'plan-phase/steps/windows-troubleshooting.md',
  'settings-advanced.md',
]);
// verify-phase.md is not entered directly: execute-phase.md injects the exact
// response-language contract into the gsd-verifier dispatch prompt. Pin both
// ends so deleting or weakening that dispatch makes the lint fail closed.
const PARENT_INJECTED_WORKFLOWS = new Map([
  ['verify-phase.md', {
    parent: 'execute-phase.md',
    directive: 'Use response_language {response_language} for all user-facing prose; preserve code and paths.',
  }],
]);
// Fragment directories produced by the workflow-fragment epic (#1671). A file
// under one of these is a SECTION of its parent workflow, never an entry point:
// the only way in is the `read and execute gsd-core/workflows/<path>` stub the
// parent emits, which fires with the parent — and therefore the parent's
// response-language directive — already loaded.
const FRAGMENT_DIRS = new Set(['modes', 'steps', 'templates']);
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

/**
 * A fragment inherits its parent workflow's coverage, but only when the
 * inheritance is PROVEN per file rather than assumed from the directory:
 *   1. the path is `<workflow>/<fragment-dir>/<name>.md`,
 *   2. `<workflow>.md` exists and names this exact fragment path — i.e. the
 *      parent really is the way in, and
 *   3. the parent is itself covered.
 * A fragment nobody references, or one hanging off an uncovered parent, stays a
 * violation. Without this the lint reds on every new fragment the #1671 epic
 * extracts, even though the extraction moved prose that was already covered.
 */
function inheritsParentCoverage(workflowsDir, relative) {
  const segments = relative.split('/');
  if (segments.length !== 3 || !FRAGMENT_DIRS.has(segments[1])) return false;
  const parentPath = path.join(workflowsDir, `${segments[0]}.md`);
  if (!fs.existsSync(parentPath)) return false;
  const parent = fs.readFileSync(parentPath, 'utf8');
  if (!parent.includes(`gsd-core/workflows/${relative}`)) return false;
  return hasResponseLanguageCoverage(parent);
}

function findViolations(workflowsDir) {
  return findMarkdownFilesRecursive(workflowsDir).filter((file) => {
    const relative = path.relative(workflowsDir, file).replaceAll(path.sep, '/');
    const content = fs.readFileSync(file, 'utf8');
    if (EXACT_INLINE_DIRECTIVE_WORKFLOWS.has(relative)) {
      return !content.split(/\r?\n/).includes(INLINE_RESPONSE_LANGUAGE_DIRECTIVE);
    }
    const injection = PARENT_INJECTED_WORKFLOWS.get(relative);
    if (injection) {
      const parentPath = path.join(workflowsDir, injection.parent);
      if (
        fs.existsSync(parentPath) &&
        fs.readFileSync(parentPath, 'utf8').includes(injection.directive)
      ) return false;
    }
    if (hasResponseLanguageCoverage(content)) return false;
    return !inheritsParentCoverage(workflowsDir, relative);
  });
}

function main(workflowsDir = WORKFLOWS_DIR, io = console) {
  // The catalog is discovered, not declared, so an unreadable or empty
  // directory yields an empty violation list — indistinguishable from full
  // coverage if the only success condition is `violations.length === 0`. Both
  // discovery failures below are therefore lint failures in their own right:
  // a stripped install tree, a `__dirname`-relative path typo, or an
  // unfollowed symlink must not be able to report OK while coverage silently
  // regresses to the pre-#2529 state.
  let files;
  try {
    files = findMarkdownFilesRecursive(workflowsDir);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    io.error(
      `lint-response-language-coverage: cannot read the workflow directory ${workflowsDir} (${error.code}).\n` +
      `Coverage cannot be established, so this is a failure and not a pass (#2529).`,
    );
    return 1;
  }

  if (files.length === 0) {
    io.error(
      `lint-response-language-coverage: no workflow files found under ${workflowsDir}.\n` +
      `A run that inspected zero workflows cannot establish coverage (#2529).`,
    );
    return 1;
  }

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
  EXACT_INLINE_DIRECTIVE_WORKFLOWS,
  INLINE_RESPONSE_LANGUAGE_DIRECTIVE,
  PARENT_INJECTED_WORKFLOWS,
  WORKFLOWS_DIR,
  findMarkdownFilesRecursive,
  findViolations,
  hasResponseLanguageCoverage,
  inheritsParentCoverage,
  main,
};
