---
type: Fixed
pr: 314
---
`roadmap annotate-dependencies` now indexes plan data by ID in a Map before the checklist loop, reducing plan lookup from O(lines×plans) to O(lines+plans).
