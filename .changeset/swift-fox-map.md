---
type: Added
pr: 6071
---
**`gsd-tools query project-context` prints the resolved project context** — one read-only verb now shows which checkout GSD acts in, which directory owns `.planning/`, the main checkout, and a provenance record (source, reason, degraded, warnings), so a wrong-checkout symptom in a worktree can be diagnosed instead of guessed. (#6043)
