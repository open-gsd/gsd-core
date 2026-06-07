---
type: Added
pr: 830
---
**CodeBuddy (Tencent) installs now emit `/gsd-*` slash commands.** A `--codebuddy` install writes `commands/gsd-<name>.md` files to `~/.codebuddy/commands/` so GSD workflows are invokable from CodeBuddy's `/` menu (`/gsd-phase`, `/gsd-ship`, etc.), matching the integration depth of other fully-elevated runtimes (#789). The existing `skills/gsd-<name>/SKILL.md` files are now emitted with `user-invocable: false` so they stay out of the `/` menu — the commands surface is the single `/` entry point (no duplicate entries) and skills remain available for model invocation. Subagents (`~/.codebuddy/agents/`) were already emitted and are unchanged. Uninstall removes the `gsd-*` command files while preserving user-owned commands. No `mcp.json` is written — gsd ships no MCP server and CodeBuddy's `mcp.json` only registers external MCP servers.

<!-- docs-exempt-not-used: user-facing install behaviour is documented in docs/USER-GUIDE.md and docs/how-to/install-on-your-runtime.md -->
