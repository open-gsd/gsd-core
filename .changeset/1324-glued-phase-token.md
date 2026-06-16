---
type: Fixed
pr: 1353
---

**Glued letter-prefix phase directories now resolve correctly** -- phase lookup now recognizes tokens like `P0.3` and `M1-2` from directory names, so phase commands can find their plans instead of reporting none found. (#1324)
