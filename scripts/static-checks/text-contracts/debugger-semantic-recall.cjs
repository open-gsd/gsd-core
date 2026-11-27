'use strict';

// Semantic knowledge-base recall via MemPalace (#1964, epic #1957 phase 3C): the debugger-semantic-recall reference
// exists and gsd-debugger @-includes it; it documents querying MemPalace for meaning-similar prior resolutions, the
// same-root-cause payoff, indexing resolved sessions at archive, the keyword fallback when MemPalace is absent
// (with the extraction mechanics that survived the phase 0 consolidation), knowledge-base.md as the durable
// plain-text source of truth, and no new vector store; the agent is semantic-first and the stale "keyword overlap,
// not semantic similarity" claim is gone. Each disjunction is the test's own, with `.*` bounded.
// Was tests/debugger-semantic-recall.test.cjs.

module.exports = {
  id: 'debugger-semantic-recall',
  issue: '#1964',
  check(ctx) {
    ctx.exists('gsd-core/references/debugger-semantic-recall.md', 'the debugger-semantic-recall.md reference must exist');
    ctx.doc('gsd-core/references/debugger-semantic-recall.md')
      .has(/mempalace/i, 'it must name MemPalace as the semantic-memory surface')
      .has(/semantic/i, 'it must document semantic (not keyword) recall')
      .has(/top-?k|meaning.similar|semantically.similar/i, 'it must document surfacing top-k meaning-similar prior resolutions')
      .has(/different.{0,30}word|lexically|same root cause|wording/i, 'it must state that semantic recall catches same-root-cause, different-wording cases that keyword overlap misses')
      .has(/index|archive|store|capture/i, 'it must document that resolved sessions are indexed into MemPalace at archive time')
      .has(/fall[\s-]?back|fallback|when[^\n]{0,500}(?:absent|unavailable)|degrade/i, 'it must document degradation to keyword matching when MemPalace is absent')
      .has(/keyword/i, 'it must name keyword matching as the fallback')
      .has(/error patterns/i, 'the fallback must scan the Error patterns field')
      .has(/2\+ token overlap/i, 'the fallback must keep the 2+ token overlap threshold')
      .has(/identifier/i, 'the fallback must keep identifier extraction (the highest-signal token)')
      .has(/case-insensitive/i, 'the fallback must keep the case-insensitive qualifier')
      .has(/knowledge-base\.md|durable|plain[\s-]?text|source of truth/i, 'it must state that knowledge-base.md remains the durable plain-text source of truth')
      .has(/reuse|no new|without adding|existing[^\n]{0,500}(?:semantic|memory|capability)/i, 'it must state that MemPalace is reused rather than adding new embedding or vector infrastructure');

    ctx.doc('agents/gsd-debugger.md')
      .has('@~/.claude/gsd-core/references/debugger-semantic-recall.md', 'gsd-debugger.md must @-include the semantic-recall reference from the knowledge_base_protocol / Matching Logic')
      .has(/semantic/i, 'the agent must reference semantic recall')
      .has(/mempalace/i, 'the agent must name MemPalace')
      .has(/fall[\s-]?back|fallback/i, 'the agent must describe the keyword fallback')
      .lacks(/keyword overlap, not semantic similarity/i, 'the old "Matching is keyword overlap, not semantic similarity" claim must be removed (it is now semantic-first)');
  },
};
