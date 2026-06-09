---
type: Fixed
pr: 880
---
`getMilestonePhaseFilter` now excludes phase headings inside fenced code blocks (``` ``` ``` or `~~~`) — consistent with the fence-aware behavior of `extractCurrentMilestone`. Previously, a `### Phase N:` line inside a fenced block was wrongly counted as a real phase. (#875)
