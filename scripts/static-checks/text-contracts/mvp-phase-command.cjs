'use strict';

// The /gsd mvp-phase command frontmatter contract: the file exists and starts with YAML frontmatter, declares the
// name gsd:mvp-phase, an argument-hint that mentions the phase, allowed-tools that include Read, Write, Bash,
// AskUserQuestion and Task or Agent, and an execution_context that points to workflows/mvp-phase.md. Was
// tests/mvp-phase-command.test.cjs.

// The fence rules (byte-0 opening fence, whole-line closing fence) have one owner.
const { locateFrontmatterFence } = require('../../../gsd-core/bin/lib/frontmatter-fence.cjs');

// The frontmatter fields, the allowed-tools list and the execution_context references of a command file.
function parseCommandContract(text) {
  const fence = locateFrontmatterFence(text);
  if (!fence || !fence.closed) return null;
  const lines = text.split('\n');
  const frontmatter = {};
  const allowedTools = [];
  let inAllowedTools = false;
  for (const raw of text.slice(fence.openEnd, fence.bodyEnd).split('\n')) {
    const line = raw.trim();
    if (line === 'allowed-tools:') {
      inAllowedTools = true;
      continue;
    }
    if (inAllowedTools) {
      if (line.startsWith('- ')) {
        allowedTools.push(line.slice(2).trim());
        continue;
      }
      inAllowedTools = false;
    }
    const sep = line.indexOf(':');
    if (sep > 0) frontmatter[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  const start = lines.findIndex((line) => line.trim() === '<execution_context>');
  const end = lines.findIndex((line, i) => i > start && line.trim() === '</execution_context>');
  const refs = start >= 0 && end > start ? lines.slice(start + 1, end).map((line) => line.trim()).filter(Boolean) : [];
  return { name: frontmatter.name || '', argumentHint: frontmatter['argument-hint'] || '', allowedTools, refs };
}

const onContract = (check) => (text) => {
  const contract = parseCommandContract(text);
  return contract === null ? 'the command must start with YAML frontmatter' : check(contract);
};

module.exports = {
  id: 'mvp-phase-command',
  check(ctx) {
    ctx.exists('commands/gsd/mvp-phase.md', 'commands/gsd/mvp-phase.md must exist');
    ctx.doc('commands/gsd/mvp-phase.md')
      .satisfies(onContract((c) => c.name === 'gsd:mvp-phase' || `the name is "${c.name}"`), 'the frontmatter must declare the command name gsd:mvp-phase')
      .satisfies(onContract((c) => c.argumentHint.toLowerCase().includes('phase') || `the argument-hint is "${c.argumentHint}"`), 'the argument-hint must mention the phase number')
      .satisfies(onContract((c) => {
        const missing = ['Read', 'Write', 'Bash', 'AskUserQuestion'].filter((tool) => !c.allowedTools.includes(tool));
        return missing.length === 0 || `missing ${missing.join(', ')}`;
      }), 'allowed-tools must include Read, Write, Bash and AskUserQuestion')
      .satisfies(onContract((c) => c.allowedTools.includes('Task') || c.allowedTools.includes('Agent') || 'neither Task nor Agent'), 'allowed-tools must include Task or Agent for delegation')
      .satisfies(onContract((c) => c.refs.some((ref) => ref.endsWith('workflows/mvp-phase.md')) || 'no reference ends with workflows/mvp-phase.md'), 'execution_context must include workflows/mvp-phase.md');
  },
};
