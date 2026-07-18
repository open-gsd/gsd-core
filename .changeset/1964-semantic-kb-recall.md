---
type: Changed
pr: 0
---
**`gsd-debugger` now recalls prior resolved sessions semantically via MemPalace instead of keyword overlap** — at Phase 0 the debugger queries MemPalace with the current symptoms and surfaces the top-k meaning-similar prior resolutions as candidate hypotheses, catching the same-root-cause / different-wording cases keyword overlap missed (a prior "requests hang under load" now surfaces for "API times out when many users connect"). Resolved sessions are indexed into MemPalace at archive (symptoms + root cause(s) + fix + recurrence guard). `knowledge-base.md` remains the durable plain-text source of truth; when MemPalace is absent the debugger falls back to keyword-overlap matching against it (logged, never a silent skip). No new embedding/vector infrastructure — MemPalace is reused. Full rules live in `gsd-core/references/debugger-semantic-recall.md`. (#1964)
