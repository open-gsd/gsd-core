---
type: Fixed
pr: 1938
---
**Third-party capabilities now work on installed layouts.** `capability install` no longer rejects capabilities with a real `engines.gsd` range as "incompatible with GSD 0.0.0" — the host version is now read from the authoritative `gsd-core/VERSION` file across every runtime and the `capability install` CLI. The installer also now ships the registry generator scripts (`gen-capability-registry.cjs`, `gen-loop-host-contract.cjs`), so installed third-party capabilities actually compose into the loop instead of being silently discarded.
