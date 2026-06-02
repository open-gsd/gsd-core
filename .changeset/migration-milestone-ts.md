---
type: Changed
pr: 537
---
Migrate `gsd-core/bin/lib/milestone.cjs` to a TypeScript source of truth (`src/milestone.cts`) per ADR-457 build-at-publish; compiled by `tsc` to a gitignored `.cjs` at the same `require()` path. Behaviour preserved byte-for-behaviour. Also relaxes `core`'s `output()` 3rd parameter to optional, matching its real (always-optional) call contract.

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; behaviourally-identical gitignored artifact at same require() path; no user-facing change. -->
