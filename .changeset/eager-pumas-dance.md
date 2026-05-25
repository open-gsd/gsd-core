---
type: Fixed
pr: 10
---
**Semver policy is now centralized for update/status/changeset flows** — semver parsing and core comparison were duplicated in six places with drift risk. This change introduces a shared comparator utility and migrates statusline, update worker, and changeset extraction to use one implementation, keeping dev-install and release gating behavior consistent across runtimes. (#10)
