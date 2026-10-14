# Lowering `engines.node` below 24

**Source:** [#5326](https://github.com/open-gsd/gsd-core/issues/5326)
**Decision:** wontfix — closed as filed; the declared floor stays `>=24.0.0`
**Date:** 2026-10-13

## Proposal summary

#5326 asked to relax `package.json`'s `engines.node` from `>=24.0.0` to Node 22 (or to document which
entry points genuinely need 24). The evidence was two `gsd_invoke_command` calls through the MCP server
(`check auto-mode`, `phase next-decimal`) and a state read/write round-trip that gave the same results
on Node 22.22.2 as on Node 24.21.0. The stated cost of the current floor is that downstream tooling
warns or refuses on a runtime that appeared to work, including installs where the harness's PATH points
at an older Node.

## Why GSD does not own this

- **The floor is a recorded decision, not an accident.** ADR-3212 §2 ("The Node floor is the Active LTS
  line") raised `engines.node` to `>=24.0.0` and dropped the Node 22 lane, because `RegExp.escape` is
  absent in Node 22 (`docs/adr/3212-lexical-seam-consolidation.md`, lines 94-98).
- **The floor is a support promise, and CI backs only Node 24.** Every `node-version` in
  `.github/workflows/test.yml` is `24`. Lowering the declared floor would promise a runtime the in-repo
  CI does not test, and two successful tool calls do not show that every entry point works there.
- **What the proposal got RIGHT is not denied.** `src/pattern.cts` does carry a fallback below Node 24
  (`escapeRegex` uses `RegExp.escape` when present, otherwise an in-file metacharacter escape; #3498),
  so Node 22 can work for that seam. This entry records that the declared floor is a deliberate support
  statement, not that Node 22 is known to fail.

## What this does NOT cover

- **Documenting which entry points need Node 24.** A request to document accurate runtime requirements
  per entry point is welcome and is not denied here.
- **Fixing a concrete Node 22 failure** that a user hits while running on a newer-than-supported
  runtime. A reproducible break is a normal bug report; this entry only denies changing the declared floor.
- **Raising the floor** when a later Active LTS line is adopted by ADR.

## Re-open criteria

- A Node 22 lane runs in the repository's own CI (not only an out-of-repo runner) and passes the full
  suite, together with an ADR amendment to ADR-3212 §2 that moves the supported floor.
- Node 22 support becomes a stated project requirement (for example through an ADR) rather than an
  incidental result.

## Related

- [ADR-3212](../docs/adr/3212-lexical-seam-consolidation.md) — §2 sets the Node floor
- [#3498](https://github.com/open-gsd/gsd-core/issues/3498) — added the below-Node-24 fallback in `src/pattern.cts`
