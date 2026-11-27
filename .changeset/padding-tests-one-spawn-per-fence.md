---
type: Fixed
pr: 6786
---
**The merge-queue `Tests` run no longer fails on a stalled `bash` start in the #3829 padding tests** — they spawned about 80 `bash` processes, so one stalled start on a loaded macOS runner spent the whole 15 s probe bound; they now run each fence's derivation for every id inside one `bash`, so a stall has two chances to land instead of about 80. (#6784)
