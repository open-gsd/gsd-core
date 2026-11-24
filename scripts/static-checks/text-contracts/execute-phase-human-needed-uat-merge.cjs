'use strict';

// execute-phase's verify_phase_goal human_needed Step A merges or skips, never overwrites an existing
// {phase_num}-UAT.md that holds a human's recorded results (#5845): an existence check before the create-from-template
// block, recorded results and `status` / `started` kept, only absent items appended as pending, Summary counts
// recomputed, no write or commit when nothing is appended, an absent file still creating the template with the original
// commit message, and no renaming of the old file aside. Was tests/execute-phase-human-needed-uat-merge.test.cjs.

// A line that is, after any indent, an optional `git` and then `mv` followed by whitespace or the end of the line
// (no bounded quantifier: a bound on a `lacks` would let a longer indent or gap evade it).
function hasMvLine(text) {
  const blank = (ch) => /\s/.test(ch);
  return text.split('\n').some((line) => {
    let at = 0;
    while (at < line.length && blank(line[at])) at += 1;
    if (line.startsWith('git', at) && at + 3 < line.length && blank(line[at + 3])) {
      at += 3;
      while (at < line.length && blank(line[at])) at += 1;
    }
    return line.startsWith('mv', at) && (at + 2 === line.length || blank(line[at + 2]));
  });
}

module.exports = {
  id: 'execute-phase-human-needed-uat-merge',
  issue: '#5845',
  check(ctx) {
    ctx.doc('gsd-core/workflows/execute-phase.md')
      .slice('**Step A: Persist human verification items', '**Step B: Present to user**')
      .has('test -f', 'Step A must run a literal `test -f` existence check')
      .has('status: testing', 'Step A must still carry the template')
      .before('test -f', 'status: testing', 'the existence check must precede the create-from-template block')
      .has(/keep every recorded result/i, 'an existing file must keep every recorded result')
      .has(/Keep `status` and `started` unchanged/, 'an existing file must keep status and started unchanged')
      .has(/never (reset|overwrite|replace)/i, 'an existing file must never be reset, overwritten or replaced')
      .has(/not already present/i, 'only items not already present are appended')
      .has(/matched by description/i, 'items must be matched by description')
      .has(/result: \[pending\]/, 'appended items must be pending')
      .has(/recompute the `## Summary` counts/i, 'the Summary counts must be recomputed from the merged list')
      .has(/nothing to append[^.]{0,500}(no write|do not write|skip)[^.]{0,500}commit/i, 'nothing to append must mean no write or commit')
      .has(/passed: 0/, 'an absent file must still create the template with passed: 0')
      .has('test({phase_num}): persist human verification items as UAT', 'an absent file must commit with the original message')
      .satisfies((text) => !hasMvLine(text), 'the old file must never be renamed aside')
      .has(/do not rename/i, 'the step must say not to rename the old file');
  },
};
