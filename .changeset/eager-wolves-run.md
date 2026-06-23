---
type: Fixed
pr: 1418
---
**All GSD agents load on Gemini again** — the Claude `Skill`/`SlashCommand` tools were converted to an invalid `skill` tool that Gemini rejects, aborting the load of 22 of 34 agents. They are now excluded from the Gemini and Gemini-backed Antigravity agent `tools:` frontmatter, the same way `AskUserQuestion` already is. (#1394)
