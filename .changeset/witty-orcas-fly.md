---
type: Fixed
pr: 6223
---
**`--default` no longer swallows a following flag** — `gsd-tools <command> --default --dry-run` used to take `--dry-run` as the default value and remove it before the command ran, so `migrate-config` wrote the config. A missing or `--`-led `--default` value is now a usage error, as for `--cwd`, `--project-dir`, `--ws` and `--pick`; a bare trailing `--default` no longer means an empty default, so pass `--default ""` for that. A missing, empty or `--`-led `--ws` value now reports the usage reason too, as does a `--ws=` with nothing but spaces after it (the `=` form is trimmed); any other invalid workstream name, including `--ws ' '`, is reported as before.
