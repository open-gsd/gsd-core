---
type: Fixed
pr: 6249
---
**`gsd-tools query detect-drift` reports a root-level file as a new file** — a file added directly at the repository root is now listed under `New files` instead of `New directories`, so the drift report no longer points the operator at a directory that does not exist.
