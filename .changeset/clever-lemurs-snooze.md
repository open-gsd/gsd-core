---
type: Changed
pr: 5392
---
**Gate `artifact-frontmatter-equals` blocks when more than one artifact matches (#5313)** — a phase holding two files that match a gate's artifact (for example a stale `BEADS.md` plus `NN-BEADS.md`, or `BEADS.md` plus `.planning/BEADS.md`) now blocks naming every candidate, instead of reading whichever the OS listed first.

Two companion behaviors: a symlink to the same file counts as one artifact, not an ambiguity; and because the phase directory is now always listed to detect ambiguity, a directory that exists but cannot be listed fails with the usage error even when the artifact sits directly in it (previously a direct hit skipped the listing).
