---
type: Security
pr: 1449
---
**Third-party capability trust gate (ADR-1244 Phase 4)** — installing a capability from a git/npm/tarball/local source now discloses every executable surface it ships (hooks, command modules, MCP servers, with the actual commands) and requires explicit consent before anything is promoted; integrity (sha512) and `engines.gsd` are verified before any code is staged, install never executes capability code, and reserved `gsd-`/`gsd-core-`/`anthropic-` namespaces are refused. `capabilities.strict_known_registries` gates which sources may be installed (`[]` = local-only lockdown; host-based allowlist otherwise) and `capabilities.auto_update` is off by default, re-prompting whenever a new version's executable set changes. An install ledger makes `remove` surgical (strips only the capability's own shared-config entries, preserving your hand-edits) and `update` an atomic, crash-safe stage-then-swap. (#1449)
