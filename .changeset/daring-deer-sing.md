---
type: Fixed
pr: 5732
---
**Saving settings as global defaults no longer deletes keys the settings flow does not manage** — `/gsd-settings` replaced `~/.gsd/defaults.json` with its own fixed object, so `model_overrides`, `effort`, `runtime`, `resolve_model_ids` and unlisted `workflow` keys were lost on every save. It now merges into the file, a saved branching strategy now reaches new projects instead of reverting to `none`, a `defaults.json` kept as a symlink stays one, and a failed write of the store leaves the file as it was. (#5681)
