---
type: Changed
pr: 0
---
**gsd-tools commands reject flags they do not declare** — a misspelled or unsupported flag, a missing required input, or a stray word now stops the command with a usage error naming the problem, instead of being silently ignored; when a flag is repeated the first occurrence now wins on every command (`resolve-execution`, `update-context`, `loop render-hooks` and `record-dispatch-isolation` took the last one, or preferred the `=` form, before); every command's accepted flags are listed in docs/CLI-SURFACE-MANIFEST.json (#6087).
