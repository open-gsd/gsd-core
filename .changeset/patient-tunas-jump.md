---
type: Fixed
pr: 1499
---
**`npm version` no longer leaves `capability-registry.cjs` stale** — the `version` npm lifecycle script now regenerates and stages the capability registry after stamping new version strings into all capability manifests, preventing the 1.6.0-rc regression where `gen-capability-registry.cjs --check` failed. (#1498)

<!-- docs-exempt: internal release-tooling fix; no user-facing command or API change -->
