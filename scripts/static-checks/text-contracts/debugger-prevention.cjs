'use strict';

// The debugger's prevention / blameless-postmortem output (#1963, epic #1957 Phase 3B): the reference extract exists
// and gsd-debugger @-includes it from archive_session; it documents a blameless 5-Whys that branches per RCA, the
// "why wasn't this caught?" question and the recurrence-guard taxonomy, backward compatibility of knowledge-base
// entries, and that the block reuses existing structures (no new subsystem); the KB entry format carries
// why_not_caught and recurrence_guard; the session manager's compact return surfaces the prevention summary; every
// Entry-Format field also appears in the archive_session append template (two parallel surfaces, DEFECT.GENERATIVE-FIX);
// and Phase 0 consumes the prevention fields. The test accepted the bare words `reuse`, `existing` and `prevention`
// alone for the scope and session-manager groups; the contract asks for the phrase the file carries. Was
// tests/debugger-prevention.test.cjs.

const REFERENCE = 'gsd-core/references/debugger-prevention.md';
const ENTRY_FORMAT_FIELDS = ['Date', 'Error patterns', 'Root cause', 'Fix', 'Files changed', 'Why not caught', 'Recurrence guard'];

// Case-insensitive occurrences of `**<field>` in the text.
const occurrencesOfBoldField = (text, field) => text.toLowerCase().split(`**${field.toLowerCase()}`).length - 1;

module.exports = {
  id: 'debugger-prevention',
  issue: '#1963',
  check(ctx) {
    ctx.exists(REFERENCE, 'the debugger-prevention.md reference must exist');

    const agent = ctx.doc('agents/gsd-debugger.md')
      .has('@~/.claude/gsd-core/references/debugger-prevention.md', 'gsd-debugger.md must @-include the prevention reference from archive_session')
      .has(/why.not.caught/i, 'the KB entry format must include a why_not_caught field')
      .has(/recurrence.guard/i, 'the KB entry format must include a recurrence_guard field');
    for (const field of ENTRY_FORMAT_FIELDS) {
      agent.satisfies((text) => {
        const found = occurrencesOfBoldField(text, field);
        return found >= 2 || `found ${found} occurrence(s)`;
      }, `the KB field "${field}" must appear in BOTH the Entry Format and the archive append template (parallel-surface drift)`);
    }
    agent.satisfies((text) => {
      const block = /\*\*Phase 0: Check knowledge base\*\*[\s\S]{0,1500}/.exec(text);
      if (!block) return 'no "Phase 0: Check knowledge base" block';
      return (/why.?not.?caught/i.test(block[0]) && /recurrence.?guard/i.test(block[0])) || 'the block lacks why_not_caught or recurrence_guard';
    }, 'the Phase 0 Evidence line must include why_not_caught + recurrence_guard (consume when present, absent on old entries)');

    ctx.doc(REFERENCE)
      .has(/5-?\s{0,20}whys|five whys|causal chain/i, 'the reference must document a 5-Whys causal chain')
      .has(/blame|blameless|blame-free/i, 'the reference must state the chain is blame-free')
      .has(/branch/i, 'the postmortem must branch (not chain) per the Phase 2A RCA discipline')
      .has(/single[\s-]?cause|agent error|why was that (?:error|possible)/i, 'the postmortem must treat "agent error" as a prompt for "why was that error possible?", not a terminal cause')
      .has(/why (?:wasn'?t|was not|didn'?t)[^\n]{0,500}(?:caught|prevent)|why[\s-]?not[\s-]?caught/i, 'the reference must document the "why wasn\'t this caught?" question')
      .has(/recurrence guard|recurrence-guard/i, 'the reference must name the recurrence guard')
      .has(/regression test/i, 'the guard option "regression test" must be named')
      .has(/lint rule|assertion|precondition/i, 'the guard option lint rule / assertion / precondition must be named')
      .has(/backward|back.compat|old entries|without[^\n]{0,500}fields[^\n]{0,500}load|absent[^\n]{0,500}field/i, 'the reference must document that old KB entries without the new fields still load')
      .has(/not an incident-management subsystem/i, 'the reference must state the prevention block adds no subsystem')
      .has(/reuses the existing/i, 'the reference must state the prevention block reuses the existing debug file + knowledge base');

    ctx.doc('agents/gsd-debug-session-manager.md')
      .has(/recurrence guard|why not caught/i, 'the session manager compact summary must surface the prevention summary (recurrence guard / why-not-caught)');
  },
};
