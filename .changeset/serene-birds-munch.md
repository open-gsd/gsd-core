---
type: Fixed
pr: 0
---
**A capability contribution declared `into: verifier` now reaches the verifier** — it installed and showed up in the rendered hooks but was dropped silently because the `gsd-verifier` prompt rendered no contributions, including MemPalace's problem-capture instructions; the verifier dispatch now appends them (after the agent-skills guidance, escaped, advisory) for contributions declared at `execute:post`, and MemPalace's moved there from `execute:wave:post`, where no verifier runs. (#5984)
