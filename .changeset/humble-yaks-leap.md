---
type: Fixed
pr: 5622
---
**`phase insert` now places a new decimal phase after its existing later decimal siblings** — inserting after phase 13 when 13.1 already existed wrote the new 13.2 section above 13.1 (13, 13.2, 13.1, 14), in both heading and checklist-only roadmaps and with `--sibling`; the new entry now lands at the end of its parent's subtree. (#5599)
