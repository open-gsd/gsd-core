---
type: Fixed
pr: 2016
---
**`roadmap update-plan-progress` no longer counts stray non-plan `*-SUMMARY.md` files against phase completion** — remediation/gap-closure summaries (e.g. `30-FIX-CR02-SUMMARY.md`, `30-GAPCLOSURE-SUMMARY.md`) inflated `summary_count`, and once `summary_count >= plan_count` the phase silently flipped to `Complete` (checkbox checked, date stamped) even though several plans had no summary. A new `countMatchedSummaries` helper (core-utils) pairs summaries to plans via the `PLAN→SUMMARY` marker swap + the `<stem>-SUMMARY.md` form (layout-agnostic across root, bare, and nested layouts), so only a summary that corresponds to a real plan counts. Wired into `scanPhasePlans` (fixing roadmap listing, state sync, verification, workstream inventory at once) and `cmdRoadmapUpdatePlanProgress`. (#1988)
