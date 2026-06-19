---
type: Added
pr: 1450
---
**Third-party capabilities can ship dispatchable CLI commands (ADR-1244 Phase 5)** — a capability that declares a `commands` family is now dispatched by `gsd-tools <family>` via the registry, the same seam the first-party `graphify`/`intel`/`audit` commands already use. Third-party command dispatch runs only for an installed, consented capability (a committed ledger entry) and loads the router module strictly from that capability's own install root (basename + realpath confinement, rejecting `..` traversal and symlink escape); a bundle merely present on disk with no install record keeps its declarative surfaces but is never command-dispatchable. (#1450)
