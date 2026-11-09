---
type: Changed
pr: 0
---
**gsd-tools commands reject stray words and unknown flags they used to ignore** — a misspelled or unsupported flag, a missing required input, or an extra word now stops the command with a usage error naming the problem, instead of being silently ignored; a repeated flag now uses its first value on every command (`resolve-execution`, `update-context`, `loop render-hooks` and `record-dispatch-isolation` took the last one, or preferred the `=` form, before); every command's accepted flags are listed in docs/CLI-SURFACE-MANIFEST.json (#6087).
