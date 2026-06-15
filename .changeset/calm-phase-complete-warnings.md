---
type: Fixed
pr: 1197
---

**`phase complete` no longer emits false warnings from historical verification metadata or deferred requirement IDs** — two distinct false-positive warning bugs: (A) the verification-status check used a full-text regex that matched `previous_status: gaps_found` in the file body, triggering an "unresolved gaps" warning even when the current frontmatter `status: passed`; the check now reads only the frontmatter `status` key via `extractFrontmatter`. (B) requirement IDs under explicitly deferred/backlog/future/v2 section headings in `REQUIREMENTS.md` were flagged as missing from the Traceability table; the check now skips any section whose heading matches those terms. (#1197)
