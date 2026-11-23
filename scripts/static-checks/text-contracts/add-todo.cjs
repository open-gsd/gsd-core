'use strict';

// add-todo.md captures a severity (#2337): a confirm-based `infer_severity` step positioned BEFORE the todo is
// written (create_file), confirmed through AskUserQuestion with the TEXT_MODE fallback, covering the
// blocker/major/minor/cosmetic taxonomy of verify-work.md, and a `severity` field in the create_file frontmatter
// template. Was tests/add-todo.test.cjs.

module.exports = {
  id: 'add-todo',
  issue: '#2337',
  check(ctx) {
    const workflow = ctx.doc('gsd-core/workflows/add-todo.md')
      .has(/<step name="infer_severity">/, 'add-todo.md must define an infer_severity step')
      .before('<step name="infer_severity">', '<step name="create_file">', 'infer_severity must precede create_file so severity is confirmed before write')
      .has(/^severity:[ \t]{0,20}\[blocker\|major\|minor\|cosmetic/m, 'the create_file frontmatter template must include a severity field');

    const step = workflow.step('infer_severity')
      .has(/AskUserQuestion/, 'severity must be confirmed via AskUserQuestion (with the TEXT_MODE fallback), not auto-assigned')
      .has(/TEXT_MODE/, 'the step must provide the non-Claude-runtime numbered-list fallback');
    for (const level of ['blocker', 'major', 'minor', 'cosmetic']) {
      step.has(level, `the severity taxonomy must include "${level}" to stay aligned with verify-work.md's severity_inference`);
    }
  },
};
