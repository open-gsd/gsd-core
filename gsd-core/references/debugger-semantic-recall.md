# Semantic Knowledge-Base Recall via MemPalace

Loaded by `gsd-debugger` via `@-include` from the `knowledge_base_protocol`
Matching Logic. Replaces keyword-overlap matching with **semantic recall** so a
prior session that resolved "requests hang under load" surfaces for a new "API
times out when many users connect" — same root cause, no shared keywords.

## Why this exists

The knowledge base's self-noted limitation was explicit: *"Matching is keyword
overlap, not semantic similarity."* Keyword overlap only fires on lexical
coincidence — the highest-value recalls (same root cause, different wording)
are exactly the ones it misses, and its value decays as the corpus grows.

## The approach — reuse MemPalace, add no new infrastructure

Layer semantic recall on top of the existing knowledge base by **reusing
MemPalace** (the semantic-memory capability already in this environment) —
**without adding new embedding or vector infrastructure** (Choose Boring /
Zawinski: spend no new "innovation token" on a bespoke vector store the
debugger would own).

`.planning/debug/knowledge-base.md` remains the **durable plain-text source of
truth**; semantic recall is an additive layer over it, not a replacement.

## Write — index resolved sessions at archive

At `archive_session`, after appending the entry to `knowledge-base.md`, **index
the resolved session into MemPalace**: the symptoms + root cause(s) + fix (and
the Prevention block's recurrence guard). This is what makes the session
recallable by meaning rather than by keyword.

## Read — query MemPalace at Phase 0

At Phase 0, **query MemPalace semantically with the current symptoms** and
surface the **top-k meaning-similar prior resolutions** as candidate
hypotheses. Each surfaced candidate flows into Evidence exactly as a
keyword-match candidate would — a hypothesis to test first, not a confirmed
diagnosis.

This catches the **same-root-cause / different-wording** case: a prior
"requests hang under load" resolution surfaces for "API times out when many
users connect" even though no keywords overlap.

## Graceful degradation — MemPalace absent

When MemPalace is unavailable (not installed, not configured, or the query
errors), **fall back to keyword-overlap matching** against
`knowledge-base.md`: extract nouns / error substrings from `Symptoms.errors`
and `Symptoms.actual` and scan each entry's `Error patterns` field for 2+
token overlap. The fallback is logged (Kernighan — never a silent skip), and
`knowledge-base.md` continues to be written regardless, so no session is lost
to a missing palace.

## Scope boundary (Zawinski's Law)

An additive recall layer over the existing knowledge base, reusing an existing
semantic-memory capability. Not a new command, not a vector database, not an
embedding pipeline the debugger owns. Where MemPalace is absent the debugger
behaves exactly as it did before this layer — keyword matching against the
plain-text knowledge base.
