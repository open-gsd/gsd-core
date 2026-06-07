---
type: Added
pr: 801
---
**Augment (Auggie) installs now emit slash command definitions alongside skills.** A global `--augment` install writes `commands/gsd-<name>.md` files to `~/.augment/commands/` in addition to the existing `skills/gsd-<name>/SKILL.md` files, matching the integration depth of other fully-elevated runtimes and allowing Auggie users to invoke GSD as slash commands (`/gsd-phase`, `/gsd-ship`, etc.) without manual configuration (#790). Content rewrites (path normalisation and Augment-specific branding) are applied at install time. Uninstall removes the `gsd-*` command files while preserving user-owned commands. `mcpServers` registration is explicitly excluded — gsd ships no MCP server and does not register third-party servers.

<!-- docs-exempt: internal installer enhancement; the user-facing behaviour (slash command availability in Augment) is described in README.md which already covers the supported runtime list -->
