# Kiro (AWS) CLI + IDE as a first-class runtime in gsd-core

**Source:** [#4722](https://github.com/open-gsd/gsd-core/issues/4722)
**Decision:** wontfix — No-go as filed; redirected to the EoS Registry / out-of-tree host-plugin path (or a Capability, if the actual need turns out to be feature-shaped rather than runtime-shaped)
**Date:** 2026-09-14

## Proposal summary

#4722 asked to add `--kiro` as a new first-party, in-tree runtime integration for AWS's Kiro CLI + IDE — a new runtime descriptor and installer wiring, structurally the same shape as prior first-party-runtime requests.

## Why GSD does not own this

- **GSD is not expanding its in-tree supported-runtime set.** Same standing ground recorded in [`crush-runtime-in-core.md`](./crush-runtime-in-core.md) and [`omp-runtime-in-core.md`](./omp-runtime-in-core.md): each first-class runtime is a permanent maintenance obligation across the registry, installer, artifact conversion, agent discovery, model routing, dispatch isolation, golden install-parity fixtures, and localized capability matrices — carried indefinitely for a host GSD does not control.
- **The policy is explicitly non-case-by-case and host-agnostic.** No Kiro-specific prior denial existed before this issue, but the standing decision text evaluates "does this ask for a new runtime or add-on in-tree," not "is this particular one well executed" or "is this host well-known/well-backed" — AWS backing does not change the maintenance-obligation calculus the policy is about.
- **`kiro` does not exist in `capabilities/` or `docs/registries/eos.json` today** (verified at triage time).

## What this does NOT cover

This entry denies **first-party, in-tree runtime registration for Kiro.** It does not deny, and must never be cited against:

- **Shipping an out-of-tree host-plugin for Kiro**, via the Host-Integration SDK, listed in `docs/registries/eos.json` — same path as `gsd-cursor`/`gsd-omp`/`gsd-reasonix`.
- **A Kiro integration built as a Capability**, if what's actually needed is a toggleable feature rather than a new host identity.
- **Fixing defects that surface through a non-registered runtime**, or improving the documented override/SDK contracts a host plugin depends on.
- **Any existing runtime's support tier.**

## Re-open criteria

- GSD reopens first-class in-tree runtime registration — e.g. funded development changes the maintenance calculus, or third-party `role: "runtime"` descriptors become loadable from outside the repo (ADR-857 D8's deferred purely-additive external loader). Until one of these holds, the answer for any new host is the EoS Registry, not the in-tree registry.
- Kiro demonstrates an integration need the EoS Host-Integration Interface genuinely cannot express (none shown to date).

## Related

- [`crush-runtime-in-core.md`](./crush-runtime-in-core.md) — sibling decision, same ground, same standing policy
- [`omp-runtime-in-core.md`](./omp-runtime-in-core.md) — sibling decision, same ground
- [`zoo-runtime-in-core.md`](./zoo-runtime-in-core.md) — sibling decision filed the same day, same ground
- [ADR-1239](../docs/adr/1239-gsd-embeddable-orchestration-engine.md) — GSD as an Embeddable Orchestration Engine (EoS)
- [`docs/how-to/author-a-host-plugin.md`](../docs/how-to/author-a-host-plugin.md) — the supported out-of-tree authoring path
- [`docs/how-to/develop-a-capability.md`](../docs/how-to/develop-a-capability.md) — the Capability path, if the need turns out to be feature-shaped
