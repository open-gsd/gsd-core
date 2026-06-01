---
type: Fixed
pr: 582
---
Six writer agents (`gsd-eval-planner`, `gsd-ai-researcher`, `gsd-domain-researcher`, `gsd-phase-researcher`, `gsd-ui-researcher`, `gsd-debug-session-manager`) now carry `Edit` alongside `Write` in their `tools:` frontmatter. Their spawn prompts instruct surgical in-place section edits on existing/shared files (notably the `AI-SPEC.md` trio writing disjoint sections of the same file), but without `Edit` they fell back to whole-file `Write` and silently clobbered sibling sections. Same bug class as #571 (fixed for `gsd-doc-writer` in #575). See #581.
