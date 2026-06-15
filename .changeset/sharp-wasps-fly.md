---
type: Fixed
pr: 1252
---
**`state.*` writes no longer silently revert the STATE.md frontmatter `status`/`stopped_at`** — an incidental write (e.g. `state record-session`) that doesn't change the body's `Status:`/`Stopped at:` source field now preserves the existing frontmatter value instead of re-deriving it from possibly-stale body text. Legitimate transitions (e.g. `begin-phase`/`complete-phase`, which do update the body Status) still re-derive normally, so a verified-complete phase can no longer be flipped back to `verifying` by an unrelated write.
