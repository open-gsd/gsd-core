# Separating phase completion from verification freshness

**Source:** [#5851](https://github.com/open-gsd/gsd-core/issues/5851)
**Decision:** wontfix — by design under ADR-5057
**Date:** 2026-11-03

## Proposal summary

A phase whose `*-VERIFICATION.md` says `status: passed` but whose `covered_digest` no longer matches (a later phase edited files it covered) reads as "Verification required" in the manager view. The reporter asked that completion be separated from freshness, so a passed-but-stale phase stays complete and staleness is reported as a separate signal, and that the stale route be reconsidered.

## Why GSD does not own this

- **It is the specified behavior.** `docs/adr/5057-one-owner-per-workflow-verdict.md` makes a passed-but-stale phase EXECUTED, never COMPLETE, in every surface (`progress`, `stats`, `init plan-phase`, `gsd-health`), with a property test and a positive control. `phaseStatusFromFacts` (`src/phase-status.cts`) lists `stale` under EXECUTED and `gsd-core/workflows/manager.md` maps `executed` to "Verification required".
- **The fail-closed staleness contract was kept on purpose.** Epic #4907 was closed not planned and absorbed into ADR-5057, which lists weakening the fail-closed staleness contract as a non-goal. #4953 (the same root cause) was closed not planned.
- **Acknowledged:** the reporter's observation that many phases go stale from later code edits is accurate and is not the ground for rejection.

## What this does NOT cover

- Wording of the "Verification required" label or of the stale remedy text, which is presentation and may be proposed separately.
- Reducing false staleness (for example which edits invalidate `covered_digest`), as long as it keeps stale-means-not-complete.
- A bug where a phase is shown stale or complete contrary to ADR-5057.

## Re-open criteria

A new ADR that supersedes ADR-5057's rule that a passed-but-stale phase is EXECUTED, with the property test and positive control updated to match.

## Related

- `docs/adr/5057-one-owner-per-workflow-verdict.md`
- #4907, #4953
