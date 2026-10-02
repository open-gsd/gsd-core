# Claude Code mod adapter (in-session status band) in the gsd-core plugin

**Source:** [#5174](https://github.com/open-gsd/gsd-core/issues/5174)
**Decision:** wontfix — No-go for now; the Claude Code mod interface is too new to build in-tree support on. Revisit in November 2026.
**Date:** 2026-10-02

## Proposal summary

#5174 asked for an optional, Claude-Code-only "mod" inside the existing gsd-core plugin: a `hooks/gsd.mjs` module registered through a `modules` entry in `hooks/hooks.json`, drawing a GSD status band (phase and plan read from `.planning/STATE.md`) above the prompt. It listed two later steps that were not proposed for approval yet: moving the context monitor's `/tmp` bridge and debounce state into module memory, and calling the guard logic from the module while keeping the command hooks for non-mod hosts.

## Why GSD does not own this

- **The host interface is one day old.** Mods shipped in Claude Code 2.1.287 on 2026-10-01. There is one version and no field history, so there is no evidence yet of how stable `register(on, options)`, the render sites or the generated plugin types are. The maintainer's ruling is that the interface must settle for at least 30 days before gsd-core makes a significant change to support it.
- **It is a host-specific in-tree add-on.** The standing policy in [`kiro-runtime-in-core.md`](./kiro-runtime-in-core.md) is that GSD is not accepting new runtimes or add-ons as first-party, in-tree work. A Claude-Code-only adapter shipped inside the plugin is closest in shape to [`codex-native-supervisor-adapter.md`](./codex-native-supervisor-adapter.md), which was also denied.
- **Statusline data sources are a feature decision.** [ADR-2164](../docs/adr/2164-statusline-scope-boundary.md) treats a new statusline segment or data source as a feature, and `hooks/gsd-statusline.js` already surfaces GSD state.
- **Moving guards into a mod would put them on an interface with no history.** Steps E and C of the proposal are denied on that ground as well.

Reading local `.planning/STATE.md` is within the statusline data boundary, so the idea is not rejected for what it reads.

## What this does NOT cover

This entry denies **an in-tree Claude Code mod in the gsd-core plugin, now.** It does not deny, and must never be cited against:

- **A standalone mods plugin** published outside gsd-core that draws GSD state; the mods platform supports it natively.
- **An out-of-tree host plugin** per [`docs/how-to/author-a-host-plugin.md`](../docs/how-to/author-a-host-plugin.md).
- **Other statusline or hook work** that does not depend on the mod interface, including consolidating hook processes.
- **Fixing defects in the existing hooks or statusline.**
- **Plugin install support for Claude Code generally.**

## Re-open criteria

- **Time and stability:** on or after 2026-11-01, the mod interface has been in a released Claude Code for at least 30 days and a resubmission names the released version and shows the interface unchanged across it (no breaking changes to `register`, the render sites or the generated types).
- **Policy:** the maintainer's standing no-in-tree-add-ons ground in [`kiro-runtime-in-core.md`](./kiro-runtime-in-core.md) no longer applies, or the resubmission shows a need that a standalone mods plugin and the EoS host-plugin path cannot express.

## Related

- [`kiro-runtime-in-core.md`](./kiro-runtime-in-core.md) — standing policy on in-tree runtimes and add-ons
- [`codex-native-supervisor-adapter.md`](./codex-native-supervisor-adapter.md) — host-specific adapter, same shape
- [`statusline-account-usage.md`](./statusline-account-usage.md) — statusline data-boundary precedent
- [ADR-2164](../docs/adr/2164-statusline-scope-boundary.md) — statusline scope boundary
