---
type: Fixed
pr: 1232
---
**`gsd-tools` CLI no longer crashes at load on installed runtimes** — the installer now copies `scripts/fix-slash-commands.cjs` into the runtime config dir, where `command-roster` hard-requires it via `../../../scripts/`. Previously the file shipped in the npm tarball but was never installed, so every `gsd_run` invocation died at module load with `MODULE_NOT_FOUND` and no GSD workflow could run. `readCmdNames()` also now degrades to `[]` when no `commands/gsd` directory exists.
