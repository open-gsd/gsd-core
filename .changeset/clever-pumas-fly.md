---
type: Changed
pr: 0
---
**Command arguments now arrive in a labeled `<arguments>` block** — every argument-taking command and skill template opens with `<arguments>$ARGUMENTS</arguments>` (always present, empty when nothing was typed), so a flag such as `/gsd-update --reapply` can no longer be misread as template prose and silently run the default workflow. (#4780)
