---
type: Fixed
pr: 0
---
**A capability contribution declared `into: verifier` now reaches the verifier** — it installed and showed in the rendered hooks but was dropped silently, including MemPalace's problem-capture instructions; contributions declared at `execute:post` now go into the verifier's prompt, and MemPalace's moved there from `execute:wave:post`, where no verifier runs. (#5984)
