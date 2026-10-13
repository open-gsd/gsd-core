---
type: Fixed
pr: 5353
---
**A capability can now deliver review rules to the built-in code reviewer (#4790)** — a contribution with `into: "code-reviewer"` was rejected at install because the execute host published only `executor` and `verifier`, and the reviewer prompt had nowhere to receive one anyway. `code-reviewer` is now an execution-family role, and `code-review.md` adds the active reviewer contributions for its loop point to the reviewer prompt once, beside the project's `agent_skills` guidance.
