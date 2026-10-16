---
type: Fixed
pr: 5450
---
When Claude Code refuses a subagent's Write of an exact name such as SUMMARY.md, the research synthesizer now returns the complete document inline instead of a blocked message, and new-project and new-milestone persist it through the existing self-heal; the orchestrators no longer treat that refusal as a fabricated one or generalise it to other agents (#5449).
