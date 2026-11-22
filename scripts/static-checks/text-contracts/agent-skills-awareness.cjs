'use strict';

// Agents that read project skills carry a "Project skills" block and never load the whole AGENTS.md;
// the doc writer also guards the doc_assignment block against user data. The agent .md files are the
// installed instructions, so their text is the contract. Was tests/agent-skills-awareness.test.cjs.

const AGENTS_REQUIRING_SKILLS = [
  'gsd-debugger',
  'gsd-integration-checker',
  'gsd-security-auditor',
  'gsd-nyquist-auditor',
  'gsd-codebase-mapper',
  'gsd-roadmapper',
  'gsd-eval-auditor',
  'gsd-intel-updater',
  'gsd-doc-writer',
];

module.exports = {
  id: 'agent-skills-awareness',
  check(ctx) {
    for (const name of AGENTS_REQUIRING_SKILLS) {
      ctx.doc(`agents/${name}.md`)
        .has('Project skills', `${name} missing Project skills block`)
        .lacks('Read AGENTS.md', `${name} should not instruct loading full AGENTS.md`)
        .lacks('load AGENTS.md', `${name} should not instruct loading full AGENTS.md`);
    }
    ctx.doc('agents/gsd-doc-writer.md')
      .has('doc_assignment', 'gsd-doc-writer missing security note for doc_assignment block')
      .has('SECURITY', 'gsd-doc-writer missing security note for doc_assignment block');
  },
};
