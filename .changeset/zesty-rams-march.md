---
type: Security
pr: 1706
---
**Install write-confinement (ADR-1239 Phase B)** — the installer now rejects any runtime-descriptor `destSubpath` that would write or delete outside the user's config home (path traversal, the config root itself, NUL bytes) and refuses to follow a pre-existing symlink that escapes it. Hardening only; no change to legitimate installs.
