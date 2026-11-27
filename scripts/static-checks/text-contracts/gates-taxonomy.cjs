'use strict';

// The gates taxonomy reference (#1715): it exists, defines the four canonical gate types with Purpose,
// Behavior, Recovery and Examples, carries the Gate Matrix, and is cross-referenced from plan-phase,
// execute-phase and the required_reading blocks of gsd-plan-checker and gsd-verifier.
// Was tests/gates-taxonomy.test.cjs.

const GATES_REF = 'gsd-core/references/gates.md';
const GATE_TYPES = ['Pre-flight Gate', 'Revision Gate', 'Escalation Gate', 'Abort Gate'];
const GATE_FIELDS = ['**Purpose:**', '**Behavior:**', '**Recovery:**', '**Examples:**'];

// Every `### …Gate` section carries all four fields (other h3 sections are not gate types).
function gateSectionsHaveEveryField(text) {
  for (const section of text.split('### ').slice(1)) {
    const name = section.split('\n')[0].trim();
    if (!name.endsWith('Gate')) continue;
    for (const field of GATE_FIELDS) {
      if (!section.includes(field)) return `Gate "${name}" must include ${field}`;
    }
  }
  return true;
}

module.exports = {
  id: 'gates-taxonomy',
  issue: '#1715',
  check(ctx) {
    ctx.exists(GATES_REF, 'gsd-core/references/gates.md must exist');

    const gates = ctx.doc(GATES_REF);
    for (const gate of GATE_TYPES) gates.has(`### ${gate}`, `gates.md must define "${gate}" as an h3 heading`);
    gates
      .satisfies(gateSectionsHaveEveryField, 'each gate type must have Purpose, Behavior, Recovery and Examples')
      .has('## Gate Matrix', 'gates.md must include a "Gate Matrix" section')
      .has('| Workflow |', 'the Gate Matrix must contain a table with a Workflow column')
      .has('plan-phase', 'the Gate Matrix must reference plan-phase')
      .has('execute-phase', 'the Gate Matrix must reference execute-phase')
      .has('verify-work', 'the Gate Matrix must reference verify-work')
      .has('| next |', 'the Gate Matrix must reference the next workflow')
      .has('stall detection', 'Revision Gate recovery must mention stall detection (early escalation when issues stop decreasing)');

    ctx.doc('gsd-core/workflows/plan-phase.md')
      .has('references/gates.md', 'plan-phase.md must reference gates.md in its required_reading block');
    ctx.doc('gsd-core/workflows/execute-phase.md')
      .has('references/gates.md', 'execute-phase.md must reference gates.md in its required_reading block');
    for (const agent of ['gsd-plan-checker', 'gsd-verifier']) {
      ctx.doc(`agents/${agent}.md`)
        // The tag on its own line, as the original's pattern required: gsd-plan-checker names the tag in prose first.
        .slice('<required_reading>\n', '\n</required_reading>')
        .has('references/gates.md', `${agent}.md must reference gates.md inside <required_reading>`);
    }
  },
};
