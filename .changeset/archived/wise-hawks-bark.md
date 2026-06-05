---
type: Fixed
pr: 582
---
Six writer agents (`gsd-eval-planner`, `gsd-ai-researcher`, `gsd-domain-researcher`, `gsd-phase-researcher`, `gsd-ui-researcher`, `gsd-debug-session-manager`) now carry `Edit` alongside `Write` in their `tools:` frontmatter, so the Edit-only discipline in their spawn prompts is enforceable. Previously, without `Edit`, they fell back to whole-file `Write` and silently clobbered sibling sections of shared files such as `AI-SPEC.md`. Same bug class as #571 (fixed for `gsd-doc-writer` in #575). See #581.
