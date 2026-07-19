---
type: Fixed
pr: 0
---
**Installed third-party capability skills now materialize on OpenCode and Kilo** — `capability install` + `capability set --runtime opencode` (or `kilo`) could report a capability as `installed: true, surfaced: true, active: true` while its skill was never written to `skills/gsd-<stem>/SKILL.md`: the OpenCode/Kilo combined-family install path never called the seam #2322 fixed for other runtimes. Installed capability skills now materialize the same way there too, bound to their declaring capability, with first-party skills always winning a name collision. (#2362)
