---
type: Fixed
pr: 2168
---
**phase complete now updates STATE progress on milestone-grouped roadmaps** — deriveProgressFromRoadmap parses the ## Progress table by header (column-by-name) instead of a fixed 4-column layout, so the 5-column milestone-grouped shape is no longer silently unparsed.
