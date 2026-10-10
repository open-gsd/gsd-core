---
type: Fixed
pr: 0
---
**`config-new-project` now refuses the choices `config-set` refuses** — an unknown key, or a value outside a key's allowed set (such as a `mode` placeholder left unfilled), now fails with the same error `config-set` gives, and no config is created. A dotted key in place of a nested one, and choices that are not a JSON object, are refused as well. A section given as an empty object sets nothing and is left out. Before, they were written into the new project's `.planning/config.json` and the command reported success. `--dry-run` is now honored: it prints the config that would be created and writes nothing, where it used to be ignored and the file written anyway. Any other flag, or a second positional argument, is refused.
