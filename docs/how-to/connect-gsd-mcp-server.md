# How to connect a host to the GSD companion MCP server

This guide shows you how to make a MCP-capable host (Claude Code, Codex,
OpenCode, VS Code, Antigravity CLI, Cursor, Cline, Hermes) drive GSD — run GSD
commands and read/write `.planning/` state — through the companion MCP server,
with no bespoke plugin.

Once connected, three tools appear in the host alongside its others:
`gsd_invoke_command`, `gsd_read_state`, `gsd_write_state`. (For the tool
contracts, see the reference section below; for *why* this server exists and
its trust model, see [ADR-1239](../adr/1239-gsd-embeddable-orchestration-engine.md)
and the [capability trust model](../explanation/capability-trust-model.md).)

## 1. Add the server to your host's MCP config

The entry shape is the same everywhere; only the config file and key differ by
host.

```jsonc
{
  "gsd": {
    "command": "npx",
    "args": ["-y", "@opengsd/gsd-core", "gsd-mcp-server"],
    "cwd": "/abs/path/to/your/project"
  }
}
```

- **Claude Code / Codex / OpenCode / Cursor / Cline / Hermes** — under the
  host's `mcpServers` object (project or user config).
- **VS Code** — in the workspace MCP servers list.
- **Antigravity CLI** — under its `mcpServers` block.

Set `cwd` to the project whose `.planning/` you want GSD to manage — the server
resolves state paths against it.

## 2. Restart the host

On startup the host performs the MCP `initialize` handshake, lists tools, and
the three GSD tools become callable.

## 3. Verify

Ask the host to read an existing planning file:

```jsonc
{ "name": "gsd_read_state", "arguments": { "path": "/abs/path/to/your/project/.planning/STATE.md" } }
```

It returns the file's contents. `gsd_invoke_command` takes
`{family, subcommand, args}` and returns the command-routing hub's structured
result (the same shape `gsd-tools` produces).

## If something does not work

- **`command not found: gsd-mcp-server`** — invoke via `npx` as shown above, or
  install the package globally first (`npm i -g @opengsd/gsd-core`).
- **`gsd_read_state` fails with ENOENT** — the path is resolved literally; pass
  an absolute path under the project's `.planning/`.
- **The host lists no GSD tools** — confirm the server starts in isolation:
  `npx @opengsd/gsd-core gsd-mcp-server` then send an `initialize` request on
  stdin; it writes a `protocolVersion` response and exits on EOF.
- **You manage multiple projects** — register one `gsd` entry per project with a
  distinct name and `cwd`; the server is stateless across projects.

## Reference — the three tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `gsd_invoke_command` | `{family: string, subcommand: string, args?: unknown[]}` | the command-routing hub result (`{ok, …}`) as JSON text |
| `gsd_read_state` | `{path: string}` | the file contents as text |
| `gsd_write_state` | `{path: string, content: string}` | `{ok: true, path}` as JSON text |

Errors from a tool are returned as MCP tool errors (`isError: true`), not as
JSON-RPC protocol errors — the host surfaces them in its normal tool-failure UX.
