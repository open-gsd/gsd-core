# OMP Support

GSD Core can install native OMP artifacts with the existing installer:

```sh
node bin/install.js --local --omp
```

## Install targets

Local installs write to `.omp/` in the current workspace:

- `.omp/commands/gsd-*.md`
- `.omp/skills/gsd-*/SKILL.md`
- `.omp/agents/gsd-*.md`
- `.omp/rules/gsd-*.md` for explicit safe rule mappings only
- `.omp/extensions/gsd-core/` for executable GSD guardrails and status behavior

Global installs write to `OMP_CONFIG_DIR` when set, otherwise `~/.omp/agent`:

```sh
OMP_CONFIG_DIR=~/.omp/agent node bin/install.js --global --omp
```

## First action

After install, open the workspace in OMP and start a new GSD workflow with:

```text
/gsd-new-project
```

If the installer detects an existing Spec Kit/GSD workspace state, follow the next action printed in the OMP readiness summary instead.

## Update and profile-limited installs

Use the same profile flow as other runtimes:

```sh
node bin/install.js --local --omp --profile=core
node bin/install.js --local --omp
```

Reinstall replaces only GSD-managed `gsd-*` OMP artifacts and preserves user-owned OMP commands, skills, agents, rules, and non-GSD extension directories.

For agents, OMP installs honor GSD `model_overrides` from `.planning/config.json` and `~/.gsd/defaults.json` by embedding the resolved model in each generated `.omp/agents/gsd-*.md` frontmatter. Bare OMP role names (`plan`, `task`, `smol`, `slow`, `vision`, `commit`, `designer`, `default`) are normalized to OMP `pi/<role>` aliases so they resolve through OMP `modelRoles`.

## Uninstall

```sh
node bin/install.js --local --omp --uninstall
```

Uninstall removes only GSD-managed artifacts and manifest/profile markers, including `.omp/extensions/gsd-core/`. Non-GSD `.omp` files and extension directories are left in place.

## Readiness and native extension support

The installer prints deterministic OMP readiness output that includes:

- resolved install target,
- installed artifact counts by kind,
- detected workspace state,
- next action guidance.

Executable GSD behavior is delivered by the native `.omp/extensions/gsd-core/` extension, not by static rules. The extension ports GSD's hook guardrails, update checks, context warnings, and status behavior through OMP's extension events. Static `.omp/rules/` entries remain limited to explicit safe rule mappings from `gsd-core/omp/rules/manifest.json`.
