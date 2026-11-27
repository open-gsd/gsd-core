'use strict';

// diagnose-issues.md carries its own inline gsd-debugger prompt (#5203): #4540 deleted the debug-subagent-prompt
// template the workflow told the orchestrator to fill, so the prompt now lives in the spawn step with the pre-filled
// symptoms mode, the find_root_cause_only goal, the debug-file target and every documented placeholder, the debug
// file is named {slug}.md, and the Agent() call passes one consistent variable. And every template a shipped workflow
// tells the model to fill resolves under gsd-core/templates/. Was tests/diagnose-issues-workflow.test.cjs.

const PLACEHOLDERS = ['truth', 'expected', 'actual', 'errors', 'reproduction', 'timeline', 'slug'];
const FILL_TEMPLATE = /fill (?:the |this |that )?([a-z0-9_-]{1,100}) template/gi;

module.exports = {
  id: 'diagnose-issues-workflow',
  issue: '#5203',
  check(ctx) {
    const workflow = ctx.doc('gsd-core/workflows/diagnose-issues.md')
      .lacks(/debug-subagent-prompt/, 'the removed debug-subagent-prompt template is still named')
      .lacks(/DEBUG-\{slug\}/, 'a DEBUG-{slug}.md name contradicts the real .planning/debug/{slug}.md target')
      .has('prompt=filled_debug_prompt + ', 'Agent() does not pass filled_debug_prompt')
      .lacks('filled_debug_subagent_prompt', 'the old variable name is still used');
    // The spawn_agents step's inline prompt: the first <objective> after "fill this prompt" to the end of its <debug_file>.
    // The slice stops where </debug_file> begins, so the target pattern ending in whitespace-then-end is the closing check.
    const prompt = workflow.slice('fill this prompt', '</debug_file>').slice('<objective>')
      .has(/symptoms_prefilled: true/, 'the inline prompt must carry symptoms_prefilled: true')
      .has(/goal: find_root_cause_only/, 'the inline prompt must carry goal: find_root_cause_only')
      .has(/<debug_file>\s{0,20}Create: \.planning\/debug\/\{slug\}\.md\s{0,20}$/, 'the inline prompt must carry the debug-file target');
    for (const placeholder of PLACEHOLDERS) prompt.has(`{${placeholder}}`, `the inline prompt lacks {${placeholder}}`);

    // Every `fill the X template` in any workflow names a template that exists.
    for (const rel of ctx.list('gsd-core/workflows', '.md', 'the workflows are what the template references are checked on')) {
      const text = ctx.doc(rel).text;
      for (const match of text.matchAll(FILL_TEMPLATE)) {
        ctx.exists(`gsd-core/templates/${match[1]}.md`, `${rel}: "${match[0]}" must resolve to templates/${match[1]}.md`);
      }
    }
  },
};
