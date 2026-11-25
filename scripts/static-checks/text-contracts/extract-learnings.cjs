'use strict';

// The /gsd-extract-learnings command and workflow: the command's frontmatter (name, description, argument-hint
// <phase-number>, allowed-tools, type: prompt) and workflow reference; the workflow's tags and hyphenated step name,
// required and optional artifacts, the four learning categories, capture_thought and its graceful degradation, the
// LEARNINGS.md output and its frontmatter fields, missing-artifact handling, source attribution and overwrite on
// re-run. Where the test accepted a bare word every file carries (`phase`, `source`, `missing`, `replace`) the
// contract asks for the phrase the real workflow has. Was tests/extract-learnings.test.cjs.

const COMMAND = 'commands/gsd/extract-learnings.md';
const WORKFLOW = 'gsd-core/workflows/extract-learnings.md';

const path = require('node:path');

const unquote = (item) => {
  const first = item[0];
  return item.length >= 2 && (first === '"' || first === "'") && item[item.length - 1] === first ? item.slice(1, -1) : item;
};

// A line without its trailing ` # comment`, trimmed.
const withoutComment = (line) => {
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) return '';
  const at = trimmed.indexOf(' #');
  return (at === -1 ? trimmed : trimmed.slice(0, at)).trim();
};

// The items of the frontmatter `allowed-tools:` list (a block list, or a `[a, b]` flow list that may span lines), exact
// names only; quotes around an item and a trailing comment are dropped, and a blank or comment line inside a block
// list does not end it.
function allowedTools(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trimEnd().startsWith('allowed-tools:'));
  if (at === -1) return [];
  const rest = withoutComment(lines[at].trim().slice('allowed-tools:'.length));
  if (rest.startsWith('[')) {
    // The text is the frontmatter alone (the engine strips the fences), so the list may span indented lines but never
    // past a line at column 0 (the next key); an unclosed list has no items.
    let body = rest;
    let close = body.indexOf(']');
    for (let i = at + 1; close === -1 && i < lines.length; i += 1) {
      if (lines[i].trim().startsWith('#')) continue;
      if (lines[i] !== '' && !/^\s/.test(lines[i]) && !lines[i].startsWith(']')) break;
      const part = withoutComment(lines[i]);
      body += ` ${part}`;
      const found = part.indexOf(']');
      if (found !== -1) close = body.length - part.length + found;
    }
    if (close === -1) return [];
    return body.slice(1, close).split(',').map((item) => unquote(item.trim())).filter((item) => item !== '');
  }
  const items = [];
  for (const line of lines.slice(at + 1)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (!trimmed.startsWith('- ')) break;
    items.push(unquote(withoutComment(trimmed.slice(2))));
  }
  return items;
}

// The first frontmatter line that starts with the key (the value is what follows), or null.
const keyLine = (text, prefix) => text.split('\n').find((line) => line.startsWith(prefix)) ?? null;

// The lines of the first yaml fenced block inside the write_learnings step: the LEARNINGS.md frontmatter template.
function learningsTemplate(text) {
  const start = text.indexOf('<step name="write_learnings">');
  const end = start === -1 ? -1 : text.indexOf('</step>', start);
  if (end === -1) return [];
  const lines = text.slice(start, end).split('\n');
  const { scanFencedBlocks } = require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'markdown-sectionizer.cjs'));
  const block = scanFencedBlocks(lines).find((record) => record.closeLineIdx !== -1 && record.infoString === 'yaml');
  return block ? lines.slice(block.openLineIdx + 1, block.closeLineIdx) : [];
}

const templateHas = (field) => (text) => learningsTemplate(text).some((line) => line.startsWith(field)) || 'no such line in the yaml block of the write_learnings step';

module.exports = {
  id: 'extract-learnings',
  check(ctx) {
    ctx.exists(COMMAND, 'commands/gsd/extract-learnings.md should exist');
    // The frontmatter fields are read from the frontmatter block (the test read the whole file, where a tool name in
    // the prose satisfied the allowed-tools check).
    const frontmatter = ctx.doc(COMMAND).frontmatter()
      .satisfies((text) => keyLine(text, 'name: gsd:extract-learnings') !== null, 'the command must have name: gsd:extract-learnings')
      .satisfies((text) => keyLine(text, 'description:') !== null, 'the command must have description frontmatter')
      .satisfies((text) => keyLine(text, 'argument-hint:') !== null, 'the command must have argument-hint')
      .satisfies((text) => (keyLine(text, 'argument-hint:') ?? '').includes('<phase-number>'), 'the argument-hint must reference <phase-number>')
      .satisfies((text) => keyLine(text, 'allowed-tools:') !== null, 'the command must have allowed-tools');
    for (const tool of ['Read', 'Write', 'Bash', 'Grep', 'Glob', 'Agent']) {
      frontmatter.satisfies((text) => allowedTools(text).includes(tool) || `the allowed-tools list is [${allowedTools(text).join(', ')}]`, `allowed-tools must include ${tool}`);
    }
    frontmatter.satisfies((text) => keyLine(text, 'type: prompt') !== null, 'the command must have type: prompt');
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
      .satisfies(templateHas('phase:'), 'the LEARNINGS.md frontmatter must include phase')
      .satisfies(templateHas('phase_name:'), 'the LEARNINGS.md frontmatter must include phase_name')
      .satisfies(templateHas('generated:'), 'the LEARNINGS.md frontmatter must include generated')
      .satisfies(templateHas('missing_artifacts:'), 'the LEARNINGS.md frontmatter must include missing_artifacts')
      .has('overwrite it', 'the workflow must overwrite a previous LEARNINGS.md on re-run');
  },
};
