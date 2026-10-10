---
type: Fixed
pr: 5190
---
**`gsd-plan-checker` no longer calls queries the runtime does not register.** It lists research and summary files with a glob, reads task structure from `verify.plan-structure`, and passes `--field` to `frontmatter.get`. (#5178)
