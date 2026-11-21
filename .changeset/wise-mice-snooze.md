---
type: Fixed
pr: 6191
---
**The ship workflow's ship-note commit no longer carries a CI skip token** — GitHub honors the skip token anywhere in a commit message, and a squash (default message) or rebase merge copied it onto the default branch, where the merge push started no workflow runs. The `track_shipping` step now commits the ship-note without it and accepts one docs-only pipeline on the PR branch; the empty wedge-recovery commit and the merge-state polling that existed only to undo the token are removed. (#6173)
