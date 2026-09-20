# Zoo Code (successor of archived Roo Code) as a first-class runtime in gsd-core

**Source:** [#4746](https://github.com/open-gsd/gsd-core/issues/4746)
**Decision:** wontfix — No-go as filed; redirected to the EoS Registry / out-of-tree host-plugin path (or a Capability, if the actual need turns out to be feature-shaped rather than runtime-shaped)
**Date:** 2026-09-14

## Policy (standing, not case-by-case)

**GSD is not accepting new runtimes or add-ons as first-party, in-tree work at this time — full stop, not a "go-with-conditions" case-by-case call.** This is the same standing ground already recorded twice: [`crush-runtime-in-core.md`](./crush-runtime-in-core.md) and [`omp-runtime-in-core.md`](./omp-runtime-in-core.md). The standing decision text is direct: evaluate "does this ask for a new runtime or add-on in-tree," not "is this particular one well executed." Nothing about Zoo's specific quality, research depth, or the reporter's cited working private-fork port changes this — the same class of well-executed prior asks (crush, OMP, Reasonix) were declined on identical grounds.

## Proposal summary

#4746 asked to add `zoo` (Zoo Code, the VS Code extension community continuation of the archived Roo Code) as a **first-party, in-tree** tier-2 runtime: a `capabilities/zoo/capability.json` descriptor, alias canonicalization (`roo`, `roo-code`, `roo-cline`, `zoo-code` → `zoo`), and a new dedicated `zoo-modes` install-surface writer to merge GSD agents into Zoo's single-file `.roomodes`/`custom_modes.yaml` custom-mode format (following the `cline-rules` precedent for merge-into-one-file surfaces). The proposal included extensive docs-verified integration facts (schema, tool names, subagent dispatch semantics, globalStorage paths) and cited a working private-fork port (`harmony-ai-solutions/gsd-roo-code`).

## Why GSD does not own this

- **GSD is not expanding its in-tree supported-runtime set.** Each first-class runtime is a permanent maintenance obligation across the registry, installer, artifact conversion, agent discovery, model routing, dispatch isolation, golden install-parity fixtures, and localized capability matrices — carried indefinitely for a host GSD does not control.
- **Neither `zoo` nor `roo` exists in `capabilities/` or `docs/registries/eos.json` today** (verified at triage time), so there is no existing partial support to build on that would change the calculus.

## What this does NOT cover

This entry denies **first-party, in-tree runtime registration for Zoo Code.** It does not deny, and must never be cited against:

- **Shipping an out-of-tree host-plugin for Zoo Code.** This is welcome and supported, and is the intended route — a Zoo plugin that embeds GSD via the Host-Integration SDK and is listed in `docs/registries/eos.json`, same as `gsd-cursor`/`gsd-omp`/`gsd-reasonix`. The reporter's own docs-verified integration research (custom-modes schema, `.roo/commands/` layout, `new_task` subagent dispatch) is directly reusable there without any gsd-core change.
- **Shipping Zoo as a third-party `role: "runtime"` capability via ADR-1244's external loader.** ADR-857 D8 deferred third-party CLI/runtime support "to an external loader + trust/validation gate"; ADR-1244 (Accepted, ratified 2026-07-17) is that ADR and delivers that gate — a third-party capability, including `role: "runtime"`, can be installed from outside gsd-core's own tree (`~/.gsd/capabilities/<id>/` global, or `.gsd/capabilities/<id>/` project-scoped) under its trust/consent model. This is a live mechanism today, not a future trigger — see "Re-open criteria" below.
- **A Zoo integration built as a Capability**, if what's actually needed is a toggleable feature rather than a new host identity.
- **Fixing defects that surface through a non-registered runtime**, or improving the documented override/SDK contracts a host plugin depends on.
- **Migrations of already-supported runtimes onto the EoS architecture.**
- **Any existing runtime's support tier**, including the unrelated existing `cline` runtime this proposal modeled its shape on.

## Re-open criteria

- **The ADR-857 D8 external-loader condition is already met** — ADR-1244 (Accepted 2026-07-17) delivers third-party `role: "runtime"` capability loading; this is no longer a future trigger. What remains unmet is a maintainer decision to expand gsd-core's own *first-party, in-tree* supported-runtime set specifically — that is a bandwidth/scope call, not a tooling gap, and reopens only if funded development changes the maintenance calculus described above.
- Zoo Code demonstrates an integration need the EoS Host-Integration Interface AND the ADR-1244 third-party capability loader genuinely cannot express (none shown to date).

## Related

- [`crush-runtime-in-core.md`](./crush-runtime-in-core.md) — sibling decision, same ground, same standing policy
- [`omp-runtime-in-core.md`](./omp-runtime-in-core.md) — sibling decision, same ground
- [`kiro-runtime-in-core.md`](./kiro-runtime-in-core.md) — sibling decision filed the same day, same ground
- [ADR-1239](../docs/adr/1239-gsd-embeddable-orchestration-engine.md) — GSD as an Embeddable Orchestration Engine (EoS)
- [`docs/how-to/author-a-host-plugin.md`](../docs/how-to/author-a-host-plugin.md) — the supported out-of-tree authoring path
- [`docs/how-to/develop-a-capability.md`](../docs/how-to/develop-a-capability.md) — the Capability path, if the need turns out to be feature-shaped
