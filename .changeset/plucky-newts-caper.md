---
type: Fixed
pr: 5280
---
**`phases clear` no longer claims it deletes phase directories** — since #1871 it archives each non-sentinel directory under `.planning/milestones/<label>-phases/`, but the --confirm gate and the #1447 uncommitted-changes guard still said "delete" and "permanently delete". The wording steered operators away from a recoverable action (and made #3129's reader conclude the command destroys phase work). No behaviour change.
