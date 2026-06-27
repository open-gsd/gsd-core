---
type: Fixed
pr: 1777
---

`state sync` and `state json` no longer write or report incorrect progress when the current milestone cannot be resolved to a bounded ROADMAP section (free-form/unversioned milestone headings). Previously the phase count was derived from a scope that conflated every milestone, silently rewriting `total_phases`/`percent` in both the STATE.md body and frontmatter. GSD now detects the ambiguous scope, leaves the existing progress untouched, and surfaces a warning. Bounded, versioned, and single-milestone projects are unaffected.
