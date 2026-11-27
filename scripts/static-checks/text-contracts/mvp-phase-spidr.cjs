'use strict';

// The mvp-phase workflow carries its agreed gates: a phase status guard (refuse in_progress/completed unless --force),
// three structured user-story prompts (As a / I want to / So that, at least three AskUserQuestion lines), a SPIDR
// splitting step that references its rules file, a ROADMAP write of the Mode: mvp and Goal: lines, delegation to
// plan-phase after the SPIDR step, and the user-story-template reference. Matching is case-insensitive, as the test
// lowercased every line. Where the test accepted either of two words (`in_progress` or `completed`, `--force` or
// `status guard`), the real file carries all of them and the contract asks for each. Was tests/mvp-phase-spidr.test.cjs.

const ASK_LINES_FLOOR = 3;

module.exports = {
  id: 'mvp-phase-spidr',
  check(ctx) {
    ctx.doc('gsd-core/workflows/mvp-phase.md')
      .has(/in_progress/i, 'the workflow must reference the in_progress status guard')
      .has(/completed/i, 'the workflow must reference the completed status guard')
      .has(/--force/i, 'the workflow must mention the --force override')
      .has(/status guard/i, 'the workflow must name its status guard')
      .has(/as a/i, 'the story prompt must ask "As a"')
      .has(/i want to/i, 'the story prompt must ask "I want to"')
      .has(/so that/i, 'the story prompt must ask "So that"')
      .satisfies((text) => {
        const asks = text.split('\n').filter((line) => /askuserquestion|vscode_askquestions/i.test(line)).length;
        return asks >= ASK_LINES_FLOOR || `found ${asks}`;
      }, `the workflow must invoke AskUserQuestion on at least ${ASK_LINES_FLOOR} lines for the story prompts`)
      .has(/## 4\. spidr splitting check/i, 'the workflow must define an SPIDR step')
      .has(/spidr-splitting\.md/i, 'the workflow must reference the SPIDR rules file')
      .has(/\*\*mode:\*\* mvp/i, 'the workflow must specify the **Mode:** mvp line')
      .has(/roadmap\.md/i, 'the workflow must reference ROADMAP.md')
      .has(/\*\*goal:\*\*/i, 'the workflow must update the **Goal:** line')
      .has(/## 7\. delegate to \/gsd:plan-phase/i, 'the plan-phase delegation step must be present')
      .satisfies((text) => {
        const lower = text.toLowerCase();
        const spidr = lower.indexOf('## 4. spidr splitting check');
        const delegate = lower.indexOf('## 7. delegate to /gsd:plan-phase');
        return (spidr >= 0 && delegate > spidr) || 'the SPIDR step must come first';
      }, 'the plan-phase delegation must come AFTER the SPIDR check')
      .has(/user-story-template\.md/i, 'the workflow must reference user-story-template.md');
  },
};
