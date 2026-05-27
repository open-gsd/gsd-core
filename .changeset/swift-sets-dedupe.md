---
type: Fixed
pr: 313
---
Dedupe extracted exports with a Set instead of O(n^2) array.includes scans in intelExtractExports (#313).
