---
type: Fixed
pr: 5420
---
<!-- docs-exempt: agent prompt internal gate alignment and shared reference update; no public CLI or docs change -->
**Shared requirements are no longer marked complete prematurely when executing via `/gsd-execute-phase`** — `agents/gsd-executor.md` now gates requirement completion through `requirements.ready-ids` before invoking `requirements.mark-complete`, preventing shared requirement IDs from being marked complete in `REQUIREMENTS.md` before all declaring sibling plans have finished (#4944). In addition, `<documentation_lookup>` was extracted to the shared reference `@~/.claude/gsd-core/references/research-documentation-lookup.md` to accommodate the gate within the large agent budget cap, and the shared reference was updated to include `mcp__plugin_context7_context7__*` tools and the training-knowledge disclaimer so executor and researcher prompt guidance remains fully aligned.
