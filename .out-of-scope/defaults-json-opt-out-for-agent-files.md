# Opt-out of ~/.gsd/defaults.json overrides in generated agent files

**Source:** [#5530](https://github.com/open-gsd/gsd-core/issues/5530) (claim 3 of 3)
**Decision:** wontfix — the merge is intentional; claims 1 and 2 of the issue remain open as bugs
**Date:** 2026-10-19

## Proposal summary

The report listed `~/.gsd/defaults.json` leaking into generated agent files as one of three
reproducibility problems with `--local` installs: for example `effort.agent_overrides`
setting `gsd-planner` to `low` writes `effort: low` into the project's
`.claude/agents/gsd-planner.md`. The ask was an opt-out so a `--local` install is
independent of the machine-wide file.

## Why GSD does not own this

- **The merge is the designed behavior.** `~/.gsd/defaults.json` is the machine-wide
  defaults layer, and the installer embeds its model/effort overrides when generating agent
  files (`bin/install.js`, comment "Embed model override when configured in
  ~/.gsd/defaults.json"). Merging it per key was settled in
  [#3532](https://github.com/open-gsd/gsd-core/issues/3532) and
  [#4071](https://github.com/open-gsd/gsd-core/issues/4071). The reporter acknowledged this.
- **An opt-out adds a second configuration axis** to a layer whose purpose is to apply
  everywhere on the machine, with no concrete failure beyond "the result differs from another machine".

## What this does NOT cover

Claim 1 (`--relative-includes` dropped on reinstall/update) and claim 2 (#338 migration
moving or dropping non-GSD hooks) are confirmed bugs and stay open on #5530. A bug where
`defaults.json` is applied incorrectly (wrong key, wrong precedence) is also welcome.

## Re-open criteria

A concrete case where an intended project-level value is overridden by a machine default
and cannot be corrected through project config, with the precedence rules in
`docs/CONFIGURATION.md` unable to express it.

## Related

- [#3532](https://github.com/open-gsd/gsd-core/issues/3532), [#4071](https://github.com/open-gsd/gsd-core/issues/4071)
