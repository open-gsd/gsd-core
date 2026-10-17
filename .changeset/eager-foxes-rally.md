---
type: Fixed
pr: 5403
---
**Config commands refuse unsupported preview flags** — config-ensure-section, config-set-model-profile, and migrate-config now reject --dry-run and unknown flags with a usage error before creating or rewriting config.json; supported --raw and ordinary mutations retain their behavior.
