'use strict';

// /gsd-ultraplan-phase [BETA]: the command file (frontmatter name, BETA description, argument-hint, the workflow and
// ui-brand references) and the workflow file (BETA and research-preview notices, the runtime gate on Claude Code marker
// variables rather than a version variable, the local-alternative message, phase context loading, the missing-.planning
// route, ROADMAP / REQUIREMENTS / RESEARCH in the ultraplan prompt, the /ultraplan trigger, the return path through
// the import command placed before the trigger, and isolation from the core pipeline). Where the test accepted a
// disjunction the file satisfies by coincidence (`ROADMAP` or `phase_name`, `RESEARCH` or `research_path`, `preview`,
// `beta`) the contract asks for the phrase the file carries. Was tests/ultraplan-phase.test.cjs.

const COMMAND = 'commands/gsd/ultraplan-phase.md';
const WORKFLOW = 'gsd-core/workflows/ultraplan-phase.md';

// The lines of a text, ended by LF, CR, U+2028 or U+2029 as a `.` in the old patterns was.
const linesOf = (text) => text.split(/\r|\n|\u2028|\u2029/);

// The first index of any of the markers, or -1.
const firstOf = (text, markers) => {
  const hits = markers.map((marker) => text.indexOf(marker)).filter((at) => at !== -1);
  return hits.length === 0 ? -1 : Math.min(...hits);
};

// `^name:\s*gsd:ultraplan-phase$` with the m flag: the key at the start of a line, any whitespace (a line break included),
// the value, then the end of a line. Line starts and ends are LF, CR, U+2028 and U+2029.
function hasNameLine(text) {
  const isBreak = (ch) => ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
  const value = 'gsd:ultraplan-phase';
  for (let at = text.indexOf('name:'); at !== -1; at = text.indexOf('name:', at + 1)) {
    if (at !== 0 && !isBreak(text[at - 1])) continue;
    let next = at + 'name:'.length;
    while (next < text.length && /\s/.test(text[next])) next += 1;
    if (!text.startsWith(value, next)) continue;
    const end = next + value.length;
    if (end === text.length || isBreak(text[end])) return true;
  }
  return false;
}

module.exports = {
  id: 'ultraplan-phase',
  walkers: { hasNameLine },
  check(ctx) {
    const command = ctx.doc(COMMAND);
    command.frontmatter()
      .satisfies((text) => hasNameLine(text) || 'no name line carries gsd:ultraplan-phase', 'the command must have name: gsd:ultraplan-phase')
      .satisfies((text) => linesOf(text).some((line) => line.startsWith('description:') && line.includes('[BETA]')) || 'no description line carries [BETA]', 'the description must mark the feature as BETA')
      .has(/^argument-hint:/m, 'the command must have an argument-hint');
    command
      .has('@~/.claude/gsd-core/workflows/ultraplan-phase.md', 'the command must reference the ultraplan-phase workflow')
      .has('ui-brand', 'the command must reference ui-brand');

    ctx.doc(WORKFLOW)
      .has('BETA', 'the workflow must display a BETA warning')
      .has('research preview', 'the workflow must note ultraplan is in research preview')
      .has(/CLAUDECODE|CLAUDE_CODE_ENTRYPOINT/, 'the workflow must gate on a Claude Code runtime marker variable')
      .lacks('CLAUDE_CODE_VERSION', 'the workflow must not gate on CLAUDE_CODE_VERSION')
      .has(/gsd[:-]plan-phase/, 'the error message must direct users to /gsd-plan-phase as the local alternative')
      .has('gsd_run query init.plan-phase', 'the workflow must load phase context through gsd_run query init.plan-phase')
      .has(/gsd[:-]new-project/, 'the workflow must direct the user to /gsd-new-project when .planning is missing')
      .has('## Phase Scope (from ROADMAP.md)', 'the ultraplan prompt must include the phase scope from ROADMAP.md')
      .has('REQUIREMENTS', 'the ultraplan prompt must include the requirements context')
      .has('RESEARCH.md', 'the ultraplan prompt must include the existing research')
      .has('/ultraplan', 'the workflow must trigger /ultraplan')
      .has('Cancel', 'the workflow must tell the user to choose Cancel to save the plan to a file')
      .has(/gsd[:-]import/, 'the workflow must direct the user to run /gsd-import --from after ultraplan completes')
      .has('--from', 'the workflow must reference /gsd-import --from <file-path>')
      .satisfies((text) => {
        const importAt = firstOf(text, ['gsd-import', 'gsd:import']);
        const triggerAt = text.indexOf('/ultraplan');
        if (importAt === -1 || triggerAt === -1) return true; // a missing one is reported by its own assertion
        return importAt < triggerAt || 'the import command first appears after the /ultraplan trigger';
      }, 'the return-path instructions (the import command) must appear before the /ultraplan trigger so they are visible in scroll-back')
      .lacks('write PLAN.md', 'the workflow must not directly write PLAN.md: it delegates to /gsd-import --from')
      .lacks("Write('.planning", 'the workflow must not write .planning files directly')
      .lacks('ultrareview', 'the workflow must not reference ultrareview');
  },
};
