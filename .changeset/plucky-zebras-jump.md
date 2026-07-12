---
type: Fixed
pr: 0
---
**`/gsd-ship` no longer silently drops the ship-status note from STATE on merge** — the track_shipping step committed the STATE ship-note after creating the PR but never pushed it, so on a fast merge the note stayed local-only and never reached the default branch. The ship-note is now pushed onto the PR branch with a `[ci skip]` trailer so it lands on merge without a redundant pipeline. (#2138)
