---
type: Fixed
pr: 5348
---
**The install-time "N triggers shadowed" warning no longer appears on OpenCode, Kilo, Augment, CodeBuddy and ZCode installs (#5344)** — those runtimes install commands and skills side by side at one scope on purpose, and the report counted that pair as a shadow ("72 triggers shadowed … skills wins instead"). It now reports only a shadow between two different scopes, as documented.
