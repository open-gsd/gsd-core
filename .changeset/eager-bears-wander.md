---
type: Fixed
pr: 2215
---
**`milestone_name` is no longer clobbered with a delimiter-led fragment** — getMilestoneInfo's `##` heading regex was unanchored, so it matched a heading quoted inside backticks in the Milestones bullet and wrote garbage like `— Active Milestone` over the curated milestone name on every phase transition. Now consults the 🚧 marker first, anchors the regex to line start, strips the leading delimiter, and widens the preserve guard so a bad derive keeps the existing name. (#2135)
