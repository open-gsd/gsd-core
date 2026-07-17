---
type: Fixed
pr: 0
---
**`phase complete` no longer silently drops requirement IDs the roadmap cites but REQUIREMENTS.md never defined** — completing a phase whose `**Requirements**:` line named an unregistered REQ-ID reported `requirements_updated: true` with zero warnings while the file was left byte-for-byte unchanged, indistinguishable from a run that wrote everything. Ghost IDs now raise a warning, `requirements_updated` reflects whether a write actually landed, an active heading like `## v1 Requirements` is no longer mistaken for a deferred section, and a phase whose every cited ID is unregistered still reports its missing-requirement rows instead of "No requirements or decisions to check."
