'use strict';

// /gsd-secure-phase has one SECURITY.md writer (#2119): the gsd-security-auditor agent has no Write or Edit tool
// (the orchestrator, secure-phase.md Step 6, writes SECURITY.md), and its description says it returns a structured
// verdict instead of claiming to produce SECURITY.md. Was tests/secure-phase-single-writer.test.cjs.

// The fence rules (byte-0 opening fence, whole-line closing fence) have one owner.
const { locateFrontmatterFence } = require('../../../gsd-core/bin/lib/frontmatter-fence.cjs');

// The `- item` entries under the frontmatter `tools:` key, as the test parsed them.
function frontmatterTools(text) {
  const fence = locateFrontmatterFence(text);
  if (!fence || !fence.closed) return [];
  let inTools = false;
  const tools = [];
  for (const line of text.slice(fence.openEnd, fence.bodyEnd).split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('tools:')) {
      inTools = true;
      continue;
    }
    if (inTools) {
      if (trimmed.startsWith('- ')) tools.push(trimmed.slice(2).trim());
      else if (trimmed && !trimmed.startsWith('#')) inTools = false;
    }
  }
  return tools;
}

const descriptionLine = (text) => text.split('\n').find((line) => line.startsWith('description:'));

module.exports = {
  id: 'secure-phase-single-writer',
  issue: '#2119',
  check(ctx) {
    ctx.doc('agents/gsd-security-auditor.md')
      .satisfies((text) => frontmatterTools(text).length > 0 || 'no tools found', 'the auditor tools list should be non-empty')
      .satisfies((text) => !frontmatterTools(text).includes('Write') || `got: ${frontmatterTools(text).join(', ')}`, 'Write must not be in auditor tools: the orchestrator is the sole SECURITY.md writer')
      .satisfies((text) => !frontmatterTools(text).includes('Edit') || `got: ${frontmatterTools(text).join(', ')}`, 'Edit must not be in auditor tools: the orchestrator is the sole SECURITY.md writer')
      .satisfies((text) => descriptionLine(text) !== undefined || 'no description line', 'the description field must exist')
      .satisfies((text) => {
        const line = descriptionLine(text);
        return line === undefined || !line.includes('Produces SECURITY.md');
      }, 'the description must not claim to produce SECURITY.md: the auditor returns a verdict, the orchestrator writes')
      .satisfies((text) => {
        const line = descriptionLine(text);
        return line !== undefined && (line.includes('Returns structured') || line.includes('returns'));
      }, 'the description should state the auditor returns a structured verdict');
  },
};
