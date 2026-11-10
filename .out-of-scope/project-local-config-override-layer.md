# Git-ignored per-developer config layer (`.planning/config.local.json`)

**Source:** [#5977](https://github.com/open-gsd/gsd-core/issues/5977)
**Decision:** wontfix — closed as an enhancement; redirected to the feature request form
**Date:** 2026-11-08

## Proposal summary

The reporter asked for an optional, git-ignored `.planning/config.local.json` next to a team's
committed `.planning/config.json`, deep-merged over it so each developer can override a few keys
(model profile, effort, workflow and hook toggles, local tool paths) without editing the shared
file. The same local file would apply to workstream and project-scoped configs. Every reader (the
config loader, `config-get` and its root fallback, direct JSON readers, hooks) would see the
merged view; `config-set`, loader write-back and migrations would never write local values into
the tracked file; a malformed local file would be an error flagged by the health check; and the
installer would add the file to the project `.gitignore`.

## Why GSD does not own this

- **It is a new concept, not an enhancement.** `CONTRIBUTING.md` defines an enhancement as one
  that "does not add new commands, new workflows, or new concepts". A new configuration layer
  brings its own precedence, write rules, workstream and project variants, a health-check rule
  and an installer `.gitignore` change. [#5956](https://github.com/open-gsd/gsd-core/issues/5956)
  was closed on the same ground for adding a new config layer.
- **The premise is correct and is not a ground for rejection.** `~/.gsd/defaults.json` is not
  read for model resolution once `.planning/config.json` exists. That is deliberate
  ([#3532](https://github.com/open-gsd/gsd-core/issues/3532)) and documented in
  `docs/CONFIGURATION.md` under "Global Defaults", so it does not cover per-developer overrides
  inside one project.

## What this does NOT cover

- A feature request for per-developer project overrides, filed through the feature request
  form. That is welcome and gets a feature review; this entry denies only the enhancement route.
- Bugs in how the existing layers (built-in defaults, `~/.gsd/defaults.json`,
  `.planning/config.json`, workstream configs) merge or take precedence.
- The settled `~/.gsd/defaults.json` behavior recorded in
  `defaults-json-opt-out-for-agent-files.md`.

## Re-open criteria

The request is filed as a feature request and passes feature review. Under the enhancement
label, it re-opens only if the change adds no new configuration file or layer.

## Related

- [#5956](https://github.com/open-gsd/gsd-core/issues/5956) (new config layer, same ground)
- [#3532](https://github.com/open-gsd/gsd-core/issues/3532) (global defaults scope)
- `defaults-json-opt-out-for-agent-files.md`
