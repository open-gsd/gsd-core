#!/usr/bin/env node
'use strict';

/**
 * lint-phase-arg-assignment.cjs — a workflow that READS `${PHASE_ARG}` must
 * also SAY where it comes from (#4777).
 *
 * ## Why
 *
 * Seven workflows shipped an `init.phase-op "${PHASE_ARG}"` call with no
 * assignment anywhere in the file and no instruction to derive one. The
 * variable expanded to the empty string on every run, `init.phase-op ""`
 * resolved `phase_found: false` unconditionally, and each workflow fell
 * through to its own "phase not executed" exit with a blank phase number —
 * so `/gsd:secure-phase 4` reported that phase *nothing* was not executed.
 * Two of them had carried the defect since the files were created in March.
 *
 * Nothing caught it because the working pattern lived in a *different* file:
 * `verify-work.md` derives the value correctly, and a copy of an init block
 * that leaves the derivation line behind is indistinguishable, on review,
 * from one that never needed it.
 *
 * ## The rule
 *
 * A workflow whose bash blocks read `$PHASE_ARG` must carry one of:
 *
 *   1. a **shell assignment** matching one of the frozen `CANONICAL_FORMS`
 *      below, textually before the first read; or
 *   2. a **prose derivation step** — a line outside the bash blocks that
 *      tells the model to parse `$ARGUMENTS` into `$PHASE_ARG`
 *      (`execute-phase.md`: "First positional token → `PHASE_ARG`"); or
 *   3. an entry in `EXEMPT`, with a reason.
 *
 * ## Why the forms are frozen
 *
 * Requiring *an* assignment would be satisfied by a seventh hand-rolled sed
 * pipeline, which is how the two grammars in this tree already drifted apart.
 * The rule therefore pins the exact text. There are three legitimate ways a
 * workflow learns its phase — `$ARGUMENTS` positional, `--phase N`, and a
 * positional `$1` passed by a skill dispatch — and each has exactly one
 * spelling. A new grammar is a deliberate one-line addition here, reviewed
 * once, rather than a copy that diverges silently.
 *
 * Detection only: this lint never edits a workflow.
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ROOT = path.join(ROOT, 'gsd-core', 'workflows');
const SECTIONIZER_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'markdown-sectionizer.cjs');

/**
 * Fenced-block extraction goes through the Markdown Sectionizer seam
 * (ADR-1372) rather than a local fence regex — `local/no-adhoc-markdown-parsing`
 * enforces that, and it is right to: a `~~~` block, an indented fence, or a
 * nested fence inside another would each be misread by a hand-rolled pattern,
 * and this rule's whole job is to know which lines are shell.
 */
function loadSectionizer() {
  try {
    return require(SECTIONIZER_PATH);
  } catch (e) {
    throw new ExitError(
      1,
      'lint-phase-arg-assignment: cannot load the markdown-sectionizer seam at ' +
        `${path.relative(ROOT, SECTIONIZER_PATH)} — run 'npm run build:lib' first (${e.message})`,
    );
  }
}

const SHELL_INFO_STRINGS = new Set(['bash', 'sh', 'shell']);

/**
 * The only accepted spellings of a PHASE_ARG assignment, keyed by grammar.
 * Compared after collapsing runs of whitespace, so indentation inside a
 * block is free but the pipeline itself is not.
 */
const CANONICAL_FORMS = Object.freeze({
  /** `/gsd:secure-phase 4` — the phase is the whole argument string, minus a `--ws <name>` pair. */
  positional:
    'PHASE_ARG=$(echo "$ARGUMENTS" | sed -E \'s/--ws[[:space:]]+[A-Za-z0-9._-]+//g\' | xargs)',
  /** `/gsd:review --phase 4 --codex` — the phase is the value of a named flag. */
  phaseFlag:
    'PHASE_ARG=$(echo "$ARGUMENTS" | sed -nE \'s/.*--phase[[:space:]]+([A-Za-z0-9._-]+).*/\\1/p\')',
  /** Skill dispatch passes the phase as `$1` (`Skill(skill="gsd-code-review", args="4")`). */
  firstPositional: 'PHASE_ARG="${1}"',
});

/**
 * Files that read `$PHASE_ARG` and legitimately do not assign it. Each entry
 * is checked for staleness: one whose file stopped reading the variable, or
 * started assigning it, fails just as loudly as a missing assignment — an
 * exemption nobody can remove is how a list like this becomes a place to
 * hide the next defect.
 */
const EXEMPT = new Map([
  [
    'code-review/steps/dispatch-fix.md',
    'step fragment of code-review.md, which assigns PHASE_ARG="${1}" before dispatching it',
  ],
]);

const READ_RE = /\$\{?PHASE_ARG\b/;
const ASSIGN_RE = /^[ \t]*PHASE_ARG=(?!=).*$/gm;
/**
 * A prose derivation step: a non-bash line that routes `$ARGUMENTS` into
 * `PHASE_ARG`. Matches both shapes in the tree — an arrow ("First positional
 * token → `PHASE_ARG`") and a "store as `$PHASE_ARG`" instruction.
 */
const PROSE_ASSIGN_RE = /(?:→|->|store as)\s*`?\$?\{?PHASE_ARG/;

/** Collapse whitespace runs so indentation does not decide the verdict. */
function normalize(line) {
  return line.trim().replace(/\s+/g, ' ');
}

const CANONICAL_SET = new Set(Object.values(CANONICAL_FORMS).map(normalize));

/** Every `*.md` under `dir`, recursively, as paths relative to `dir`. */
function collectWorkflows(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * Classify one workflow's PHASE_ARG handling.
 *
 * `reads` counts bash-block reads only: `${PHASE_ARG}` inside prose is a
 * mention (an error message being described, an example invocation), not a
 * consumption, and requiring an assignment for those would make the rule fire
 * on documentation.
 */
function inspect(text, sectionizer = loadSectionizer()) {
  const lines = text.split('\n');
  const shell = sectionizer
    .scanFencedBlocks(lines)
    .filter((b) => SHELL_INFO_STRINGS.has(b.infoString.trim().split(/\s+/)[0]))
    // closeLineIdx === -1 marks an unterminated fence: take the rest of the
    // file rather than dropping the block, so a workflow whose last fence is
    // missing its closer is still scanned instead of silently exempted.
    .map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx === -1 ? lines.length : b.closeLineIdx).join('\n'))
    .join('\n');

  const assignments = [...shell.matchAll(ASSIGN_RE)].map((m) => m[0]);
  const firstAssignIdx = shell.search(/^[ \t]*PHASE_ARG=(?!=)/m);
  const firstReadIdx = shell.search(READ_RE);

  // The prose search deliberately runs over the WHOLE file rather than the
  // non-bash remainder: a derivation step is a prose line, and stripping
  // blocks first would only add a way for the two to disagree.
  const hasProse = text.split('\n').some((line) => PROSE_ASSIGN_RE.test(line));

  return {
    reads: firstReadIdx !== -1,
    assignments,
    nonCanonical: assignments.filter((a) => !CANONICAL_SET.has(normalize(a))),
    // An assignment that lands after the first read is the same defect with
    // extra steps — the read still expands to nothing.
    assignsBeforeRead: firstAssignIdx !== -1 && firstReadIdx !== -1 && firstAssignIdx <= firstReadIdx,
    hasProse,
  };
}

/** Scan a workflows directory. Returns `{ scanned, violations, staleExemptions }`. */
function scan(rootDir = DEFAULT_ROOT, exempt = EXEMPT) {
  const violations = [];
  const seenExempt = new Set();
  const sectionizer = loadSectionizer();
  let scanned = 0;

  for (const rel of collectWorkflows(rootDir)) {
    const report = inspect(fs.readFileSync(path.join(rootDir, rel), 'utf8'), sectionizer);
    if (!report.reads && report.assignments.length === 0) continue;
    scanned += 1;

    // Decide the verdict FIRST, then consult the exemption list. Marking an
    // entry used before knowing whether the file would actually fail lets an
    // exemption outlive its reason: the file gets fixed, the entry stays, and
    // it silently pre-forgives the NEXT unassigned read in that same file.
    let violation = null;
    if (report.nonCanonical.length > 0) {
      violation = { file: rel, kind: 'non-canonical', detail: normalize(report.nonCanonical[0]) };
    } else if (!report.reads) {
      violation = null;
    } else if (report.assignments.length === 0 && !report.hasProse) {
      violation = { file: rel, kind: 'unassigned', detail: 'reads ${PHASE_ARG} with no assignment and no derivation step' };
    } else if (report.assignments.length > 0 && !report.assignsBeforeRead) {
      violation = { file: rel, kind: 'late-assignment', detail: 'PHASE_ARG is assigned after its first use' };
    }

    if (!violation) continue;
    if (exempt.has(rel)) { seenExempt.add(rel); continue; }
    violations.push(violation);
  }

  const staleExemptions = [...exempt.keys()]
    .filter((rel) => !seenExempt.has(rel))
    .map((rel) => ({ file: rel, reason: exempt.get(rel) }));

  return { scanned, violations, staleExemptions };
}

function main() {
  const { scanned, violations, staleExemptions } = scan();
  const parts = [];

  if (violations.length > 0) {
    parts.push(
      'lint-phase-arg-assignment: these workflows do not say where ${PHASE_ARG} comes from (#4777).\n' +
        'An unassigned PHASE_ARG expands to the empty string, init.phase-op resolves\n' +
        'phase_found:false for every invocation, and the workflow exits reporting that a blank\n' +
        'phase was not executed. Add one of the canonical forms in this script — or, for a model-\n' +
        'derived value, a prose derivation step — before the first read:\n' +
        violations.map((v) => `  gsd-core/workflows/${v.file}  [${v.kind}] ${v.detail}`).join('\n'),
    );
  }
  if (staleExemptions.length > 0) {
    parts.push(
      'lint-phase-arg-assignment: these EXEMPT entries are stale — delete them so the next\n' +
        'unassigned read in those files is caught rather than silently pre-forgiven:\n' +
        staleExemptions.map((s) => `  ${s.file}: ${s.reason}`).join('\n'),
    );
  }
  if (parts.length > 0) throw new ExitError(1, parts.join('\n\n'));

  console.log(
    `ok lint-phase-arg-assignment: ${scanned} workflow(s) checked, ${EXEMPT.size} exemption(s) all still needed`,
  );
}

module.exports = { CANONICAL_FORMS, EXEMPT, DEFAULT_ROOT, inspect, scan };

if (require.main === module) runMain(main);
