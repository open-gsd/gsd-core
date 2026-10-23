---
type: Fixed
pr: 5280
---
**`phases clear` no longer claims it deletes phase directories** — since #1871 it archives each non-sentinel directory under `.planning/milestones/<label>-phases/`, but the --confirm gate and the #1447 uncommitted-changes guard still said "delete" and "permanently delete". The wording steered operators away from a recoverable action (and made #3129's reader conclude the command destroys phase work). The messages also name the active planning root (a workstream's own `milestones/`), and under `--json-errors` the two refusals now carry the typed reasons `phases_clear_confirm_required` and `phases_clear_uncommitted_changes` instead of `unknown` (under `--exit-contract=v2` they exit as USAGE and UNAVAILABLE; v1 exit codes are unchanged). Nothing else about the command changes.
