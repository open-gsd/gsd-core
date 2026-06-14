# ADR-1213: Capability write side — the Capability State Writer [Proposed]

- **Status:** Proposed
- **Date:** 2026-06-14
- **Issue:** #1213
- **Completes:** Capability system (ADR-857) — the write half of the phase-4 "Wire" step
- **Builds on:** Capability declaration format (ADR-894), Capability command contribution (ADR-959), Skill Surface Budget Module (ADR-0011)

## Context

ADR-857 promised: *"one resolved capability state replaces three contradicting toggle systems; 'off' means off."* The **read** side delivers it. The **Capability State Resolver** (`src/capability-state.cts`) collapses three substrates into one resolved state:

- install profile — `.gsd-profile` (is the capability's skill set installed?)
- runtime surface — `.gsd-surface.json` (is it surfaced into the runtime skills dir?)
- config gates — `config.json` `workflow.*` (is each hook configured on?)

with `enabled = installed && surfaced` and `active = enabled && configured`.

There is **no write side**. Three independent writers each mutate one substrate — `writeSurface` (`src/surface.cts`), `setConfigValue` (`src/config.cts`), `writeActiveProfile` (`src/install-profiles.cts`) — and every caller (`gsd:surface`, `gsd:settings`/`gsd:config`, `install.js`, and the future ADR-959 capability command) coordinates them by hand. So *off means off* holds only as a **read-time computation the write side can violate**: the worst case is a capability left surfaced while every hook is config-gated off — "present but dead", still materialized and still costing context, but doing nothing.

The three substrates are not three ways to say one "off". They are **orthogonal axes at different lifecycles**: install is files-on-disk (uninstall removes them), surface is reversible-without-reinstall runtime state, and config gates are per-workstream and version-controlled in `.planning/`.

## Decision

Introduce the **Capability State Writer** (`src/capability-writer.cts`), the inverse of the resolver:

```
setCapabilityState(cwd, runtimeConfigDir, desired: DesiredCapability[])
  -> { capabilities: CapabilityStateEntry[]; warnings: string[] }

DesiredCapability = { id: string; enabled?: boolean; gates?: Record<string, boolean> }
```

It accepts a *desired* capability state in the resolver's own vocabulary and projects it onto the substrates:

1. **Two orthogonal axes, one interface.** Per-capability `enabled` drives the runtime **surface** (the canonical capability on/off switch); per-hook `gates` drive the federated **config keys** (hook-level granularity within an enabled capability). The install profile is a **read-only floor** the writer never writes.
2. **Surface is the canonical "off".** Disabling unsurfaces — reversible, restart-and-go, and it reclaims the surface budget. It does not uninstall and does not clear config gates, so re-enabling restores prior gates; because `enabled = false` forces every hook `active = false` in the resolver, stale gates are harmless while off.
3. **One write per substrate.** A batch computes the full new surface state (one `writeSurface`) and the config deltas (one `setConfigValue` batch under `withPlanningLock`) — atomic per substrate, so no cross-substrate transaction is required.
4. **Assert-and-report.** After writing, re-run `resolveCapabilityState` and diff against `desired`; divergence (an uninstallable skill, a present-but-dead capability) is returned as `warnings`, not silently swallowed. The resolver is the writer's test surface: `resolve(write(s, d)) == d`.
5. **Callers.** `gsd:settings` and the ADR-959 capability command route capability mutations through it, and `gsd-tools capability set` is the direct CLI. `gsd:surface` is a broader skill-surface tool operating on the **cluster superset** — capability clusters plus hand-authored clusters such as `utility`/`audit_review` — so it keeps its own surface mechanism rather than routing through the capability-scoped writer; the resolver honours any surface write, so *off means off* holds regardless of which path wrote. `install.js` keeps the profile-floor write (install lifecycle).

A `gsd-tools capability set` subcommand (sibling to `capability state`) exposes it.

New domain term recorded in `CONTEXT.md`: **Capability State Writer**.

## Alternatives considered

| Decision | Rejected alternative | Why rejected |
|---|---|---|
| Substrate model | Collapse the three substrates into one capability-intent store | They encode genuinely different lifecycles (install = files on disk; surface = reversible runtime; config = per-workstream, version-controlled). Orthogonal axes, not redundant toggles; one store cannot hold the per-workstream config dimension without reinventing it. The resolver + writer win the invariant **without** merging the lifecycles. |
| Canonical "off" | Uninstall (drop from profile + delete files) | Heavy; needs a reinstall to undo; frees disk, not the context budget surface already reclaims. Keep uninstall as a separate explicit install-lifecycle operation. |
| Canonical "off" | Config-gate every hook | Leaves the skill surfaced-but-dead ("present but dead") and is per-workstream — contradicts off-means-off at capability granularity. |
| Interface scope | Capability-level enable only; hook gates stay in `config-set` | Splits the off-means-off invariant across two interfaces; the surfaced-but-all-gated check then has no single home. |
| Verification | Hard rollback (snapshot + restore) | Earns its keep only with cross-substrate transactions, which the one-write-per-substrate split avoids; assert-and-report suffices. |

## Consequences

**Positive**
- *Off means off* becomes a **write-time invariant**, not caller discipline.
- **Locality:** the projection and the invariants (including the present-but-dead check) live in one module.
- **Leverage:** one capability-mutation interface used by `gsd:settings`, the ADR-959 capability command, and the `capability set` CLI.
- Symmetric with the resolver seam; the surface and config writers become its internal adapters.

**Negative / costs**
- A new always-on module to build and keep correct (and a generated `.cjs` to ship via `build:lib`).
- The desired-state vocabulary becomes a depended-on interface (Hyrum's Law) — name it and keep it compatible.
- The present-but-dead signal is advisory: the writer warns rather than auto-mutating, respecting explicit intent.

## Open questions

- Whether `enabled: true` for a capability below the install floor should auto-add it to surface `explicitAdds` (transitive closure) or warn-and-refuse.
- Whether the round-trip `resolve ∘ write == identity` warrants a deterministic CI conformance test alongside ADR-894's registry gates.
