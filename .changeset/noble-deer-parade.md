---
type: Added
pr: 1443
---
**Capability source resolver + install ledger** — `resolveCapabilitySource(spec)` fetches a capability from a local path, git repo, npm package, or tarball URL, verifies it (sha512 integrity before staging, `engines.gsd` compatibility, full conformance validation) and stages a bundle **without executing any capability code** (copy/extract only — `npm pack --ignore-scripts`, never `npm install`; symlink/tar-slip/shell-metacharacter/unsafe-transport inputs rejected). A per-runtime ledger records what each install wrote for atomic, reversible upgrade/remove. Foundation (ADR-1244 Phase 3) for the upcoming `gsd capability install` command.
