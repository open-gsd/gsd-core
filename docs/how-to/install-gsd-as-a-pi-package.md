# How to install GSD as a Pi package

Install GSD in [Pi](https://pi.dev) with Pi's own package manager instead of the gsd-core installer.

**You need:** Pi 1.3.0 or later and Node.js 24 or later.

## Install

1. Install the package, pinned to a version:

   ```bash
   pi install npm:@opengsd/gsd-core@1.18.0
   ```

   Add `-l` to install it for the current project only (Pi writes the declaration to `.pi/settings.json` and loads it after you trust the project).
2. Restart Pi. The package registers the `/gsd` command, the `gsd_invoke` tool and one skill per GSD command.
3. Start a workflow the same way as with the installer: `/skill:gsd-new-project`, or `/gsd new-project`. See [Start a GSD workflow from Pi](start-a-gsd-workflow-from-pi.md).

`pi list` shows the installed package, `pi update --extensions` reconciles it, and `pi remove npm:@opengsd/gsd-core` removes it.

## What you get

The package gives the same commands and the same extension as `npx @opengsd/gsd-core --pi`: the extension file is the same `pi/gsd.cjs`, and every skill is the text the installer would write, rendered for the package's location. Nothing is written to `~/.pi/agent/skills` or `~/.pi/agent/extensions`. The skills are rendered into `~/.pi/agent/gsd-package-cache/<id>/skills` when Pi discovers resources at startup (`$PI_CODING_AGENT_DIR/gsd-package-cache/` when you set that variable) and Pi is pointed at that directory. A new package version or a moved package gets its own `<id>`; GSD keeps the three newest and removes older ones.

The extension also puts the package's `gsd-core/bin` first on `PATH` for the Pi session, so workflow steps that run `gsd_run` find the engine without a per-runtime config directory.

## What a package install runs

A Pi package runs code with your user's permissions. Installing this one loads the GSD extension (`pi/gsd.cjs`), which starts GSD's engine and hook scripts, not only skills. With `-l`, the declaration lives in the project's `.pi/settings.json` and Pi's project trust prompt is the only gate, so trust a project only when you trust its `.pi/settings.json`. The extension refuses to write a package location that contains shell or markdown metacharacters (anything outside letters, digits and `. _ / : @ + ~ -` and spaces) into skill text; if your package lives in such a directory it shows the "could not be prepared" error below.

## Do not install both ways

Use the package or the installer, not both. If the installer's extension (`~/.pi/agent/extensions/gsd.js`) is also present, the package stands down so `/gsd` and the skills are not registered twice, and Pi shows one warning at session start. Remove one of the two:

```bash
pi remove npm:@opengsd/gsd-core
```

or remove the installer's files with `npx @opengsd/gsd-core --pi --global --uninstall`.

## If it does not work

| What you see | Why | What to do |
|---|---|---|
| No `/gsd` command and no `gsd-*` skills after the restart | Pi has not trusted the project (a `-l` install), or the package was not loaded | Run `pi list`; for a project install, trust the project when Pi asks. |
| Warning: `GSD is installed both as a Pi package and by the gsd-core installer` | Both distribution paths are present | Remove one, as above. |
| Error: `GSD skills could not be prepared: ...` | The message names the cause: the Pi agent directory is read-only or full, the package's skill templates are missing, or the package location contains characters GSD will not write into skill text | Fix what the message names and restart Pi. Until then `/gsd <workflow>` reports that the skill is unavailable, and `/gsd` data commands still work. |
| A workflow step says `gsd-tools.cjs not found` | A shell outside the Pi session ran the step | Run workflows from inside Pi; the `PATH` change applies to Pi's own shell. |

Agent steps behave as they do on an installer install: see [Start a GSD workflow from Pi](start-a-gsd-workflow-from-pi.md#when-a-workflow-stops-at-an-agent-step).

## Release and versioning (maintainers)

The Pi package is the existing `@opengsd/gsd-core` npm package, not a second one: it carries a `pi` manifest (`"pi": { "extensions": ["./pi/gsd.cjs"] }`) and the `pi-package` keyword. It has the same name, the same version and the same release pipeline (`release.yml`), so there is no extra publish step; publishing to npm remains a maintainer action. The skill templates under `pi/package-skills/` are generated from the installer's output by `npm run gen:pi-package-skills` (part of `npm run build`), and `npm run lint:generated-sync` fails when they are stale, which is what keeps the two paths from diverging.
