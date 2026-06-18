---
type: Added
pr: 1440
---
**Runtime capability registry overlay** — installed third-party capabilities (under `~/.gsd/capabilities/` or a project's `.gsd/capabilities/`) are now composed into the registry at runtime via `loadRegistry({ includeInstalled })`: validated against the same conformance invariants as first-party, first-party-wins on any collision, skipped-with-a-warning when incompatible with the running GSD version (`engines.gsd`), with gate-kind capabilities failing closed. Installed overlays are toggable via surface and federate their config keys (cwd-aware) exactly like first-party. Foundation (ADR-1244 Phase 2) for capability install/upgrade/remove.
