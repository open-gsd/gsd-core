---
type: Fixed
pr: 1148
---
**`/gsd:phase insert` and `/gsd:phase --edit` no longer dead-end recording Roadmap Evolution** — `query state.add-roadmap-evolution` was rejected as "SDK-only" with an error that pointed back at the very command that just failed, and no CJS handler existed after the SDK retirement. The handler is now implemented in CJS, so the insert/edit phase workflows append the `### Roadmap Evolution` entry under `## Accumulated Context` (creating the subsection if missing, deduping identical entries) as documented. (#1148)
