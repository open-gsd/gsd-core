# Runtime Install Policy Module owns the typed install-plan projection

- **Status:** Accepted
- **Date:** 2026-06-07
- **Issue:** #58
- **Subsumed by:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (GSD as an Embeddable Orchestration Engine) — read it first; see the amendment below
- **Subsumed by:** [ADR-857](857-capability-system.md) (Capability system) — generalizes this module's install-plan projection; this seam remains live at `src/runtime-artifact-install-plan.cts:82`

## Amendment (2026-07-16): subsumed by ADR-1239 (EoS)

[ADR-1239](1239-gsd-embeddable-orchestration-engine.md) — **GSD as an Embeddable Orchestration Engine** (EoS), Accepted — subsumes this ADR as an adapter: the typed `InstallPlan` projection this module owns becomes one of the surfaces the host negotiates for, rather than the outermost seam at which GSD meets a host.

**This ADR is not superseded and its status is unchanged.** The `InstallPlan` seam is live and load-bearing. It is now a *component* of the EoS frame, not the top-level answer to "how does GSD meet a host?".

**Read [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) first.**

Recorded because ADR-1239 declared this subsumption while this file recorded nothing.

## Amendment (2026-07-17): also subsumed by ADR-857 (Capability system)

[ADR-857](857-capability-system.md) was ratified `Proposed → Accepted` on 2026-07-17 and generalizes this module's install-plan projection into the unified Capability model (install composes *active Features × the chosen Runtime* at this ADR's `InstallPlan` seam).

**This ADR remains Accepted and live.** ADR-857's header originally read "Supersedes (generalizes)"; on ratification that was corrected to **Subsumes**, precisely because this seam is not dead — `InstallPlan` is live at `src/runtime-artifact-install-plan.cts:82`. This module is now a component of two broader frames: ADR-857 (what composes an install) and ADR-1239/EoS (how a host loads the engine at all).

## Context

Runtime install logic is currently spread across one-off helper functions. `getGlobalDir(runtime, explicitDir)` in `bin/install.js` switch-dispatches to per-runtime helpers (`getOpencodeGlobalDir`, `getKiloGlobalDir`), and `getAgentsDir` lives separately in `src/core.cts`. These helpers resolve directories at ~11 call sites and are free to drift from the behavior that install and runtime-query paths actually expect, because nothing owns the *composition* of an install decision as a single value.

Two adjacent seams already exist:

- **ADR-3660 (Runtime Artifact Layout Module)** owns *where* per-runtime artifacts (commands, agents, skills) are placed.
- **ADR-0009 (Shell Command Projection Module)** owns runtime-aware *command text* rendering (quoting, path style, wrapper prefixes).

But no ADR owns composing those — placements + command text + per-runtime config intentions — into one unified, typed install-plan projection. That missing seam is why directory/config logic re-derives itself ad hoc at each call site.

## Decision

Introduce a **Runtime Install Policy Module** as the seam that, given a runtime and an install context, **projects a pure, typed `InstallPlan` value** describing everything that should happen for that runtime. The projection:

- composes artifact placements by delegating to the Runtime Artifact Layout Module (ADR-3660),
- composes command text by delegating to the Shell Command Projection Module (ADR-0009),
- declares config *intentions* (which config files need which keys/values for that runtime),
- performs **no filesystem IO** and **no format-specific serialization** while resolving the plan.

Concrete execution is owned by runtime-specific **adapters** (made explicit as a registry in #60). Adapters consume the `InstallPlan` and perform the effectful work: file mutations, directory creation, and rendering format-specific config (TOML, JSON, Markdown) for their runtime.

This follows the repository's established pure-policy-projects / thin-adapters-execute pattern (ADR-0001, Dispatch Policy Module): the `InstallPlan` is the narrow waist, resolution stays free of IO, and callers become thin adapters over a stable interface rather than re-deriving directory logic.

## What stays OUTSIDE the policy module

To keep the abstraction honest about the filesystem boundary, the following are explicitly **not** the policy module's responsibility and remain in the runtime adapters:

- Concrete TOML / JSON / Markdown read-modify-write and serialization.
- Merge semantics for pre-existing config files (preserving user keys, ordering, formatting).
- Filesystem effects: directory creation, atomic write/rename, existence/permission checks.
- Any path resolution that requires touching the disk.

The policy module resolves *intent* as data; adapters turn that intent into bytes on disk.

## Consequences

- Install logic becomes testable as pure data: assert the projected `InstallPlan` for a runtime without a filesystem.
- The scattered directory helpers (`getGlobalDir`, `getOpencodeGlobalDir`, `getKiloGlobalDir`, `getAgentsDir`) gain a single projection to migrate onto, retiring or narrowing them (tracked in #56).
- The plan/adapter contract becomes a stability surface that must be held narrow; drift there reintroduces the very divergence this seam removes.
- Rollout is incremental, not big-bang: this ADR establishes the boundary (#58); the explicit Runtime Adapter Registry lands next (#60); legacy helper retirement follows (#56); downstream cleanup in #57.

## Implementation (2026-06-11)

The `InstallPlan` is realized as the exported `resolveInstallPlan(runtime)` in `runtime-config-adapter-registry` (co-located with adapter-selection, not a standalone module). It collects the install-level descriptor axes — `installSurface`, `writesSharedSettings`, `finishPermissionWriter`, `hookEvents`, `extendedHookEvents`, and `hooksSurface` — into one typed `InstallPlan` value. `install()` and `finishInstall()` in `bin/install.js` consume it directly. The spatial axes (`configHome`, `artifactLayout`, `commandStyle`) remain behind their self-resolving adapter modules (`runtime-homes`, `runtime-artifact-layout`, `runtime-slash`) as the execution adapters — consistent with this ADR's adapters-execute boundary.

## References

- ADR-0001 — Dispatch Policy Module (pure-policy-projects / thin-adapters-execute precedent).
- ADR-3660 — Runtime Artifact Layout Module (per-runtime artifact placement; delegated to by this projection).
- ADR-0009 — Shell Command Projection Module (runtime-aware command text; delegated to by this projection).
- ADR-0008 — Installer Migration Module (adjacent installer seam).
- `CONTEXT.md` § Glossary — Domain modules and seams (the architecture seam map / glossary this module is registered in).
- Installer-refactor chain: #58 (this ADR) → #60 (explicit adapter registry) → #56 (retire legacy directory helpers) → #57.
