---
type: Fixed
pr: 3806
---
**`validate health` no longer emits W005/W006/I001 false positives for multi-digit phase prefixes, milestone-archive phases, and descriptor PLAN/SUMMARY stem pairs** — PR #3479 fixed these three false-positive classes in `sdk/src/query/validate.ts` but the fix never propagated to `gsd-core/bin/lib/verify.cjs`, which is the runtime bundle that `gsd-tools.cjs validate health` actually executes. This PR ports the three fixes: (1) W005 regex widened from `\d{2}` to `\d{2,}` so `999.1-foo` and other multi-digit backlog directories are accepted; (2) W006 now calls `forEachArchivedPhaseToken` after `collectDiskPhases` so phases whose directories live in a milestone archive are not flagged as missing; (3) I001 now builds the `summaryBases` Set with both raw and canonical plan stems so `68-01-scaffolding-PLAN.md` correctly matches `68-01-SUMMARY.md`. (#3806)
