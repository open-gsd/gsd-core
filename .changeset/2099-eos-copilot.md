---
type: Changed
pr: 2172
---

**GitHub Copilot now wires GSD's full lifecycle hook bus and is driven by its capability descriptor** — installing GSD into Copilot registers `preToolUse`, `postToolUse`, `userPromptSubmitted`, and `sessionEnd` handlers in its `hooks/gsd-session.json` (beyond today's `sessionStart`-only advisory), and Copilot's residual hardcoded runtime branches are folded onto descriptor-driven `hostBehaviors`. (#2099)
