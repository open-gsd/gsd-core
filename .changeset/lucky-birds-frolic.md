---
type: Fixed
pr: 5463
---
With `GSD_HOME` set, the install-time model/tools/effort resolvers, the installer's non-Claude defaults write and revert, the isolation and Cursor hooks' runtime fallback, capability staging and the `/gsd-settings` and `/gsd-new-project` workflows now use `$GSD_HOME/.gsd/defaults.json` like the config loader, instead of `~/.gsd/defaults.json` (#5017)
