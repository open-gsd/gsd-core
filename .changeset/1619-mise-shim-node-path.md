---
type: Fixed
pr: 1621
---
**`normalizeNodePath` now maps pruned mise node paths to the stable shim (#1619)** — `resolveNodeRunner()` bakes `process.execPath` into managed `.js` hook commands. Node realpaths execPath, so under mise it resolves to `<data>/installs/node/<ver>/bin/node` — a concrete version mise prunes on `mise up`, after which every managed hook fails to spawn (`No such file or directory` on every SessionStart and tool event), the same ephemeral-path failure #977 fixed for fnm and #3181 for Homebrew. `normalizeNodePath` now rewrites a mise versioned install path to the stable sibling shim `<data>/shims/node` (`.exe` preserved on Windows) when that shim exists, deriving `<data>` from execPath so a custom `MISE_DATA_DIR` works, and falling back to the raw execPath unchanged otherwise. (#1619)
