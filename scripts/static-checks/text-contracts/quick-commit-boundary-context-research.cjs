'use strict';

// Quick tasks in worktree mode (#4996): the pre-dispatch commit step stages CONTEXT.md and RESEARCH.md next to PLAN.md,
// each gated on its mode flag AND a file-existence test; the executor's required_reading lists both conditionally, its
// materialization fallback restores both from the pre-dispatch commit, and the planner and executor carry the same two
// literal conditional lines (anti-drift). The file-existence guards are read by linear walks (the test's `\s+` and
// `[^"]*` were unbounded). The order assertion needs both `git show` and `<required_reading>` in the executor prompt
// (the test also passed when `git show` was absent; the PLAN.md assertion requires it separately). Was
// tests/quick-commit-boundary-context-research.test.cjs.

const STEP = 'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md';
const QUICK = 'gsd-core/workflows/quick.md';
const SPAWN = 'subagent_type="gsd-executor"';
const OPEN_TAG = '<required_reading>';
const CLOSE_TAG = '</required_reading>';
const PLANNER_BLOCK = '<required_reading>\n- ${STATE_PATH} (Project State)';
const EXECUTOR_BLOCK = '<required_reading>\n- ${QUICK_DIR}/${quick_id}-PLAN.md (Plan)';
const CONTEXT_LINE = "${DISCUSS_MODE ? '- ' + QUICK_DIR + '/' + quick_id + '-CONTEXT.md (User decisions — locked, do not revisit)' : ''}";
const RESEARCH_LINE = "${RESEARCH_MODE ? '- ' + QUICK_DIR + '/' + quick_id + '-RESEARCH.md (Research findings — use to inform implementation choices)' : ''}";

// The old patterns' `.` stops at any line terminator.
const LINE_TERMINATORS = /[\r\n\u2028\u2029]/;
const isBlank = (char) => char !== undefined && /\s/.test(char);

// `-f`, blanks, a quoted path whose first quote-free run ends in the file name: `-f "${DIR}/${id}-CONTEXT.md"`.
function quotedTestOf(text, name) {
  let at = text.indexOf('-f');
  while (at !== -1) {
    let open = at + 2;
    while (isBlank(text[open])) open += 1;
    if (open > at + 2 && text[open] === '"') {
      const close = text.indexOf('"', open + 1);
      if (close !== -1 && text.slice(open + 1, close).endsWith(name)) return true;
    }
    at = text.indexOf('-f', at + 1);
  }
  return false;
}

// `[ -f ` and, later on the same line, the file name.
function bracketTestOf(text, name) {
  return text.split(LINE_TERMINATORS).some((line) => {
    const at = line.indexOf('[ -f ');
    return at !== -1 && line.indexOf(name, at + '[ -f '.length) !== -1;
  });
}

const guarded = (text, name) => quotedTestOf(text, name) || bracketTestOf(text, name);

// The text between the last `<required_reading>` before the executor spawn and the next closing tag, or the reason it is missing.
function executorReading(text) {
  const spawn = text.indexOf(SPAWN);
  if (spawn === -1) return { error: 'the executor Agent()/Task() spawn is missing' };
  const start = text.lastIndexOf(OPEN_TAG, spawn);
  const end = start === -1 ? -1 : text.indexOf(CLOSE_TAG, start);
  if (start === -1 || end === -1) return { error: 'the executor required_reading block is missing' };
  return { block: text.slice(start, end) };
}

// The executor prompt: from the last `prompt="` before the spawn to the spawn marker.
function executorPrompt(text) {
  const spawn = text.indexOf(SPAWN);
  if (spawn === -1) return { error: 'the executor Agent()/Task() spawn is missing' };
  const start = text.lastIndexOf('prompt="', spawn);
  if (start === -1) return { error: 'there is no prompt=" before the executor spawn' };
  return { prompt: text.slice(start, text.indexOf(SPAWN, start)) };
}

// The block that starts at a known first bullet and ends at its closing tag, or the reason it is missing.
function blockAt(text, startMarker, label) {
  const start = text.indexOf(startMarker);
  const end = start === -1 ? -1 : text.indexOf(CLOSE_TAG, start);
  return start === -1 || end === -1 ? { error: `the ${label} required_reading block is missing` } : { block: text.slice(start, end) };
}

module.exports = {
  walkers: { guarded, executorReading, executorPrompt, blockAt },
  id: 'quick-commit-boundary-context-research',
  issue: '#4996',
  check(ctx) {
    // A cause shared by several assertions (no executor spawn, no prompt, no block) is reported once.
    const seen = new Set();
    const once = (message) => {
      if (seen.has(message)) return true;
      seen.add(message);
      return message;
    };
    ctx.doc(STEP)
      .has('DISCUSS_MODE', 'the pre-dispatch commit step must reference DISCUSS_MODE so it stages CONTEXT.md when the discussion phase ran')
      .has('CONTEXT.md', 'the pre-dispatch commit step must reference CONTEXT.md so it stages it when the discussion phase ran')
      .has('RESEARCH_MODE', 'the pre-dispatch commit step must reference RESEARCH_MODE so it stages RESEARCH.md when the research phase ran')
      .has('RESEARCH.md', 'the pre-dispatch commit step must reference RESEARCH.md so it stages it when the research phase ran')
      .satisfies((text) => guarded(text, 'CONTEXT.md'), 'CONTEXT.md staging must be guarded by a file-existence test, not mode alone')
      .satisfies((text) => guarded(text, 'RESEARCH.md'), 'RESEARCH.md staging must be guarded by a file-existence test, not mode alone')
      .has('PLAN.md', 'the pre-dispatch commit step must still reference PLAN.md unconditionally');

    ctx.doc(QUICK)
      .satisfies((text) => {
        const reading = executorReading(text);
        if (reading.error) return once(reading.error);
        return (reading.block.includes('DISCUSS_MODE') && reading.block.includes('CONTEXT.md')) || 'it does not list CONTEXT.md conditionally on $DISCUSS_MODE';
      }, 'the executor required_reading must list CONTEXT.md conditionally on $DISCUSS_MODE, matching the planner')
      .satisfies((text) => {
        const reading = executorReading(text);
        if (reading.error) return once(reading.error);
        return (reading.block.includes('RESEARCH_MODE') && reading.block.includes('RESEARCH.md')) || 'it does not list RESEARCH.md conditionally on $RESEARCH_MODE';
      }, 'the executor required_reading must list RESEARCH.md conditionally on $RESEARCH_MODE, matching the planner')
      .satisfies((text) => {
        const found = executorPrompt(text);
        if (found.error) return once(found.error);
        const { prompt } = found;
        const show = prompt.indexOf('git show');
        const reading = prompt.indexOf(OPEN_TAG);
        if (!prompt.includes('QUICK_PLAN_COMMIT')) return once('it names no QUICK_PLAN_COMMIT');
        if (!prompt.includes('CONTEXT.md')) return 'it names no CONTEXT.md';
        // A prompt with no git show at all is reported by the PLAN.md materialization assertion below.
        if (show === -1) return true;
        return (reading !== -1 && show < reading) || 'git show does not come before the required_reading block';
      }, 'the executor prompt must materialize CONTEXT.md from QUICK_PLAN_COMMIT before required_reading can prime paths, as it does for PLAN.md')
      .satisfies((text) => {
        const found = executorPrompt(text);
        if (found.error) return once(found.error);
        if (!found.prompt.includes('QUICK_PLAN_COMMIT')) return once('it names no QUICK_PLAN_COMMIT');
        return found.prompt.includes('RESEARCH.md') || 'it names no RESEARCH.md';
      }, 'the executor prompt must materialize RESEARCH.md from QUICK_PLAN_COMMIT the same way it does for PLAN.md')
      .satisfies((text) => {
        const found = executorPrompt(text);
        if (found.error) return once(found.error);
        if (!found.prompt.includes('QUICK_PLAN_COMMIT')) return once('it names no QUICK_PLAN_COMMIT');
        return found.prompt.includes('git show') || 'it has no git show of the plan commit';
      }, 'the PLAN.md materialization via git show of the plan commit must remain')
      .satisfies((text) => {
        const planner = blockAt(text, PLANNER_BLOCK, 'planner');
        if (planner.error) return once(planner.error);
        const executor = blockAt(text, EXECUTOR_BLOCK, 'executor');
        if (executor.error) return once(executor.error);
        if (!planner.block.includes(CONTEXT_LINE)) return 'the planner block lacks the canonical CONTEXT.md conditional line';
        if (!planner.block.includes(RESEARCH_LINE)) return 'the planner block lacks the canonical RESEARCH.md conditional line';
        if (!executor.block.includes(CONTEXT_LINE)) return 'the executor block lacks the CONTEXT.md conditional line the planner carries';
        return executor.block.includes(RESEARCH_LINE) || 'the executor block lacks the RESEARCH.md conditional line the planner carries';
      }, 'the planner and executor required_reading must carry the same CONTEXT.md and RESEARCH.md lines (anti-drift, #4996)');
  },
};
