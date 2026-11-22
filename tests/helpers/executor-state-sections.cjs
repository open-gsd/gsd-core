'use strict';

/**
 * #6388: the STATE.md section-read contract plan execution ships in two places —
 * agents/gsd-executor.md (load_project_state) and gsd-core/workflows/execute-plan.md
 * (init_context). Shared by the contract test and the real-bash integration test, so both
 * read the block the same way.
 */

/** The block's first line: its opening comment. */
const BLOCK_START = '# #6388: load only the STATE.md sections execution uses (Current Position, Decisions, Blockers), never the whole file.';
/** The block's last line: the continuation of its printf. */
const BLOCK_END_PREFIX = '  "$STATE_STATUS" ';

/**
 * The read block as shipped: from its opening comment through the line that ends its printf.
 * Returns null when the file does not carry exactly one such block.
 */
function stateSectionBlock(content) {
  const lines = content.split('\n');
  const starts = lines.flatMap((l, i) => (l === BLOCK_START ? [i] : []));
  if (starts.length !== 1) return null;
  const end = lines.findIndex((l, i) => i > starts[0] && l.startsWith(BLOCK_END_PREFIX));
  if (end === -1) return null;
  return lines.slice(starts[0], end + 1).join('\n');
}

/**
 * The `state.get` names the block reads, in order, grouped by section. Each section takes the
 * first name that returns text; together they are the headings `state add-decision` and
 * `state add-blocker` accept (src/state.cts) that `state.get` can name.
 */
const SECTION_NAMES = Object.freeze({
  position: Object.freeze(['Current Position']),
  decisions: Object.freeze(['Decisions', 'Decisions Made']),
  blockers: Object.freeze(['Blockers/Concerns', 'Blockers', 'Concerns']),
});

/** The rules both files state next to the block, word for word. */
const RULES = Object.freeze([
  '- `STATE_STATUS=missing`: STATE.md does not exist. If `.planning/` exists, offer to reconstruct STATE.md or continue without it; if `.planning/` is missing, stop with an error: the project is not initialized.',
  '- Blockers `(empty)`: none are recorded.',
  '- Decisions `(empty)`: STATE.md may keep its decisions under another heading the state writers accept (such as `### Accumulated Decisions`), which `state.get` cannot name. Read STATE.md and use only its decisions section.',
  '- Read the whole STATE.md only when a task\'s `<read_first>` or action names it, or names a STATE.md section other than these three.',
]);

/** The rule for a plan's own `@`-reference to STATE.md, in load_plan and in execute step 1. */
const AT_REFERENCE_RULE = 'A plan\'s `@`-reference to STATE.md (`@.planning/STATE.md`, `@{state_path}`, a workstream\'s STATE.md) is covered by the #6388 section reads: do not read the whole file for it.';

module.exports = { BLOCK_START, stateSectionBlock, SECTION_NAMES, RULES, AT_REFERENCE_RULE };
