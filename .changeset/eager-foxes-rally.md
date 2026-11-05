---
type: Fixed
pr: 5403
---
**Config commands refuse unsupported preview flags** — config-ensure-section, config-set-model-profile, and migrate-config now reject --dry-run, --json, --force, --workstream, repeated --cwd / --project-dir, other unknown flags, and extra positional arguments with a usage error before creating or rewriting config.json; supported --raw and ordinary mutations retain their behavior.
