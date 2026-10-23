---
type: Fixed
pr: 5617
---
**Non-Claude executor dispatch no longer breaks on apostrophes in the agent persona** — the orchestrator-worktree prompt is composed with a quoted heredoc, so spliced agent-skills text and inlined role files reach the executor byte-for-byte instead of closing the shell assignment. (#5531)
