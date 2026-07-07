# Existing Code Onboarding Module owns deterministic repo-state detection and onboarding route selection

- **Status:** Proposed
- **Date:** 2026-07-06
- **Issue:** #1990
- **Implementation:** PR #1994

## Context

GSD already ships strong individual primitives for adopting an existing codebase: `/gsd:map-codebase` (parallel codebase analysis), `/gsd:ingest-docs` (classify and consolidate existing ADR/PRD/SPEC/RFC docs), and `/gsd:new-project` (planning initialization). What it lacked was a single guided entry point that inspects a brownfield repository and tells the user *which primitive runs first*.

Left to prose alone, that ordering is ambiguous and unsafe: a user can initialize planning before a codebase map exists, skip relevant design docs, or overwrite/duplicate `.planning/` context instead of reusing it. The ordering is not a matter of taste — it is a **dependency graph** (a map should exist before planning; existing design docs should be ingested before a fresh `/gsd:new-project`; nothing should clobber an in-progress `.planning/`). A dependency graph that decides the next safe action from filesystem state is a *projection*, not something a workflow's natural-language instructions can evaluate reliably or test.

GSD already has the seam for this. The **Init Command Module** (`src/init.cts` → `gsd-core/bin/lib/init.cjs`) owns the `init.*` family of query handlers that compose atomic queries into the flat JSON bundles that init workflows consume, alongside the projection-module precedent set by the **Planning Path Projection Module** (ADR-0006) and the **Shell Command Projection Module** (ADR-0009). Adding `/gsd:onboard` as free-form workflow prose that scans the tree inline would put untested, non-deterministic filesystem logic in markdown — precisely the anti-pattern those projection modules exist to prevent.

## Decision

Introduce the **Existing Code Onboarding Module** (implemented as the `src/onboard-projection.cts` → `gsd-core/bin/lib/onboard-projection.cjs` projection) as the Seam that owns **deterministic detection of brownfield repository state and the selection of the next onboarding action**. It is a pure, side-effect-free projection consumed by the Init Command Module's `initOnboard` handler and rendered by the `/gsd:onboard` workflow. It never writes; detection and route selection are a function of repository state only.

**Detected state (inputs):**

| Signal | Rule / invariant |
|---|---|
| Brownfield code present | Depth-capped recursive scan for source files (`hasCodeFilesInternal`) OR a recognized package manifest (`hasPackageFileInternal`). |
| Generated / vendor exclusion | Scan skips `CODE_SCAN_SKIP_DIRS` (`node_modules`, `dist`, `build`, `.next`, `.nuxt`, `.svelte-kit`, `coverage`, `vendor`, `.venv`, `venv`) so vendored trees never produce a false brownfield positive. |
| Codebase-map completeness | Whether `.planning/codebase/` holds the canonical map artifacts. |
| Existing design docs | Presence of ADR/PRD/SPEC/RFC-style candidates (root, nested, and segment-based). |
| Partial planning state | Whether some but not all of `PROJECT.md` / `REQUIREMENTS.md` / `ROADMAP.md` / `STATE.md` exist. |

**Route selection (output), ordered by dependency, not by convenience:**

1. Brownfield code without a complete `.planning/codebase/` map → hand off to `/gsd:map-codebase` (or `/gsd:map-codebase --fast` in fast mode).
2. Design-doc candidates present and no project yet → offer `/gsd:ingest-docs` **before** `/gsd:new-project`.
3. Otherwise → `/gsd:new-project`.

The gate order is load-bearing: **partial-planning and fast-map-completeness are evaluated before the docs-ingest branch**, so a half-mapped or half-initialized repo is never routed past the step it still owes. Handoff commands are runtime-formatted (`buildHandoffCommands` / `formatGsdSlash`) so the projected next command is correct for the installed runtime's slash syntax.

**Safety invariants (the reason this is a Module, not a helper):**

- **Idempotent / no silent overwrite.** Onboarding never mutates existing tracked `.planning/` artifacts; re-running leaves them byte-unchanged.
- **`SUMMARY.md` is a trailing artifact.** `.planning/onboarding/SUMMARY.md` is written only *after* project setup exists, and only if absent.
- **"Complete" is a conjunction.** Onboarding does not report complete until `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, and `STATE.md` all exist — no single-file short-circuit.
- **Text-mode parity.** `--text` renders the same gate decisions as numbered plain-text prompts, so runtimes without an interactive picker get identical routing.

## What stays OUTSIDE this Module

- **The primitives themselves.** `/gsd:map-codebase`, `/gsd:ingest-docs`, and `/gsd:new-project` retain their own behavior; the Module only *chooses and orders* them. It projects the route; it does not re-implement the destinations.
- **Writing planning artifacts.** All `.planning/` writes remain owned by the destination commands and the Installer/planning modules. The projection is read-only.
- **The workflow's rendering.** `gsd-core/workflows/onboard.md` owns menu/gate presentation; the command `commands/gsd/onboard.md` (and its skill mirror) owns delegation. The Module owns only the state→route decision they consume.

## Consequences

- Brownfield onboarding becomes a single, testable entry point with deterministic routing, rather than order-of-operations folklore in prose. The projection is unit-tested (`tests/onboard-command.test.cjs`) for brownfield/greenfield detection, vendor-dir exclusion, gate ordering (partial-planning before docs-ingest), idempotency/no-mutation, and runtime-formatted handoffs.
- The Init Command Module gains one more heavyweight handler (`initOnboard`) with the same `{ data: <flat JSON> }` contract as its siblings — no new dispatch shape.
- **New maintenance coupling, now explicit.** The Module's completeness checks must track the canonical `.planning/codebase/` artifact list and the routing targets' identities; if `/gsd:map-codebase` / `/gsd:ingest-docs` / `/gsd:new-project` change their entry contracts, this projection must follow. This ADR records that coupling as the known cost of centralizing the routing decision (the alternative — duplicating the decision across each primitive — is worse).
- No new runtime dependencies; no change to existing command semantics (additive).

## Open questions

- Should codebase-map completeness be sourced from a single shared predicate (owned by the map module) rather than re-encoded here, so the two cannot drift?
- The `/gsd:onboard` workflow sources its `gsd_run` bootstrap from a shared `references/gsd-run-resolver.md` snippet rather than inlining it. If that delegation pattern is adopted by other workflows, it likely deserves its own short ADR — noting it here so the precedent is visible rather than silently established.

## References

- ADR-0006 — Planning Path Projection Module (projection-module precedent for `.planning` path resolution).
- ADR-0009 — Shell Command Projection Module (runtime-aware projection precedent).
- Init Command Module (`src/init.cts` → `gsd-core/bin/lib/init.cjs`) — owner of the `init.*` handler family that consumes this projection via `initOnboard`.
- `CONTEXT.md` § Init Command Module — where the onboarding projection is registered.
- Issue #1990 — feature spec and acceptance criteria.
