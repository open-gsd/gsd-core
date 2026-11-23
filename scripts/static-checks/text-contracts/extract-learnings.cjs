'use strict';

// The /gsd-extract-learnings command and workflow: the command's frontmatter (name, description, argument-hint
// <phase-number>, allowed-tools, type: prompt) and workflow reference; the workflow's tags and hyphenated step name,
// required and optional artifacts, the four learning categories, capture_thought and its graceful degradation, the
// LEARNINGS.md output and its frontmatter fields, missing-artifact handling, source attribution and overwrite on
// re-run. Where the test accepted a bare word every file carries (`phase`, `source`, `missing`, `replace`) the
// contract asks for the phrase the real workflow has. Was tests/extract-learnings.test.cjs.

const COMMAND = 'commands/gsd/extract-learnings.md';
const WORKFLOW = 'gsd-core/workflows/extract-learnings.md';

// The items of the frontmatter `allowed-tools:` list (a block list or a `[a, b]` flow list), exact names only.
function allowedTools(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trimEnd().startsWith('allowed-tools:'));
  if (at === -1) return [];
  const rest = lines[at].trim().slice('allowed-tools:'.length).trim();
  if (rest.startsWith('[') && rest.endsWith(']')) return rest.slice(1, -1).split(',').map((item) => item.trim());
  const items = [];
  for (const line of lines.slice(at + 1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) break;
    items.push(trimmed.slice(2).trim());
  }
  return items;
}

const hasLineStarting = (text, prefix) => text.split('\n').some((line) => line.startsWith(prefix));

module.exports = {
  id: 'extract-learnings',
  check(ctx) {
    ctx.exists(COMMAND, 'commands/gsd/extract-learnings.md should exist');
    // The frontmatter fields are read from the frontmatter block (the test read the whole file, where a tool name in
    // the prose satisfied the allowed-tools check).
    const frontmatter = ctx.doc(COMMAND).frontmatter()
      .has('name: gsd:extract-learnings', 'the command must have name: gsd:extract-learnings')
      .has('description:', 'the command must have description frontmatter')
      .has('argument-hint:', 'the command must have argument-hint')
      .has('<phase-number>', 'the argument-hint must reference <phase-number>')
      .has('allowed-tools:', 'the command must have allowed-tools');
    for (const tool of ['Read', 'Write', 'Bash', 'Grep', 'Glob', 'Agent']) {
      frontmatter.satisfies((text) => allowedTools(text).includes(tool) || `the allowed-tools list is [${allowedTools(text).join(', ')}]`, `allowed-tools must include ${tool}`);
    }
    frontmatter.has('type: prompt', 'the command must have type: prompt');
    ctx.doc(COMMAND).has('workflows/extract-learnings.md', 'the command must reference workflows/extract-learnings.md in execution_context');

    ctx.exists(WORKFLOW, 'workflows/extract-learnings.md should exist');
    const workflow = ctx.doc(WORKFLOW);
    for (const tag of ['objective', 'process', 'success_criteria', 'critical_rules']) {
      workflow.has(`<${tag}>`, `the workflow must have a <${tag}> tag`).has(`</${tag}>`, `the workflow must close the <${tag}> tag`);
    }
    workflow
      .has('<step name=', 'the workflow must have named step tags')
      .has('</step>', 'the workflow must close its step tags')
      .has('<step name="extract-learnings">', 'the workflow step must use the hyphen convention: <step name="extract-learnings">')
      .has('PLAN.md', 'the workflow must reference PLAN.md')
      .has('SUMMARY.md', 'the workflow must reference SUMMARY.md')
      .has('VERIFICATION.md', 'the workflow must reference VERIFICATION.md')
      .has('UAT.md', 'the workflow must reference UAT.md')
      .has('STATE.md', 'the workflow must reference STATE.md')
      .has(/decision/i, 'the workflow must extract decisions')
      .has(/lesson/i, 'the workflow must extract lessons')
      .has(/pattern/i, 'the workflow must extract patterns')
      .has(/surprise/i, 'the workflow must extract surprises')
      .has('capture_thought', 'the workflow must reference the capture_thought tool')
      .has('If not available', 'the workflow must degrade gracefully when capture_thought is unavailable')
      .has('LEARNINGS.md', 'the workflow must output LEARNINGS.md')
      .has('skip if not found', 'the workflow must skip missing optional artifacts')
      .has('attribution to', 'the workflow must include source attribution for extracted items')
      .satisfies((text) => hasLineStarting(text, 'phase:'), 'the LEARNINGS.md frontmatter must include phase')
      .satisfies((text) => hasLineStarting(text, 'phase_name:'), 'the LEARNINGS.md frontmatter must include phase_name')
      .satisfies((text) => hasLineStarting(text, 'generated:'), 'the LEARNINGS.md frontmatter must include generated')
      .satisfies((text) => hasLineStarting(text, 'missing_artifacts:'), 'the LEARNINGS.md frontmatter must include missing_artifacts')
      .has('overwrite it', 'the workflow must overwrite a previous LEARNINGS.md on re-run');
  },
};
