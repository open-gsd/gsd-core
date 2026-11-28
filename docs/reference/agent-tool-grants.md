# Agent tool grants

> Reference. `agent_tools` configuration, validation and per-runtime output. Setup context is in
> [Configuration](../CONFIGURATION.md#agent-tool-grants).

`agent_tools` is an opt-in, install-time addition to the tools already declared by shipped
agents. Put defaults shared by your projects in `$GSD_HOME/.gsd/defaults.json` (`~/.gsd/defaults.json` when `GSD_HOME` is unset) and project-specific
choices in the nearest `.planning/config.json`:

```json
{
  "agent_tools": {
    "*": ["mcp__docs__search"],
    "gsd-executor": ["WebFetch"]
  }
}
```

Selectors are agent names; `"*"` applies to every agent. For an agent, GSD appends wildcard
grants before its named grants, after the agent's existing tools, in first-seen order. Re-running
the same install is idempotent: it does not add another copy of an existing grant.

Project configuration replaces only selectors it names. For example, this project setting keeps
the global wildcard but replaces the global `gsd-executor` list:

```json
{
  "agent_tools": {
    "gsd-executor": ["WebSearch"]
  }
}
```

Each selector value must be an array. A usable entry is a single tool token which, after trimming,
is non-empty and contains no whitespace, comma, `#`, quote, U+0000–U+001F, U+007F–U+009F,
U+2028, or U+2029, and does not end with `:`.
Invalid entries are ignored. An explicitly present but invalid project selector resolves to no
grant for that selector; it does not restore the global value. A present but invalid project
`agent_tools` container suppresses all global grants. Inline grants remain plain comma-separated
tool names as required by Claude; block-sequence entries are YAML-quoted. Agents without a
`tools:` key inherit the runtime's default tool surface, so GSD leaves those agents unchanged.

A `--global` install still discovers the nearest `.planning/config.json` from the current working
directory, so `gsd install <runtime> --global` run from inside a project applies that project's
`agent_tools` selectors to the global install too — not just to that project's own local install.

Run `gsd install <runtime>` again after changing `agent_tools`; installed artifacts do not read
configuration at agent-spawn time. The shared staging path gives Claude, Codex, and Qwen their
existing host representations. Kimi maps supported canonical tools and continues to omit MCP
grants with its existing diagnostic. ZCode continues to omit `mcp__*` entries because its
dispatcher treats them as required MCP servers, and OpenCode keeps its converter-owned tools
omission. These are converter-specific output rules, not a claim that every runtime authorizes a
tool identically. Codex custom agents inherit the parent session's MCP servers natively;
`agent_tools` does not encode an allowlist into their TOML or widen `sandbox_mode`, which remains
derived from the shipped agent declaration.
