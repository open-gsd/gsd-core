---
type: Fixed
pr: 305
---
Use a single-pass max-by-mtime scan for statusline todo lookup, dropping the per-render O(n log n) sort (#305).
