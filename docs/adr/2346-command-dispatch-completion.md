# ADR-2346: Command Dispatch Completion

- **Status:** Accepted
- **Date:** 2026-07-17
- **Issue:** [#2346](https://github.com/open-gsd/gsd-core/issues/2346)
- **Epic:** [#2345](https://github.com/open-gsd/gsd-core/issues/2345) (Command Dispatch Completion)
- **Builds on:** [ADR-959](959-capability-command-contribution.md) (Capability Command Contribution — graduated `Proposed → Accepted` by this ADR) · [ADR-0012](0012-command-routing-hub.md) / [ADR-0174](0174-retire-gsd-sdk-package-boundary.md) (CommandRoutingHub)

## Context

ADR-959 established that an in-tree command family is *"just a router, discovered via the registry instead of hardcoded"* into `runCommand`'s switch, and named `_dispatchNonFamily` as *"the deliberately-prepared seam for registry dispatch"* (today a dead shim that always returns `false`). Three first-party families (`graphify`/`audit`/`intel`) were cut over to `dispatchCapabilityCommand` in the `default` case.

But ADR-959's scope is **family discovery only** — it assumes the 73-case switch and the `route*Command` routers *persist*. It does **not** decide (a) dissolving the switch *entirely*, or (b) where single-purpose "leaf" verbs belong. As a result the switch was never dissolved, and `runCommand` remains the repo's largest structural liability:

- **#1 PageRank symbol** (most central),
- **#1 Tarjan articulation point** (removing it splits the call graph into 4 components),
- **#1 most complex function** (cognitive complexity 1927, cyclomatic 616, ~2,338 lines),
- with **4+ duplicated inline arg-parsers** (`capFlagValue`, `capRepeatedFlag`, `getFlagValue`, and bespoke per-arm consume-loops) and a 706-line `case 'capability':` arm nesting ~40 inline `cap*` helpers.

`runCommand`'s upstream blast radius is **LOW** — only `main()` calls it — so a dissolution is internally safe to execute phase by phase.

## Decision

Complete the ADR-959 cutover and dissolve the switch entirely into a **two-layer dispatch**, recording four decisions ADR-959 leaves open. Each was grilled to a shared understanding before this ADR landed.

### 1. Two-layer dispatch (end state)

`runCommand` collapses to a ~15-line dispatcher:

```
try registry (dispatchCapabilityCommand)   // families — ADR-959 mechanism, completed
  → try leaf table (_dispatchNonFamily)     // single-purpose verbs — fills the prepared seam
    → unknown-command error
```

- **Families** (multi-subcommand, module-backed) route through the `commandFamilies` registry exactly as `graphify`/`audit`/`intel` already do.
- **Leaf verbs** (single-purpose) live in a dispatch table that fills the prepared `_dispatchNonFamily` seam — single-purpose verbs are *not* perverted into fake capability families (a leaf like `generate-slug` has no feature bundle, no config gate, no tier).

### 2. Family/leaf classification rule

> Promote a cluster to a **family** when it has **(a) ≥3 related subcommands**, **(b) a shared backing module**, and **(c) a shared parse/return shape**. Lone verbs or pairs stay **leaves** (two adapters over different modules ≠ one seam).

Applied: 9 families result — `state`, `phase`, `init`, `roadmap`, `validate`/`verify`, `capability`, plus 4 promoted clusters (`config`, `research`, `resolve`, `git`). `worktree` + `workstream` stay leaves (2 verbs, different modules). ~40 remaining verbs rehome into ~4 themed leaf modules.

### 3. Shared `parseFamilyArgs`

A single helper (in `cjs-command-router-adapter.cts`, beside `routeHubCommandFamily`) consumes `--flag value` pairs → `{ values, positionals, repeated }` and calls `error()` on missing values. It deletes the 4+ duplicated inline arg-parsers (`capFlagValue`/`capRepeatedFlag`/`getFlagValue` and the bespoke `resolve-*` loops). Value-validation (e.g. `--effort` boolean coercion) stays per-handler; file-reading helpers (`readRequired`/`readOptional`) stay with their handlers. Introduced with its **first real consumer** (the Phase-1 cutover), not as a zero-consumer "foundation" PR (one adapter = hypothetical seam).

### 4. Capability arm extraction shape

The 706-line `case 'capability':` arm becomes a thin `capability-command-router` (intel-shaped, using `routeHubCommandFamily`) plus a `capability-cli.cts` owning the CLI wiring (scope resolution, output formatting, reconcile sweep). Handler bodies stay thin (resolve → `lifecycle.X` → format) — the fat logic already lives in `capability-writer`/trust/consent modules and is *wired*, not moved. Duplicated probes are consolidated: `capHostVersion` reuses `readHostVersion()`; `capReadStrict` + drift-guard's copy collapse into one shared `readStrictKnownRegistries`.

### 5. Phasing (epic #2345)

Each phase is one approved sub-issue + one behavior-preserving PR targeting `next`, each proven equivalent by extending the `tests/audit-command-cutover.test.cjs` 5-category template (UNIT / DISPATCH / BEHAVIOR / JSON-ERRORS / REGISTRY):

| Phase | Content |
|---|---|
| P1 | `parseFamilyArgs` (first consumer) + Tier-1 family cutovers (`state`/`phase`/`init`/`roadmap`/`validate`/`verify`) |
| P2 | capability arm extraction + `readStrictKnownRegistries` consolidation |
| P3 | promote `config`/`research`/`resolve`/`git` clusters to families |
| P4 | leaf dispatch table (fills `_dispatchNonFamily`) + `runCommand` collapse to ~15 lines |

## Alternatives considered

1. **Amend ADR-959** to expand its scope to full dissolution — rejected: it would bloat a focused mechanism-ADR ("the `commands` field") into an execution-plan ADR. ADR-959 stays the mechanism; this ADR is the completion decision.
2. **Everything-is-a-registry-family** (even `generate-slug`) — rejected: the capability registry is for co-located feature *bundles*, not 3-line leaf verbs; it would manufacture ~60 tiny router files and 60 capability declarations for one-liners.
3. **One flat dispatch table, no registry** — rejected: abandons ADR-959's decided direction.
4. **Tier-1-only cutover** (pure ADR-959 completion, no dissolution) — rejected: the thin family arms aren't where the mass lives; `runCommand` would barely shrink and remain the #1 hotspot.

## Consequences

- **Positive:** the repo's #1 central/bridge/complexity hotspot is eliminated; locality (each family's parsing lives in its router) and leverage (one dispatch path, N families); the duplicated arg-parsers are killed once, everywhere; ADR-959 graduates `Proposed → Accepted` with working completion as its evidence.
- **Negative / cost:** a sequence of ~4 behavior-preserving cutover PRs; the two dispatch paths (registry + leaf table) coexist transiently until P4 collapses the switch; each cutover carries a cutover-equivalence test (real work, not a no-op).
- **Neutral:** every command keeps its exact name/output/exit-code/flags (behavior-preserving); unmigrated commands stay on their current path until their phase lands.

## Out of scope

Third-party / out-of-tree command modules (deferred per ADR-959 §5); the `runCommand` argument-resolution preamble (`--cwd`, `--json-errors`, workstream context) which stays in `main()`; any change to command *names* or *outputs*.
