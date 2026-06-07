# Runtime Install Policy Module owns the typed install-plan projection

- **Status:** Accepted
- **Date:** 2026-06-07
- **Issue:** #58

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

## References

- ADR-0001 — Dispatch Policy Module (pure-policy-projects / thin-adapters-execute precedent).
- ADR-3660 — Runtime Artifact Layout Module (per-runtime artifact placement; delegated to by this projection).
- ADR-0009 — Shell Command Projection Module (runtime-aware command text; delegated to by this projection).
- ADR-0008 — Installer Migration Module (adjacent installer seam).
- `CONTEXT.md` § Glossary — Domain modules and seams (the architecture seam map / glossary this module is registered in).
- Installer-refactor chain: #58 (this ADR) → #60 (explicit adapter registry) → #56 (retire legacy directory helpers) → #57.

## Addendum: Qoder runtime (#860)

- **Date:** 2026-06-11
- **PR:** #1021

Qoder (`qodercli`) registered in the Runtime Config Adapter Registry:

- `qoder: { installSurface: 'profile-marker-only', writesSharedSettings: false, finishPermissionWriter: null }`

Identical adapter shape to Trae and Windsurf. No new adapter logic needed — the `profile-marker-only` surface produces no settings writes and no permission entries. The registry entry exists solely so `resolveRuntimeConfigIntent('qoder')` resolves without throwing and the layout-driven install/uninstall pipelines include Qoder in their iteration.
