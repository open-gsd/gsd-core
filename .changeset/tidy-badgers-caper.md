---
type: Fixed
pr: 2225
---
**Linuxbrew users no longer lose all GSD-managed hooks after `brew upgrade node`** — normalizeNodePath only recognized macOS Homebrew Cellar paths, so on Linux the version-pinned node path stayed baked into hook commands and 404'd after a node bump (and reinstall couldn't repair it). It now rewrites any Homebrew Cellar path — Intel, Apple Silicon, Linuxbrew, custom HOMEBREW_PREFIX — to the stable `<prefix>/bin/node` symlink. (#2185)
