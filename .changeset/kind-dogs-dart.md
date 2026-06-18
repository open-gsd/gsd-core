---
type: Added
pr: 1436
---
**Capability manifests are now versioned** — every `capability.json` carries a required semver `version`, plus optional `engines.gsd`, `compatVersions`, `integrity` and `provenance` fields, enforced by the capability conformance validator. First-party capabilities are version-stamped in lockstep with the GSD release. Foundation (ADR-1244 Phase 1) for installing, upgrading, and removing capabilities in later releases.
