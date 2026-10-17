---
type: Fixed
pr: 5468
---
`review-lane invoke --prompt-file` now reaches the cursor, antigravity and kimi-code review lanes. Their prompt path is embedded in argv, so the budget-trimmed prompt was silently ignored and the lane read the full prompt; the per-reviewer prompt cap now takes effect for them.
