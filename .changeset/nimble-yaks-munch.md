---
type: Fixed
pr: 1231
---
**`changeset new --pr 0` now accepted at creation** — the required-field guard treated the integer 0 as a missing `--pr` flag, so the documented `pr: 0` placeholder could not be authored via the CLI. (#1231)
