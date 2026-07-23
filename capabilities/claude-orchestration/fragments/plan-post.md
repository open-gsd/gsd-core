# Claude orchestration — ultraplan plan-offload ownership (BETA)

> Injected at `plan:post` `into: planner` only when
> `claude_orchestration.enabled` is true. Default-off; `onError: skip`.

## Ownership declaration

The `gsd-ultraplan-phase` plan-offload surface (offloading GSD's plan phase to
Claude Code's ultraplan cloud) is **owned by this capability**, not by a
standalone BETA skill. Both surfaces share one runtime gate
(`claude_orchestration.enabled`), one BETA boundary, and one Claude-Code-only
detection seam.

## When the planner should consider ultraplan offload

When this contribution is active (capability enabled, Claude Code runtime), the
planner MAY offer the `/gsd-ultraplan-phase` path as an alternative to local
`/gsd-plan-phase` for phases where cloud-assisted planning adds value. This is
advisory, not mandatory — the stable local planner remains the default.

## Fallback contract

If the capability is disabled, or the runtime is not Claude Code, ultraplan
offload is **not surfaced** and the planner proceeds with the standard local
`/gsd-plan-phase`. The `gsd-ultraplan-phase` command itself remains installed
(its own runtime gate already no-ops on non-Claude runtimes); this contribution
only governs whether the capability manifest advertises it as part of the
orchestration surface.
