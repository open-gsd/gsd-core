---
type: Fixed
pr: 6296
---
**`/gsd-quick-batch --resume` no longer refuses a batch as "base revision diverged" after the batch's own merges** — the batch recorded the git HEAD it was created against and never advanced it, while its own executor commits, wave merges and final docs commit move HEAD, so resuming any batch that had merged an item was refused. The batch now records the HEAD it leaves behind after each of those steps (`quick-batch update --head-revision`), and resume compares the live HEAD to that recorded head; a HEAD moved by anything the batch did not record, an unknown batch id and a batch with no base revision behave as before. (#6203)
