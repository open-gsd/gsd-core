---
type: Fixed
pr: 2139
---
**`roadmap get-phase` resolves project-code-prefixed headings by bare number** — a bare-number query (e.g. `29`) now resolves a drifted `### Phase AB-29:` heading, matching the internal resolver used by `init.phase-op`; previously the CLI returned empty. A bare sibling (`### Phase 29:`) still takes precedence. A project-code-prefixed heading present only as a summary/checklist line (no matching detail section) now reports a `malformed_roadmap` diagnostic — for both prefixed and bare-number queries — instead of a silent empty result. (#2114)
