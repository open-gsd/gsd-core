'use strict';

// The new-project / new-milestone closing hand-off names discuss-phase as the recommended next step, then
// plan-phase, then execute-phase as the step that executes (#5723), in each runtime's command form: one
// `**After:**` / `**After this command:**` line per file. Was tests/handoff-next-step.test.cjs.

const FILES = [
  ['commands/gsd/new-project.md', '/gsd:'],
  ['skills/gsd-new-project/SKILL.md', '/gsd-'],
  ['pi/package-skills/gsd-new-project/SKILL.md', '/skill:gsd-'],
  ['commands/gsd/new-milestone.md', '/gsd:'],
  ['skills/gsd-new-milestone/SKILL.md', '/gsd-'],
  ['pi/package-skills/gsd-new-milestone/SKILL.md', '/skill:gsd-'],
];

// The single hand-off line must name the three steps in order and end the execute step with "to execute.".
function handoffNamesTheStepsInOrder(prefix) {
  return (text) => {
    const lines = text.split('\n').filter((line) => /^\*\*After( this command)?:\*\*/.test(line));
    if (lines.length !== 1) return `${lines.length} hand-off lines, expected exactly one`;
    const line = lines[0];
    if (/start(s)? execution/i.test(line)) return 'the hand-off says it starts execution';
    const discuss = line.indexOf(`${prefix}discuss-phase`);
    const plan = line.indexOf(`${prefix}plan-phase`);
    const execute = line.indexOf(`${prefix}execute-phase`);
    if (discuss < 0) return `does not name ${prefix}discuss-phase`;
    if (!(plan > discuss)) return `${prefix}plan-phase does not follow ${prefix}discuss-phase`;
    if (!(execute > plan)) return `${prefix}execute-phase does not follow ${prefix}plan-phase`;
    if (!/^[^`]{1,500}`[ \t]{1,20}to execute\./.test(line.slice(execute))) return `${prefix}execute-phase is not followed by "to execute."`;
    return true;
  };
}

module.exports = {
  id: 'handoff-next-step',
  issue: '#5723',
  check(ctx) {
    for (const [rel, prefix] of FILES) {
      ctx.doc(rel).satisfies(handoffNamesTheStepsInOrder(prefix), `the hand-off must name discuss, plan, execute in order with the ${prefix} form`);
    }
  },
};
