---
type: Fixed
pr: 0
---
**Requirement IDs shared by plans of one parallel worktree wave are now marked complete after the wave merges** — each worktree executor's shared-ID gate sees only its own `SUMMARY.md`, so an ID declared by two or more plans was blocked in every executor and none marked it (it stayed unchecked until phase completion, or forever if the ROADMAP requirements line did not cite it); the orchestrator's post-wave step now evaluates the gate once on the merged tree, marks the IDs whose declaring plans all have summaries (only when the post-merge tests passed), and commits REQUIREMENTS.md. (#6102)
