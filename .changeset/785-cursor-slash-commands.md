---
type: Added
pr: 803
---
`gsd install --cursor` now writes `.cursor/commands/gsd-<name>.md` in addition to the existing `.cursor/skills/` surface. Cursor 1.6 introduced plain-markdown slash commands (no frontmatter) in `.cursor/commands/`; they appear in the `/` menu in the Agent input. Each command file is generated from the same source as the skill but with frontmatter stripped and Cursor-specific content transforms applied (`convertClaudeCommandToCursorCommand`). The skills surface is unchanged — both surfaces are written on every install.
