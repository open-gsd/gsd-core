---
type: Fixed
pr: 2154
---
**`/gsd-secure-phase` now has a single SECURITY.md writer** — the `gsd-security-auditor` subagent previously held `Write`/`Edit` tools and was instructed to "write SECURITY.md" with no padded `<N>-` prefix and no template frontmatter, while the orchestrator's Step 6 also wrote the phase-scoped `<N>-SECURITY.md` from `templates/SECURITY.md`. The auditor is now return-only (drops `Write`/`Edit`, returns a structured verdict with `threats_open`); the orchestrator is the sole file writer. The workflow's Step 5 spawn constraints explicitly forbid the auditor from writing SECURITY.md. (#2119)
