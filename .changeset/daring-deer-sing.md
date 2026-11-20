---
type: Fixed
pr: 6127
---
**Saving settings as global defaults no longer deletes keys the settings flow does not manage** — `/gsd-settings` replaced `~/.gsd/defaults.json` with its own fixed object, so `model_overrides`, `effort`, `runtime`, `resolve_model_ids` and unlisted `workflow` keys were lost on every save. It now merges into the file, a saved branching strategy now reaches new projects instead of reverting to `none`, a `defaults.json` kept as a symlink stays one, a failed write of the store leaves the file as it was, and a new project's migration of a stored `depth` no longer overwrites a save made at the same time. (#5681)
