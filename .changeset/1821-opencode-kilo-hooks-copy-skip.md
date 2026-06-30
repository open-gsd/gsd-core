---
type: Fixed
pr: TBD
---
**`gsd install --opencode` and `--kilo` no longer copy unreachable hook scripts (#1821)** — the runtime descriptor for OpenCode and Kilo declares `hooksSurface: 'none'`, so `applySettingsJsonHooks()` correctly skips registering GSD's lifecycle hooks on those runtimes. The installer's copy guard at `bin/install.js` (both the `hooks/dist/*` and `hooks/lib/*` blocks) was still on the legacy hardcoded runtime-name list and missed both `isOpencode` and `isKilo`, so installing for either runtime copied a `~/.config/opencode/hooks/` (or `~/.config/kilo/hooks/`) full of `gsd-*.js` / `gsd-*.sh` files that nothing ever executes. The exclusion list now matches the registration-side predicate (see `src/runtime-hooks-surface.cts:1208-1213`); the files no longer land on disk and the user receives only `command/`, `skills/`, and `agents/`, which OpenCode/Kilo actually use.
