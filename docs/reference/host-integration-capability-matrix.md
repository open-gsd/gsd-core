# Host Integration Capability Matrix

This document is the maintainer-facing source of truth for the `hostIntegration` block in every
`capabilities/<cli>/capability.json` runtime descriptor. Every per-CLI axis value is either:

- **documented** — backed by a cited authoritative source and evidence quote, or
- **`undocumented`** — the explicit fail-closed sentinel used when the CLI's public documentation
  does not state a value for that axis. `undocumented` validates in the registry but never
  propagates into effective axes: negotiation degrades closed to the safe default.

Values are generated from per-CLI documentation research (Context7 + official docs). They are
consumed verbatim by `gen:capability-registry` and validated by `capability-validator.cjs`.

---

## Axes legend

| Axis | Meaning |
|---|---|
| `embeddingMode` | Whether the CLI exposes an in-process programmatic API (`imperative`) or integrates purely through configuration files (`declarative`). |
| `commandSurface` | How slash commands are registered: `slash-file` (markdown), `slash-toml` (TOML), `slash-programmatic` (code API), `palette`, `prose-only`. |
| `modelMode` | Whether extensions can programmatically request or supply a model (`active`) or select only by config (`passive`). |
| `hookBus` | Who owns the hook lifecycle: `host` (the CLI fires hooks), `engine` (VS Code/Electron extension host), `none`. |
| `stateIO` | Filesystem access model: `filesystem` (full local FS), `sandboxed-storage`, `session-log-append`. |
| `transport` | Integration transport: `mcp` (Model Context Protocol), `native-extension`. |
| `runtime` | Plugin/extension execution runtime: `node`, `bun`, `python`, `go`, `rust`, `electron`, `sandboxed-web`, `other`. |

### dispatch sub-axes

| Sub-axis | Meaning |
|---|---|
| `namedDispatch` | Whether agents can be invoked by name (true/false/`undocumented`). |
| `nested` | Whether subagents can themselves spawn subagents (true/false/`undocumented`). |
| `maxDepth` | Maximum nesting depth (integer; -1 = unbounded; `undocumented`). |
| `background` | Whether subagents can run asynchronously in the background (true/false/`undocumented`). |
| `subagentToolkit` | Tool surface available to subagents: `full`, `read-only`, or `undocumented`. |
| `backgroundDispatch` | Whether a BACKGROUND-dispatched sub-agent can itself spawn further named sub-agents — the #853 discriminator (true/false/`undocumented`). |

### Interface points

| Point | Meaning |
|---|---|
| `command` | Slash-command routing and invocation capability. |
| `dispatch` | Subagent/multi-agent dispatch capability. |
| `model` | Programmatic model selection capability. |
| `hooks` | Lifecycle hook registration capability. |
| `state` | Filesystem/state I/O capability. |
| `artifact` | Artifact delivery (skills, commands) surface capability. |

---

## claude

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://code.claude.com/docs/en/agent-sdk/overview | "The Agent SDK offers hooks to execute custom code at critical points within the agent's lifecycle. These callback functions enable developer" |
| commandSurface | slash-file | https://code.claude.com/docs/en/agent-sdk/slash-commands | "Each custom command is a markdown file where the filename (without the `.md` extension) becomes the command name. The file content defines w" |
| modelMode | passive | https://code.claude.com/docs/en/agent-sdk/typescript | "setModel(model?: string): Changes the model (only available in streaming input mode) ... model overrides the default model for this subagent" |
| hookBus | host | https://code.claude.com/docs/en/agent-sdk/python | "HookEvent = Literal['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PreCompact', 'Notificati" |
| stateIO | filesystem | https://code.claude.com/docs/en/sandboxing | "The sandboxed Bash tool restricts file system access, granting read and write access to the current working directory and session temp direc" |
| transport | mcp | https://code.claude.com/docs/en/mcp | "Project-Scoped MCP Server Configuration in .mcp.json ... This JSON structure illustrates the format for a project-scoped MCP server configur" |
| runtime | node | https://code.claude.com/docs/en/agent-sdk/typescript | "import { query } from \"@anthropic-ai/claude-agent-sdk\"; ... pathToClaudeCodeExecutable (string) - Specifies the path to the Claude Code CLI" |
| dispatch.namedDispatch | true | https://code.claude.com/docs/en/agent-sdk/subagents | "agents: { 'code-reviewer': AgentDefinition({ description: 'Expert code reviewer.', ... }) } ... subagent_type: block.inp" |
| dispatch.nested | true | https://code.claude.com/docs/en/sub-agents | "As of Claude Code v2.1.172, a subagent can spawn its own subagents, allowing delegated tasks to split into parallel subt" |
| dispatch.maxDepth | 5 | https://code.claude.com/docs/en/sub-agents | "foreground subagents can spawn at any depth, blocking their parent until completion. Background subagents are limited to" |
| dispatch.background | true | https://code.claude.com/docs/en/sub-agents | "Subagents can run in the foreground, blocking the main conversation and passing permission prompts to you, or in the bac" |
| dispatch.subagentToolkit | full | https://code.claude.com/docs/en/sub-agents | "If all tools remain selected, the subagent inherits all tools available to the main conversation." |
| dispatch.backgroundDispatch | false | https://code.claude.com/docs/en/sub-agents | "Background subagents are limited to a depth of five and cannot spawn further, " |

Sources consulted:
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/agent-sdk/slash-commands
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/agent-sdk/python
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/sandboxing
- Context7 /websites/code_claude
- Context7 /llmstxt/code_claude_llms_txt

---

## codex

> **Note:** ADR-1239's host matrix lists Codex as `prose-only`; current OpenAI Codex dev docs document slash-commands, so `commandSurface` is `slash-file` here (docs are the source of truth).

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://developers.openai.com/codex/plugins/build | "No in-process programmatic API exists. Plugins integrate through: External command execution (hooks), MCP server processes, Configuration fi" |
| commandSurface | slash-file | https://github.com/openai/codex/blob/main/codex-rs/core-skills/src/loader.rs | "const SKILLS_FILENAME: &str = \"SKILL.md\"; ... Each skill is a folder with a SKILL.md file containing YAML frontmatter with name and descript" |
| modelMode | passive | https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs | "pub model_provider: Option<String> ... model is selected by config field; no programmatic model request API" |
| hookBus | host | https://github.com/openai/codex/blob/main/codex/codex-rs/hooks/src/lib.rs | "pub const HOOK_EVENT_NAMES: [&str; 10] = [\"PreToolUse\", \"PermissionRequest\", \"PostToolUse\", \"PreCompact\", \"PostCompact\", \"SessionStart\", \"Us" |
| stateIO | filesystem | https://developers.openai.com/codex/concepts/sandboxing | "workspace-write: The default mode allowing Codex to read files, edit within the workspace, and run routine local commands inside that bounda" |
| transport | mcp | https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs | "pub mcp_servers: HashMap<String, McpServerConfig> ... Definition for MCP servers that Codex can reach out to for tool calls." |
| runtime | node | https://github.com/openai/codex/blob/main/codex-cli/package.json | "\"engines\": {\"node\": \">=16\"} ... The npm-distributed CLI wrapper is a Node.js script (#!/usr/bin/env node)" |
| dispatch.namedDispatch | true | https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs | "\"agent_type\".to_string(), JsonSchema::string(Some(agent_type_description.to_string())) ... apply_role_to_config(&mut con" |
| dispatch.nested | true | https://developers.openai.com/codex/multi-agent | "agents.max_depth defaults to 1, which allows a direct child agent to spawn but prevents deeper nesting." |
| dispatch.maxDepth | 1 | https://developers.openai.com/codex/config-reference | "agents.max_depth: Maximum nesting depth allowed for spawned agent threads (root sessions start at depth 0; default: 1)" |
| dispatch.background | true | https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs | "spawn_agent returns the spawned agent id immediately; a separate wait_agent tool polls for final status." |
| dispatch.subagentToolkit | full | https://developers.openai.com/codex/multi-agent | "Subagents inherit the sandbox policy and tool surface from the parent session." |
| dispatch.backgroundDispatch | true | https://github.com/openai/codex/blob/main/codex-rs/core/templates/collab/experimental_prompt.md | "Sub-agents have access to the same set of tools as you do so you must tell them if they are allowed to spawn sub-agents themselves or not." The config (codex-rs/config/src/config_toml.rs) exposes an |

**GSD integration status — Phase D dogfood complete (#2088, ADR-1239).** Codex installs through the `declarative` embedding adapter (`createDeclarativeAdapter` → `installRuntimeArtifacts`); the hardcoded `runtime === 'codex'`/`isCodex` projection is folded into descriptor-driven `runtime.hostBehaviors`, and install/uninstall output is byte-parity-gated (`tests/fixtures/golden-install-parity/codex.json`). Three capability upgrades land, each with a test driving the user-reachable surface:

- **Skill root** — skills install to the canonical `$HOME/.agents/skills` (Codex core-skills `loader.rs` user-scope root), not the deprecated `$CODEX_HOME/skills` fallback. Declared via the skills-kind `home: ".agents"` override; pre-move installs are migrated (stale `~/.codex/skills/gsd-*` cleaned on both install and uninstall).
- **Hook events** — GSD registers all documented `hooks.json` lifecycle events beyond `SessionStart`: `SubagentStart`, `Stop`, `PostToolUse` (#772), plus the six added in #2088 — `PreToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStop`, `UserPromptSubmit` — all routed through `gsd-context-monitor.js`. (The descriptor `extendedHookEvents` field reflects the schema-valid cross-runtime subset `SubagentStop`/`Stop`/`PreCompact`; Codex's full event set is codex-hooks-json-native, registered directly in `hooks.json`.)
- **Dispatch tuning** — `[agents] max_depth = 1` is written explicitly into the managed `config.toml` block, pinning the `dispatch.maxDepth: 1` axis instead of relying on codex-cli's implicit default. Because `maxDepth === 1`, `degradationFor` flattens GSD-hosted wave dispatch to single-level even though `dispatch.nested`/`background`/`backgroundDispatch` are all `true`. The block is a bare `[agents]` AgentsToml scalar table (coexisting with the flattened `[agents.gsd-*]` role sub-tables); `validateCodexConfigSchema` permits a known-scalar-only `[agents]` while still rejecting `[[agents]]` and unknown-key forms.

Sources consulted:
- https://github.com/openai/codex (repo via gh CLI)
- /openai/codex (Context7 library ID)
- https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs
- https://github.com/openai/codex/blob/main/codex-rs/core-skills/src/loader.rs
- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/codex/plugins/build
- https://developers.openai.com/codex/multi-agent
- https://developers.openai.com/codex/cli/slash-commands

Documentation gaps:
- dispatch.maxDepth is configurable (Option<i32> with no documented upper bound); the documented default is 1 but the actual enforced maximum is not stated.
- dispatch.subagentToolkit: docs say subagents 'inherit the tool surface' but do not enumerate whether any tools are excluded.
- runtime: the Node.js entry point is a thin launcher shim; the actual agent execution runtime is a compiled Rust binary — axis classification is ambiguous.

---


## opencode

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://opencode.ai/docs/plugins | "Plugins are JavaScript/TypeScript modules that export plugin functions; they register hooks via `import type { Plugin } from '@opencode-ai/p'" |
| commandSurface | slash-file | https://opencode.ai/docs/commands | "\"Create markdown files in the `commands/` directory to define custom commands.\" and \"The markdown file name becomes the command name." |
| modelMode | active | /anomalyco/opencode (Context7) — packages/plugin/src/v2/promise/README.md | "`ctx.aisdk.sdk(async (event) => { ... event.sdk = mod.createXai(event.options) })` and `ctx.aisdk.language((event) => { ... event.language =" |
| hookBus | host | https://opencode.ai/docs/plugins | "Host fires events including: `tool.execute.before`, `tool.execute.after`, `session.created`, `session.compacted`, `session.deleted`" |
| stateIO | filesystem | https://opencode.ai/docs/plugins | "Plugin context includes `directory` (working directory path), `worktree` (git worktree path), and `$` (\"Bun's shell API\")" |
| transport | mcp | https://opencode.ai/docs/mcp-servers | "\"OpenCode supports both local and remote servers.\" and \"Once added, MCP tools are automatically available to the LLM\"" |
| runtime | bun | https://opencode.ai/docs/plugins | "\"$\": Bun's shell API for executing commands\" (plugin context property); \"OpenCode runs `bun install` at startup\"" |
| dispatch.namedDispatch | true | https://opencode.ai/docs/agents | "\"Subagents can be invoked: Automatically by primary agents for specialized tasks based on their descriptions. Manually b" |
| dispatch.nested | undocumented | no authoritative doc — searched: https://opencode.ai/docs/agents | — |
| dispatch.maxDepth | undocumented | no authoritative doc — searched: https://opencode.ai/docs/agents | — |
| dispatch.background | true | https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts (v1.15.0, commit 22de34c4d) + src/effect/runtime-flags.ts (v1.17, commit 81f6e0668) | "New in v1.15.0: experimental background subagents — the Task tool gains a `background` parameter (`Schema.optional(Schema.Boolean)`) that launches subagents asynchronously with completion notifications. v1.17: `BACKGROUND_SUBAGENTS_ENABLED = true` (\"feat: enable background subagents by default\") — default-on, concurrent execution in all modes. (#2087, superseding the stale sst/opencode#5887 snapshot)" |
| dispatch.subagentToolkit | full | https://opencode.ai/docs/agents | "The 'general' subagent \"Has full tool access (except todo), so it can make file changes when needed.\"" |
| dispatch.backgroundDispatch | true | https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/effect/runtime-flags.ts (v1.17, commit 81f6e0668) + src/server/routes/instance/httpapi/handlers/experimental.ts | "v1.17 `BACKGROUND_SUBAGENTS_ENABLED = true` enables background subagent execution by default in all modes; the experimental capabilities endpoint exposes `{ backgroundSubagents: true }`. Background-spawned subagents run concurrently without blocking the main interaction flow. (#2087)" |

Sources consulted:
- https://opencode.ai/docs/plugins
- https://opencode.ai/docs/agents
- https://opencode.ai/docs/commands
- https://opencode.ai/docs/mcp-servers
- /websites/opencode_ai_plugins (Context7)
- /anomalyco/opencode (Context7)
- https://github.com/sst/opencode/issues/5887

Documentation gaps:
- dispatch.nested
- dispatch.maxDepth

---

## cursor

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://cursor.com/docs/sdk/typescript | "local.customTools where you define tool functions that execute 'in your process, so it can reach anything your code can'; Agent.create()" |
| commandSurface | slash-file | https://cursor.com/docs/enterprise/llm-safety-and-controls | "Commands are reusable prompts invoked via slash commands (e.g., /test), while workflows enable multi-step processes" |
| modelMode | passive | https://cursor.com/docs/sdk/python | "The model used for a run can be overridden by passing a ModelSelection object in SendOptions to agent.send()." |
| hookBus | host | https://cursor.com/docs/hooks | "Agent hooks: sessionStart, sessionEnd, preToolUse, postToolUse, subagentStart, subagentStop, beforeShellExecution, afterShellExecution" |
| stateIO | filesystem | https://cursor.com/docs/reference/sandbox | "Local agents run with sandbox options disabled by default." |
| transport | mcp | https://cursor.com/docs/mcp | "The Model Context Protocol (MCP) allows Cursor to connect to external tools and data sources." |
| runtime | node | https://cursor.com/docs/sdk/typescript | "The SDK runs on Node.js. It requires Node.js 22.13 or later and is described as a Node-first package." |
| dispatch.namedDispatch | true | https://cursor.com/docs/subagents | "Invoke specific subagents using slash commands in your prompt. This allows for direct control over which agent performs" |
| dispatch.nested | true | https://cursor.com/docs/sdk/typescript | "The top-level agent and its direct subagents can launch subagents, but a subagent launched by another subagent can't lau" |
| dispatch.maxDepth | 2 | https://cursor.com/docs/sdk/typescript | "The top-level agent and its direct subagents can launch subagents, but a subagent launched by another subagent can't lau" |
| dispatch.background | true | https://cursor.com/docs/subagents | "Background, which returns immediately while the subagent works independently, best for long-running tasks or parallel wo" |
| dispatch.subagentToolkit | full | https://cursor.com/docs/subagents | "Subagents can utilize MCP tools, inheriting all tools available to their parent agent, including those from configured s" |
| dispatch.backgroundDispatch | true | https://cursor.com/docs/subagents (FAQ: Can subagents launch other subagents?) and https://cursor.com/docs/sdk/typescript (Subagents > Nested subagents) | FAQ: "As of Cursor 2.5, subagents have the capability to launch child subagents, enabling the creation of a hierarchical structure for coordinated tasks. This nested launching functionality requires T |

Sources consulted:
- https://cursor.com/docs/subagents
- https://cursor.com/docs/hooks
- https://cursor.com/docs/sdk/typescript
- https://cursor.com/docs/sdk/python
- https://cursor.com/docs/mcp
- https://cursor.com/docs/reference/sandbox
- https://cursor.com/docs/enterprise/llm-safety-and-controls
- /websites/cursor (Context7)

**GSD integration status — Phase D dogfood complete (#2089, ADR-1239).** Cursor installs through the `imperative` embedding adapter (`createImperativeAdapter` → `installRuntimeArtifacts`); the hardcoded `runtime === 'cursor'` / `isCursor` projection is folded into descriptor-driven `runtime.hostBehaviors`, and install/uninstall output is byte-parity-gated (`tests/fixtures/golden-install-parity/cursor.json`). Two capability upgrades land, each with a test driving the user-reachable surface:

- **Expanded hook-bus coverage** — GSD registers all 6 managed lifecycle events in `hooks.json` beyond the original `sessionStart`/`postToolUse`: `preToolUse`, `stop`, `subagentStart`, `subagentStop` (AC4a, cite https://cursor.com/docs/hooks). The hook-bus binding is descriptor-driven via `src/host-integration-adapters/imperative-hook-bus.cts` (reads `hostBehaviors.managedHookEvents`), not a hardcoded event pair.
- **Named/background nested subagent dispatch** — `dispatch.background`/`backgroundDispatch`/`nested` are all `true` with `maxDepth: 2`; `shouldFlattenDispatch(cursor)` returns `false` so GSD's wave-based execution drives Cursor's native background + depth-2 nested subagent dispatch instead of flattening to inline sequential calls (AC4b, cite https://cursor.com/docs/subagents + https://cursor.com/docs/sdk/typescript).

---

## cline

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/sdk/plugins.mdx | "Implement the AgentPlugin interface to register tools, hooks, and configuration. The setup function is used for registering capabilities." |
| commandSurface | slash-file | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/cline/apps/vscode/src/test/slash-commands.test.ts | "workflow markdown files (with .md, .markdown, or .txt extensions) are invoked as slash commands using their filename." |
| modelMode | active | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/sdk/packages/llms/README.md | "The Runtime API, accessible via createLlmsRuntime(...), allows for the creation of a registry that manages configured providers and their de" |
| hookBus | host | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/sdk/README.md | "Package agent capabilities as extensions (plugins) that can register tools, observe lifecycle events, and modify agent behavior." |
| stateIO | filesystem | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/cline/sdk/packages/shared/src/storage/paths.ts | "resolveClineDir() returns ~/.cline; resolveDocumentsExtensionPath('Workflows') returns ~/Documents/Cline/Workflows." |
| transport | mcp | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/mcp/mcp-overview.mdx | "MCP (Model Context Protocol) enables Cline to interact with external tools and data sources" |
| runtime | node | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/sdk/examples/plugins/typescript-lsp/README.md | "Installs a portable subagent plugin ... cp examples/plugins/agents-squad/index.ts ~/.cline/plugins/portable-subagents.ts." |
| dispatch.namedDispatch | true | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/sdk/examples/plugins/agents-squad/README.md | "parent → start_subagent(preset: \"phantom\", task: \"Map the auth module\") → phantom: save_handoff(...)" |
| dispatch.nested | false | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/features/subagents.mdx | "subagents are restricted from editing files, using the browser, accessing MCP servers, or creating nested subagents." |
| dispatch.maxDepth | 1 | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/features/subagents.mdx | "They are explicitly prohibited from ... spawning other subagents." |
| dispatch.background | true | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/features/subagents.mdx | "Commands executed by subagents run in the background and are strictly limited to read-only operations" |
| dispatch.subagentToolkit | read-only | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/features/subagents.mdx | "Subagents are equipped with tools for read-only operations, including reading file contents (read_file), listing directo" |
| dispatch.backgroundDispatch | false | https://docs.cline.bot/features/subagents (mirrored at https://github.com/cline/cline/blob/main/docs/features/subagents.mdx) | "They cannot edit files, use the browser, or spawn nested subagents" — and from the GitHub source: "subagents are restricted from editing files, using the browser, accessing MCP servers, or creating n |

Sources consulted:
- https://github.com/cline/cline/blob/main/docs/sdk/plugins.mdx
- https://github.com/cline/cline/blob/main/sdk/README.md
- https://github.com/cline/cline/blob/main/sdk/packages/agents/README.md
- https://github.com/cline/cline/blob/main/sdk/examples/plugins/agents-squad/README.md
- https://github.com/cline/cline/blob/main/docs/features/subagents.mdx
- https://github.com/cline/cline/blob/main/docs/mcp/mcp-overview.mdx
- https://github.com/cline/cline/blob/main/sdk/packages/llms/README.md
- /cline/cline (Context7)

**GSD integration status — Phase D dogfood complete (#2090, ADR-1239).** Cline installs through the `imperative` embedding adapter (`createImperativeAdapter` → `installRuntimeArtifacts`); the hardcoded `runtime === 'cline'` / `isCline` projection is folded into descriptor-driven `runtime.hostBehaviors`, and install/uninstall output is byte-parity-gated (`tests/fixtures/golden-install-parity/cline.json`). Two capability upgrades land, each with a test driving the user-reachable surface:

- **`AgentPlugin.hooks.beforeTool` planning guard** — the `.clinerules/hooks/PreToolUse` file-convention hook (#787) is re-implemented as a real Cline SDK `AgentPlugin` registered through the negotiated `hookBus: host` interface point. Guard semantics are preserved exactly (fail-open, cancels write-class calls targeting `.planning/`); the SDK maps the file hook's `{cancel, errorMessage}` to `{skip, reason}`. The binding lives in `src/host-integration-adapters/cline-sdk-binding.cts` (cite https://github.com/cline/cline/blob/main/docs/sdk/plugins.mdx).
- **`createAgentModel` per-subagent model overrides** — `DefaultGateway.createAgentModel({providerId, modelId})` is wired so GSD's `model_overrides` / `model_profile_overrides` resolution (already used for OpenCode/Codex passive hosts) applies to cline subagents (`modelMode: active`), instead of leaving model selection untouched (cite https://github.com/cline/cline/blob/main/docs/sdk/reference/gateway.mdx).
- **Dispatch stays degraded/flat (deliberate)** — unlike cursor's dispatch upgrade, cline's `dispatch` is `maxDepth: 1`, `nested: false`, `subagentToolkit: 'read-only'`, `backgroundDispatch: false`. `shouldFlattenDispatch(cline)` returns `true` and `degradationFor('dispatch', cline)` returns `{level:'degraded', fallback:'flat dispatch — waves run inline'}`. This is NOT upgraded: cline's own docs restrict subagents to a single level with a read-only toolkit and no nested spawning, so claiming full dispatch would misrepresent the host and violate the fail-closed negotiation contract (cite https://github.com/cline/cline/blob/main/docs/features/subagents.mdx).

---

## hermes

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin | "ctx.register_tool() puts your tool in the registry — the model sees it immediately" |
| commandSurface | slash-programmatic | https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin | "ctx.register_command('mystatus', handler=_handle_status, description='Show plugin status') — The command appears in autocomplete, /help output" |
| modelMode | active | https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin | "register_provider(ProviderProfile(name=..., aliases=(...), display_name=..., env_vars=(...), base_url=..., auth_type=..., default_aux_model=" |
| hookBus | host | https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks | "Hermes owns and manages the entire hook infrastructure. At runtime, HookRegistry.discover_and_load() scans ~/.hermes/hooks/" |
| stateIO | filesystem | https://hermes-agent.nousresearch.com/docs/user-guide/configuration | "The agent has the same filesystem access as your user account." |
| transport | mcp | https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp | "MCP support ships with the standard install — no extra step needed." |
| runtime | python | Context7 /nousresearch/hermes-agent | "The plugin and agent runtime is Python (confirmed by register(ctx) in __init__.py, importlib.import_module, run_agent.py, tools/registry.py)" |
| dispatch.namedDispatch | false | https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation | "The documentation contains no mention of named agents. Subagents are identified only by role ('leaf' or 'orchestrator')" |
| dispatch.nested | true | /nousresearch/hermes-agent (Context7) — configuration.md | "max_spawn_depth: 1 — Delegation tree depth cap (1-3, clamped). 1 = flat (default): parent spawns leaves that cannot dele" |
| dispatch.maxDepth | 1 | /nousresearch/hermes-agent (Context7) — configuration.md | "max_spawn_depth: 1 # Delegation tree depth cap (1-3, clamped). 1 = flat (default): parent spawns leaves that cannot dele" |
| dispatch.background | true | https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.19 | "delegate_task(background=true) dispatches a subagent that runs in the background and returns a handle immediately" |
| dispatch.subagentToolkit | read-only | https://hermes-agent.nousresearch.com/docs/guides/delegation-patterns | "Nested delegation is opt-in; by default, leaf subagents cannot call delegate_task, clarify, memory, send_message, or exe" |
| dispatch.backgroundDispatch | false | https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/delegation.md (via Context7 query of /nousresearch/hermes-agent) | "Nested delegation is an opt-in feature, requiring role=\"orchestrator\" for children and an increased max_spawn_depth from its default of 1. It can also be globally disabled with orchestrator_enabled |

Sources consulted:
- https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks
- https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin
- https://hermes-agent.nousresearch.com/docs/guides/delegation-patterns
- https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.19
- /nousresearch/hermes-agent (Context7)

**EoS migration status (#2091):** Migrated onto the imperative adapter. All `runtime === 'hermes'` branches in `bin/install.js` folded into descriptor-driven `runtime.hostBehaviors`. New `extensionEvents: "hermes"` dialect registered (13 real plugin hook events, replacing the borrowed `hookEvents: "claude"` 6-event surface). Cite: https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md

Documentation gaps:
- runtime — Hermes plugins and agent core run in Python, but this was confirmed by code inspection rather than explicit docs statement.
- dispatch.namedDispatch — docs explicitly confirm no named-agent dispatch in delegate_task; Kanban has named profiles but that is a separate board system not a dispatch mechanism.

---

## antigravity

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://github.com/alphaperseii3000/google-antigravity-docs/blob/master/google-antigravity-docs.md | "Skills require a SKILL.md file; Workflows are saved as markdown files; Rules are manually defined constraints — all configuration-file-based" |
| commandSurface | slash-file | https://github.com/alphaperseii3000/google-antigravity-docs/blob/master/google-antigravity-docs.md | "Workflows are saved as markdown files, providing a repeatable method for executing key processes. They can be invoked in the Agent using a s" |
| modelMode | passive | https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7 | "Selection occurs via `-m` flag or `/model` command inside the TUI. No programmatic model request API is documented for extensions/skills" |
| hookBus | host | https://www.aibuilderclub.com/blog/antigravity-cli-guide | "The CLI fires hooks, not the engine. These are JSON lifecycle interceptors (before tool call, after file edit, on session start)." |
| stateIO | filesystem | https://www.explainx.ai/blog/antigravity-cli-features-sandbox-plugins-subagents-2026 | "Plugin staging at ~/.gemini/antigravity-cli/plugins/<name>/; skills at ~/.gemini/antigravity-cli/skills/" |
| transport | mcp | https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7 | "Both local (stdio) and remote (HTTP) Model Context Protocol servers are supported" |
| runtime | go | https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ | "Built in Go, Antigravity CLI is snappier and more responsive." |
| dispatch.namedDispatch | undocumented | no authoritative doc — searched: https://www.aibuilderclub.com/blog/antigravity-cli-guide, https://antigravity.google/docs/agents | — |
| dispatch.nested | undocumented | no authoritative doc — searched: https://antigravity.google/docs/agents | — |
| dispatch.maxDepth | undocumented | no authoritative doc — searched: https://antigravity.google/docs/agents | — |
| dispatch.background | true | https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ | "Antigravity CLI orchestrates multiple agents for complex tasks in the background" |
| dispatch.subagentToolkit | undocumented | no authoritative doc — searched: https://www.explainx.ai/blog/antigravity-cli-features-sandbox-plugins-subagents-2026 | — |
| dispatch.backgroundDispatch | undocumented | no authoritative doc — Multiple sources consulted: antigravity.google/docs/cli-subagents (returned blank/JS-rendered), antigravity.google/docs/agent (blank), github.com/google-antigravity/antigravity-cli README, Context7 /google-antigravity/antigravity-cli | All documentation consulted describes a two-level orchestrator→subagent architecture. Background subagents run asynchronously while the main agent continues accepting prompts. The DataCamp tutorial st |

Sources consulted:
- https://github.com/alphaperseii3000/google-antigravity-docs/blob/master/google-antigravity-docs.md
- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7
- https://www.explainx.ai/blog/antigravity-cli-features-sandbox-plugins-subagents-2026
- https://www.aibuilderclub.com/blog/antigravity-cli-guide
- https://antigravity.google/docs/agents
- https://antigravity.google/docs/hooks

Documentation gaps:
- dispatch.namedDispatch — docs describe dynamic plain-English goal dispatch where agent names subagents at runtime; no pre-registered named sub-agent API documented.
- dispatch.nested — no documentation found on whether subagents can themselves spawn further subagents.
- dispatch.maxDepth — no documented depth limit or explicit unbounded statement found.
- dispatch.subagentToolkit — docs describe a permissions approval model but do not explicitly state 'full' vs 'read-only' toolkit scope for subagents.

---

## augment

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://docs.augmentcode.com/cli/plugins | "Plugins can provide several types of components, including Custom Commands defined in Markdown files within the `commands/` directory... Hoo" |
| commandSurface | slash-file | https://docs.augmentcode.com/cli/plugins | "Slash commands are Markdown files in the `commands/` directory. The filename becomes the command name" |
| modelMode | passive | https://docs.augmentcode.com/cli/subagents | "| model | No | Model to use for the agent. If not specified, the CLI default model is used." |
| hookBus | host | https://docs.augmentcode.com/cli/hooks | "Hook event types: PreToolUse (before a tool executes), PostToolUse (immediately after a tool completes), Stop (when the agent stops respondi" |
| stateIO | filesystem | https://github.com/augmentcode/auggie | "Node.js 22+ required. Hook configurations use `${AUGMENT_PLUGIN_ROOT}`" |
| transport | mcp | https://docs.augmentcode.com/cli/plugins | "Auggie supports a plugin system that allows you to extend its functionality with... MCP server integrations." |
| runtime | node | https://github.com/augmentcode/auggie | "Node.js 22+ required" |
| dispatch.namedDispatch | true | https://docs.augmentcode.com/cli/subagents | "| **name** | Yes | Name of the agent | ... you can trigger it by sending a message that references the agent name." |
| dispatch.nested | undocumented | no authoritative doc — searched: https://docs.augmentcode.com/cli/subagents | — |
| dispatch.maxDepth | undocumented | no authoritative doc — searched: https://docs.augmentcode.com/cli/subagents | — |
| dispatch.background | true | https://docs.augmentcode.com/cli/subagents | "Subagents run in parallel with other subagents... will show a summary of their current progress in the main thread." |
| dispatch.subagentToolkit | full | https://docs.augmentcode.com/cli/subagents | "If neither [tools nor disabled_tools] is specified, the subagent has access to all tools (default behavior)." |
| dispatch.backgroundDispatch | undocumented | no authoritative doc — https://docs.augmentcode.com/cosmos/automations | The Augment Code (Cosmos) docs describe workers as 'sub-agents launched mid-session by a manager Expert using the worker-launch command. Each worker is its own session with its own messages and permis |

Sources consulted:
- https://docs.augmentcode.com/cli/plugins
- https://docs.augmentcode.com/cli/hooks
- https://docs.augmentcode.com/cli/subagents
- https://docs.augmentcode.com/cli/sdk-typescript
- https://docs.augmentcode.com/setup-augment/mcp
- https://github.com/augmentcode/auggie
- /llmstxt/augmentcode_llms-full_txt (Context7)

Documentation gaps:
- dispatch.nested
- dispatch.maxDepth

---

## qwen

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://qwenlm.github.io/qwen-code-docs/en/developers/channel-plugins | "Your entry point exports a ChannelPlugin object... this.registerCommand('mycommand', async (envelope, args) => { ... }); ... plugins load at startup as extensions." |
| commandSurface | slash-file | https://qwenlm.github.io/qwen-code-docs/en/users/extension/introduction | "Extensions can provide custom commands by placing Markdown files in a commands/ subdirectory" |
| modelMode | passive | https://qwenlm.github.io/qwen-code-docs/en/developers/channel-plugins | "The documentation does not expose a direct API for plugins to invoke the LLM or model directly." |
| hookBus | host | https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks | "Qwen Code provides 14 distinct hook events: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop" |
| stateIO | filesystem | https://qwenlm.github.io/qwen-code-docs/en/developers/channel-plugins | "Runtime Environment: Node.js only. The architecture uses standard Node.js APIs: import, async/await, file I/O (writeFileSync), OS utilities" |
| transport | mcp | https://qwenlm.github.io/qwen-code-docs/en/developers/tools/mcp-server | "Qwen Code integrates with MCP servers through a sophisticated discovery and execution system" |
| runtime | node | https://qwenlm.github.io/qwen-code-docs/en/developers/channel-plugins | "Language: Node.js (TypeScript/JavaScript). Execution model: In-process — plugins load at startup as extensions." |
| dispatch.namedDispatch | true | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ | "Named subagents are invoked when the AI identifies tasks matching their specialization... Users can also explicitly requ" |
| dispatch.nested | false | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ | "Fork children cannot create further forks. This is enforced at runtime — if a fork attempts to spawn another fork, it re" |
| dispatch.maxDepth | 1 | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ | "Fork children cannot create further forks. This is enforced at runtime" |
| dispatch.background | true | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ | "Runs in background, parent continues immediately... Forks run parallel to the parent; the main conversation continues im" |
| dispatch.subagentToolkit | full | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ | "When omitted, the subagent inherits all available tools from the parent session." |
| dispatch.backgroundDispatch | false | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ (official Qwen Code documentation, 'Subagents' user guide page) and https://qwenlm.github.io/qwen-code-docs/en/design/fork-subagent/fork-subagent-design (Qwen Code fork-subagent design document, section '4. Recursive Fork Prevention') | The official user-facing Qwen Code docs state verbatim: "Fork children cannot create further forks. If a fork attempts spawning another fork, it receives an error instructing direct task execution ins |

Sources consulted:
- https://qwenlm.github.io/qwen-code-docs/en/developers/channel-plugins
- https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/
- https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks
- https://qwenlm.github.io/qwen-code-docs/en/users/extension/introduction
- https://qwenlm.github.io/qwen-code-docs/en/developers/tools/mcp-server
- /websites/qwenlm_github_io_qwen-code-docs_en (Context7)
- /qwenlm/qwen-code (Context7)

Documentation gaps:
- dispatch.nested — docs only restrict fork-type sub-agents from nesting; whether named sub-agents can themselves spawn named sub-agents is not stated.
- dispatch.maxDepth — depth=1 is documented only for fork sub-agents; depth for named sub-agent chains is undocumented.

**EoS migration status (#2092):** Migrated onto the imperative adapter. All `runtime === 'qwen'` branches in `bin/install.js`, `src/install-engine.cts`, `src/runtime-artifact-conversion.cts`, and `src/runtime-hooks-surface.cts` folded into descriptor-driven `runtime.hostBehaviors`. Two upgrades land: (1) **native subagent projection** — a new `agents` artifact-layout kind projects GSD's specialist agents into `~/.qwen/agents/gsd-*.md` as native Qwen subagents via `convertClaudeAgentToQwenAgent`, emitting Qwen's own `name:`/`description:`/`tools:` (YAML block list) frontmatter schema instead of Claude Code's; cite https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/. (2) **`SubagentStart` hook** — wired into `extendedHookEvents` alongside the existing `SubagentStop`/`Stop`/`PreCompact` events, firing the context-monitor hook symmetrically at subagent start and completion; cite https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks.

---

## codebuddy

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://www.codebuddy.ai/docs/cli/plugins-reference | "Commands are 'plain Markdown file[s]' located in commands/ by default ... a skill is a directory containing a SKILL.md ... The documentation" |
| commandSurface | slash-file | https://www.codebuddy.ai/docs/cli/plugins-reference | "Commands are 'plain Markdown file[s]' located in commands/ by default ... Skills are prefixed with this (e.g., /my-first-plugin:hello)" |
| modelMode | passive | https://www.codebuddy.ai/docs/cli/sdk | "The SDK is not for building plugins that run inside CodeBuddy. It's an external SDK for standalone applications" |
| hookBus | host | https://www.codebuddy.ai/docs/cli/hooks | "Full support for the hook event family (27+ events), covering tool lifecycle (PreToolUse / PostToolUse / PostToolUseFailure)" |
| stateIO | filesystem | https://www.codebuddy.ai/docs/cli/settings | "Storage operates in non-sandboxed mode by default ... Default: Full filesystem access governed by permission rules" |
| transport | mcp | https://www.codebuddy.ai/docs/cli/cli-reference | "MCP (Model Context Protocol) is built-in as a core feature ... codebuddy mcp command to 'Configure Model Context Protocol (MCP) servers'" |
| runtime | node | https://www.codebuddy.ai/docs/cli/sdk | "TypeScript/JavaScript: Node.js >= 18.20 ... npm install @tencent-ai/agent-sdk" |
| dispatch.namedDispatch | true | https://www.codebuddy.ai/docs/cli/sub-agents | "Sub-agents can be invoked explicitly by name: 'Request a specific sub-agent by mentioning it in your command'" |
| dispatch.nested | false | https://www.codebuddy.ai/docs/cli/sub-agents | "This prevents infinite nesting of agents (sub-agents cannot spawn other sub-agents)" |
| dispatch.maxDepth | 1 | https://www.codebuddy.ai/docs/cli/sub-agents | "The architecture enforces exactly one level of nesting — only the main CodeBuddy Code instance can invoke sub-agents." |
| dispatch.background | true | https://www.codebuddy.ai/docs/cli/sub-agents | "Launch a background agent using the run_in_background: true parameter ... Tasks return immediately with an ID" |
| dispatch.subagentToolkit | full | https://www.codebuddy.ai/docs/cli/sub-agents | "By default, sub-agents inherit all tools when the tools field is omitted ... Sub-agents can access MCP tools from config" |
| dispatch.backgroundDispatch | false | https://www.codebuddy.ai/docs/cli/sub-agents | "This prevents infinite nesting of agents (sub-agents cannot spawn other sub-agents)" — the restriction is stated as universal in the Sub-Agents documentation page. The daemon/background docs (https:/ |

Sources consulted:
- https://www.codebuddy.ai/docs/cli/plugins
- https://www.codebuddy.ai/docs/cli/plugins-reference
- https://www.codebuddy.ai/docs/cli/sub-agents
- https://www.codebuddy.ai/docs/cli/hooks
- https://www.codebuddy.ai/docs/cli/sdk
- https://www.codebuddy.ai/docs/cli/settings
- /websites/codebuddy_cn (Context7)

---

## copilot

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://docs.github.com/en/copilot/concepts/agents/copilot-cli/comparing-cli-features | "Declarative elements include custom instructions, skills, custom agents, and plugin configurations—all defined through configuration files" |
| commandSurface | slash-file | https://docs.github.com/en/copilot/concepts/agents/copilot-cli/comparing-cli-features | "Skills: Markdown files with instructions for specific contexts. Users can invoke via slash commands (e.g., /Markdown-Checker check README.md)" |
| modelMode | passive | https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md | "Model selection via config: model: 'gpt-4.1', provider: { type: 'openai', ... }." |
| hookBus | host | https://docs.github.com/en/copilot/reference/hooks-reference | "Hooks allow you to extend and customize the behavior of GitHub Copilot agents by executing custom shell commands at key points during agent" |
| stateIO | filesystem | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers | "Configuration file Location: ~/.copilot/mcp-config.json. Hook config files stored in .github/hooks/*.json" |
| transport | mcp | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers | "Copilot CLI comes with the GitHub MCP server already configured. STDIO is the standard transport." |
| runtime | undocumented | no authoritative doc — searched: https://github.com/github/copilot-cli/blob/main/README.md, https://github.com/github/copilot-sdk/blob/main/nodejs/README.md | — |
| dispatch.namedDispatch | true | https://github.com/github/copilot-sdk/blob/main/docs/features/custom-agents.md | "A custom agent is a named agent configuration that includes its own prompt and tool set. A sub-agent is a custom agent i" |
| dispatch.nested | false | https://awesome-copilot.github.com/learning-hub/agents-and-subagents/ | "By default, subagents do not keep spawning additional subagents." |
| dispatch.maxDepth | 1 | https://awesome-copilot.github.com/learning-hub/agents-and-subagents/ | "Depth counts how many agents are nested within one another. When the depth limit is reached, the innermost agent cannot" |
| dispatch.background | true | https://docs.github.com/en/copilot/how-tos/copilot-cli/speed-up-task-completion | "Allow Copilot to use subagents and work autonomously to implement the plan without any further input." |
| dispatch.subagentToolkit | full | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli | "By default, custom agents have access to all tools. If you restrict an agent's access, a tools specification is added" |
| dispatch.backgroundDispatch | false | https://code.visualstudio.com/docs/copilot/agents/subagents | "By default, subagents cannot spawn further subagents. This prevents infinite recursion when agents accidentally call themselves in a loop." The setting `chat.subagents.allowInvocationsFromSubagents` |

Sources consulted:
- https://github.com/github/copilot-cli/blob/main/README.md (via Context7 /github/copilot-cli)
- https://github.com/github/copilot-sdk/blob/main/docs/features/custom-agents.md (via Context7 /github/copilot-sdk)
- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
- https://docs.github.com/en/copilot/reference/hooks-reference
- https://docs.github.com/en/copilot/concepts/agents/copilot-cli/comparing-cli-features
- https://awesome-copilot.github.com/learning-hub/agents-and-subagents/

Documentation gaps:
- runtime — docs describe the CLI binary and the SDK (Node.js/Go/Python/Rust) but do not state what runtime the CLI host itself or its plugin/extension loader executes in.
- dispatch.nested exact authoritative source is awesome-copilot.github.com (community docs) not docs.github.com.

---

## kilo

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://kilo.ai/docs/automate/extending/plugins | "Plugins extend Kilo by hooking into events and adding functionality. They can: add custom tools the model can call (like read, write, bash)" |
| commandSurface | slash-file | https://kilo.ai/docs/customize/workflows | "Workflows, also known as slash commands, allow users to automate repetitive tasks by defining step-by-step instructions" |
| modelMode | active | https://kilo.ai/docs/automate/extending/plugins | "provider — dynamically supply model catalogs. auth — register OAuth or API-key flows for model providers. chat.params — Mutate temperature" |
| hookBus | host | https://kilo.ai/docs/automate/extending/plugins | "event — fires for every internal bus event. Session: session.created, session.updated, session.idle, session.error, session.deleted" |
| stateIO | filesystem | https://kilo.ai/docs/contributing/architecture | "Local execution and hosted execution are separate boundaries. Local runtime instances are Directory-keyed runtime context" |
| transport | mcp | https://kilo.ai/docs/automate/mcp/what-is-mcp | "Kilo Code implements the Model Context Protocol to connect to both local and remote MCP servers" |
| runtime | bun | https://kilo.ai/docs/automate/extending/plugins | "npm plugins are installed automatically at startup using Bun. Plugin context includes $ (Bun shell). Plugins are TypeScript or JavaScript mo" |
| dispatch.namedDispatch | true | https://kilo.ai/docs/customize/custom-subagents | "Configured subagents can be invoked automatically by primary agents (like the Orchestrator) using the Task tool" |
| dispatch.nested | true | https://github.com/Kilo-Org/kilocode/issues/7055 | "A subagent can still call the task tool if its merged permissions contain an explicit task rule, which enables nested su" |
| dispatch.maxDepth | -1 | https://github.com/Kilo-Org/kilocode/issues/8637 | "there is no maximum nesting depth and the system relies entirely on permission gating" |
| dispatch.background | true | https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode | "Agents are also capable of launching multiple subagent sessions concurrently to facilitate parallel processing." |
| dispatch.subagentToolkit | undocumented | no authoritative doc — searched: https://kilo.ai/docs/customize/custom-subagents | — |
| dispatch.backgroundDispatch | false | https://kilo.ai/docs/automate/tools/new-task | "Importantly, subagents cannot spawn further subagents; only primary agents can use the `new_task` tool." |

Sources consulted:
- https://kilo.ai/docs/automate/extending/plugins
- https://kilo.ai/docs/customize/custom-subagents
- https://kilo.ai/docs/customize/workflows
- https://kilo.ai/docs/automate/mcp/what-is-mcp
- https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode
- https://kilo.ai/docs/contributing/architecture
- https://github.com/Kilo-Org/kilocode/issues/7055
- https://github.com/Kilo-Org/kilocode/issues/8637
- /websites/kilo_ai (Context7)

Documentation gaps:
- dispatch.subagentToolkit — docs describe per-subagent configurable permissions (allow/ask/deny) but do not document a single default toolkit level (full vs read-only) for subagents that lack explicit permission overrides.

---

## windsurf

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://docs.devin.ai/desktop/cascade/cascade | "Cascade operates through configuration files rather than code plugins: .codeiumignore for file filtering, Memories and Rules for customizing" |
| commandSurface | slash-file | https://docs.devin.ai/desktop/cascade/workflows | "Workflows are authored as markdown files (.md extension) … triggered through slash commands using the format /[workflow-name]." |
| modelMode | passive | https://docs.devin.ai/desktop/models.md | "Models are selectable via configuration/UI only (SWE-1.5, SWE-1.6, Adaptive, Arena tiers, Claude, GPT)." |
| hookBus | host | https://docs.devin.ai/desktop/cascade/hooks.md | "Cascade supports twelve hook events covering critical workflow points … Pre-hooks (can block actions): pre_read_code, pre_write_code, pre_ru" |
| stateIO | filesystem | https://docs.devin.ai/desktop/cascade/cascade | "Cascade can create and modify codebases directly … File access can be restricted through .codeiumignore files" |
| transport | mcp | https://docs.devin.ai/desktop/cascade/mcp | "Cascade now natively integrates with MCP, allowing you to bring your own selection of MCP servers for Cascade to use." |
| runtime | undocumented | no authoritative doc — searched: https://docs.devin.ai/windsurf/plugins/getting-started.md, /llmstxt/windsurf_llms-full_txt (Context7) | — |
| dispatch.namedDispatch | undocumented | no authoritative doc — searched: https://docs.devin.ai/cli/subagents.md, https://docs.devin.ai/desktop/agent-command-center.md | — |
| dispatch.nested | undocumented | no authoritative doc — searched: https://docs.devin.ai/cli/subagents.md | — |
| dispatch.maxDepth | undocumented | no authoritative doc — searched: https://docs.devin.ai/cli/subagents.md | — |
| dispatch.background | undocumented | no authoritative doc — searched: https://docs.devin.ai/desktop/acp.md, https://docs.devin.ai/cli/subagents.md | — |
| dispatch.subagentToolkit | undocumented | no authoritative doc — searched: https://docs.devin.ai/cli/subagents.md | — |
| dispatch.backgroundDispatch | undocumented | no authoritative doc — https://docs.devin.ai/desktop/cascade/cascade and https://docs.devin.ai/desktop/devin-local (official Windsurf/Devin docs, via docs.windsurf.com redirects) | The Windsurf/Cascade docs describe a background planning agent only in these terms: "In the background, a specialized planning agent continuously refines the long-term plan while your selected model f |

Sources consulted:
- https://docs.devin.ai/desktop/cascade/workflows
- https://docs.devin.ai/desktop/cascade/mcp
- https://docs.devin.ai/desktop/cascade/hooks.md
- https://docs.devin.ai/desktop/cascade/cascade
- https://docs.devin.ai/desktop/models.md
- https://docs.devin.ai/windsurf/plugins/getting-started.md
- https://docs.devin.ai/cli/subagents.md
- /llmstxt/windsurf_llms-full_txt (Context7)

Documentation gaps:
- dispatch.namedDispatch — Cascade docs do not document a user-facing named sub-agent dispatch system.
- dispatch.nested — no documentation for nested sub-agent support in Windsurf Cascade.
- dispatch.maxDepth — no documented depth limit for Cascade sub-agents.
- dispatch.background — Cascade has an internal background planning agent but no documented user-facing background sub-agent dispatch.
- dispatch.subagentToolkit — no documentation for toolkit restrictions on Cascade sub-agents.
- runtime — Windsurf IDE is Electron-based but no programmatic plugin runtime is documented to developers.

---

## trae

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://traeide.com/docs/how-to-manage-extensions-in-trae-ide | "Trae IDE is a VSCode fork; 'If an extension isn't available in Trae's store, you can install it from VS Code's marketplace' — inherits VSCode in-process extension model" |
| commandSurface | slash-file | https://docs.trae.ai/ide/skills | "Skills stored as SKILL.md files in '.trae/skills/{skill_name}/' directory; 'Trae allows you to manually trigger skills if needed'" |
| modelMode | passive | https://docs.trae.ai/ide/models | "Model selection via UI: 'click on the current model name to open the model list'; no programmatic model/LLM request API documented for plugins" |
| hookBus | engine | https://news.ycombinator.com/item?id=44703164 | "Trae is 'ByteDance's VSCode fork' built on Electron/Monaco; inherits VSCode extension host lifecycle (activate/deactivate hooks, event subsc" |
| stateIO | filesystem | https://traeide.com/news/6 | "Rules at '.trae/project_rules.md', skills at '.trae/skills/', MCP config at '.trae/mcp.json'; 'codebase files always remain on your local de" |
| transport | mcp | https://docs.trae.ai/ide/model-context-protocol | "Page title from official docs: 'In TRAE IDE, MCP servers support three transport types' — MCP is built-in" |
| runtime | node | https://news.ycombinator.com/item?id=44703164 | "Trae is a VSCode fork built on Electron; 'Electron is designed to create desktop applications… a backend using the Node.js runtime'" |
| dispatch.namedDispatch | true | https://docs.trae.ai/ide/agent | "Agents in Trae 'can be called individually, or automatically called by SOLO Agent at the corresponding stage'" |
| dispatch.nested | undocumented | no authoritative doc — searched: https://docs.trae.ai/ide/solo-mode, https://docs.trae.ai/ide/agent | — |
| dispatch.maxDepth | undocumented | no authoritative doc — searched: https://docs.trae.ai/ide/solo-mode | — |
| dispatch.background | true | https://news.aibase.com/news/22829 | "SOLO 'supports multi-tasking, allowing you to work on multiple development tasks simultaneously'; 'run multiple agents i" |
| dispatch.subagentToolkit | undocumented | no authoritative doc — searched: https://docs.trae.ai/ide/agent | — |
| dispatch.backgroundDispatch | undocumented | no authoritative doc — https://docs.trae.ai/ide/agent; https://github.com/bytedance/trae-agent/blob/main/docs/roadmap.md | Trae's official documentation (docs.trae.ai) and the trae-agent GitHub roadmap do not document background/async agent dispatch or whether a background-spawned agent can itself spawn further sub-agents |

Sources consulted:
- https://docs.trae.ai/ide/model-context-protocol
- https://docs.trae.ai/ide/agent
- https://docs.trae.ai/ide/skills
- https://docs.trae.ai/ide/solo-mode
- https://docs.trae.ai/ide/solo-coder
- https://traeide.com/news/6
- https://traeide.com/docs/how-to-manage-extensions-in-trae-ide
- https://news.ycombinator.com/item?id=44703164
- https://news.aibase.com/news/22829

Documentation gaps:
- dispatch.nested — docs describe two-tier orchestration (SOLO → named agents) but do not state whether a spawned sub-agent can itself spawn further sub-agents.
- dispatch.maxDepth — no integer depth limit documented beyond one orchestrator level.
- dispatch.subagentToolkit — docs say agents can be configured with 'callable MCP services and other capabilities' but do not state whether sub-agents receive a full vs. restricted tool set.

---

## kimi

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://context7.com/moonshotai/kimi-cli/llms.txt | "from kimi_cli.app import KimiCLI, enable_logging ... instance = await KimiCLI.create(session, agent_file=myagent) ... class Ls(CallableTool2)" |
| commandSurface | slash-file | https://github.com/moonshotai/kimi-cli/blob/main/docs/en/customization/skills.md | "/skill:code-style ... /flow:code-review — Skills are SKILL.md markdown files with YAML frontmatter that become /skill:<name> and /flow:<name>" |
| modelMode | passive | https://github.com/moonshotai/kimi-cli/blob/main/docs/en/configuration/providers.md | "Use the `/model` command to switch between available models and thinking modes ... `--model` option overrides the default model" |
| hookBus | host | https://moonshotai.github.io/kimi-cli/en/customization/hooks.html | "Core: Add hooks system (Beta) — configure `[[hooks]]` in `config.toml` to run custom shell commands at 13 lifecycle events including `PreToo" |
| stateIO | filesystem | https://github.com/MoonshotAI/kimi-cli | "Kimi Code CLI is an AI agent that runs in the terminal ... capable of reading and editing code, executing shell commands, searching files" |
| transport | mcp | https://github.com/moonshotai/kimi-cli/blob/main/docs/en/reference/kimi-mcp.md | "kimi mcp add ... --transport stdio|http ... Manage MCP Servers: Use the kimi mcp sub-command group to add, list, remove, or authorize MCP se" |
| runtime | python | https://context7.com/moonshotai/kimi-cli/llms.txt | "from kimi_cli.app import KimiCLI ... from kosong.tooling import CallableTool2 — CLI core is Python" |
| dispatch.namedDispatch | true | https://moonshotai.github.io/kimi-cli/en/customization/agents.html | "subagents:\n  coder:\n    path: ./coder-sub.yaml\n    description: \"Handle coding tasks\"\n  reviewer:\n    path: ./reviewer-sub.yaml" |
| dispatch.nested | false | https://moonshotai.github.io/kimi-cli/en/customization/agents.html | "All subagent types are prohibited from nesting the `Agent` tool (subagents cannot create their own subagents). Only root" |
| dispatch.maxDepth | 1 | https://moonshotai.github.io/kimi-cli/en/customization/agents.html | "All subagent types are prohibited from nesting the `Agent` tool (subagents cannot create their own subagents). Only root" |
| dispatch.background | true | https://moonshotai.github.io/kimi-cli/en/customization/agents.html | "Subagents support foreground and background modes. The `run_in_background` parameter allows tasks to execute asynchronou" |
| dispatch.subagentToolkit | undocumented | no authoritative doc — searched: https://moonshotai.github.io/kimi-cli/en/customization/agents.html | — |
| dispatch.backgroundDispatch | false | https://github.com/moonshotai/kimi-cli/blob/main/docs/en/customization/agents.md (also mirrored at https://moonshotai.github.io/kimi-cli/en/customization/agents.html) | "All subagent types are prohibited from nesting the `Agent` tool, meaning subagents cannot create their own subagents. Only the root agent has access to the `Agent` tool for launching further subagent |

Sources consulted:
- https://moonshotai.github.io/kimi-cli/en/customization/hooks.html
- https://moonshotai.github.io/kimi-cli/en/customization/agents.html
- https://github.com/MoonshotAI/kimi-cli
- https://github.com/moonshotai/kimi-cli/blob/main/docs/en/customization/skills.md
- https://github.com/moonshotai/kimi-cli/blob/main/docs/en/customization/agents.md
- https://github.com/moonshotai/kimi-cli/blob/main/docs/en/reference/kimi-mcp.md
- https://context7.com/moonshotai/kimi-cli/llms.txt
- /moonshotai/kimi-cli (Context7)

Documentation gaps:
- dispatch.subagentToolkit — docs show three built-in subagent types each with different tool subsets (coder=full, explore=read-only, plan=no shell/write); no single 'full' or 'read-only' value covers all types; maintainer should clarify the intended classification.
- runtime — CLI core is Python; a Rust Wire implementation also exists; docs do not state a canonical plugin extension runtime.

---

## zcode

> ZCode (Z.ai) is a desktop Agentic Development Environment for the GLM-5.2 model, distributed as an Electron app. It exposes a Claude-Code-shaped extensibility surface (per-user `~/.zcode/skills/<name>/SKILL.md`, slash commands, named subagents, native MCP, and a plugin system). All values below are sourced verbatim from the official ZCode docs.

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://zcode.z.ai/en/docs/plugin | "A single plugin can bundle several capabilities. ZCode detects which components a plugin includes from its directory layout" — plugins/skills/commands/agents are config/markdown files; no in-process programmatic extension API is documented. |
| commandSurface | slash-file | https://zcode.z.ai/en/docs/commands | "Custom commands are stored as `.md` files under `~/.zcode/commands` ... invoke the command with `/command-name`" |
| modelMode | passive | https://zcode.z.ai/en/docs/configuration | Models are connected by provider config (Z.ai/BigModel/OpenAI-compat/Anthropic-compat base URLs + API keys in Model Settings); no programmatic model request API is documented. |
| hookBus | host | https://zcode.z.ai/en/docs/plugin | A plugin's bundled components include a "**Hook** — Automation hooks triggered on specific events" — the host fires the events a plugin subscribes to. |
| stateIO | filesystem | https://zcode.z.ai/en/docs/skill | "User-level skills for ZCode Agent: `~/.zcode/skills/<skill-name>/SKILL.md`" — full local filesystem (desktop app). |
| transport | mcp | https://zcode.z.ai/en/docs/mcp-services | "MCP (Model Context Protocol) connects external capabilities ... type as `stdio` (SSE and HTTP remote servers are also supported)" — native MCP. |
| runtime | electron | https://zcode.z.ai/en/docs/install (download path `cdn-zcode.z.ai/zcode/electron/releases/3.2.5/ZCode-3.2.5-mac-arm64.dmg`) | ZCode is shipped as an Electron desktop application; the release artifact lives under the `electron/releases` path. |
| dispatch.namedDispatch | true | https://zcode.z.ai/en/docs/subagents | "you can let the Agent pick the subagent automatically, or reference it with `@` in the chat box" — subagents are invoked by name via the Agent tool. |
| dispatch.nested | undocumented | searched: https://zcode.z.ai/en/docs/subagents | The docs do not state whether a subagent can itself spawn further subagents. |
| dispatch.maxDepth | undocumented | searched: https://zcode.z.ai/en/docs/subagents | No maximum nesting depth is documented. |
| dispatch.background | false | https://zcode.z.ai/en/docs/subagents | "**Foreground execution.** Subagents run in the foreground ... Background execution is not enabled yet." |
| dispatch.subagentToolkit | full | https://zcode.z.ai/en/docs/subagents | "**general-purpose** is the default built-in subagent ... It has access to all tools"; custom subagents default to "All permissions by default" (inherits every tool). |
| dispatch.backgroundDispatch | false | https://zcode.z.ai/en/docs/subagents | "Background execution is not enabled yet" — background dispatch is therefore impossible. |

Sources consulted:
- https://zcode.z.ai/en/docs/skill
- https://zcode.z.ai/en/docs/commands
- https://zcode.z.ai/en/docs/subagents
- https://zcode.z.ai/en/docs/mcp-services
- https://zcode.z.ai/en/docs/plugin
- https://zcode.z.ai/en/docs/configuration
- https://zcode.z.ai/en/docs/install

Documentation gaps:
- dispatch.nested / dispatch.maxDepth — ZCode's subagent docs do not state whether subagents can spawn further subagents or any depth bound.
- configHome — skills/commands/agents homes are documented (`~/.zcode/skills`, `~/.zcode/commands`, `~/.zcode/agents`); the exact settings filename under `~/.zcode` (where MCP server config is stored) is not fully documented at time of writing.
- Maintenance note — ZCode is a young, fast-moving app (observed at v3.2.x); these axes may need revision as its on-disk config layout stabilizes. Because ZCode also natively imports skills/MCP from `~/.claude`, installing GSD to BOTH `claude` and `zcode` can surface duplicated skills inside ZCode; this overlap is expected and documented.

