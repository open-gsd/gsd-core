# Runtime install contracts

The installer materializes a different surface per runtime. This page is the reference for it: the installed file layout, the per-runtime install contract matrix, and the upstream documentation each row was checked against. For why install-time translation is the design, see [Runtime Abstraction](../ARCHITECTURE.md#runtime-abstraction) in the architecture page; for the installer's own structure, see [Installer Architecture](../ARCHITECTURE.md#installer-architecture) and [Installer Migrations](../installer-migrations.md).

## Installed file layout

A global install on Claude Code lands here; the per-runtime roots are the `Global root` and `Local root` columns of the matrix below.

```
~/.claude/                          # Claude Code (global install)
├── skills/gsd-ns-*/SKILL.md        # Global skills — nesting runtimes: 6 namespace routers (authoritative roster: docs/INVENTORY.md)
│   └── skills/<name>/SKILL.md     #   concrete skills nested under each router
│   (flat runtimes: skills/gsd-*/SKILL.md — all 72 skills at top level)
├── commands/gsd/*.md               # Local Claude installs use slash commands instead of global skills
├── gsd-core/
│   ├── bin/gsd-tools.cjs           # CLI utility
│   ├── bin/lib/*.cjs               # Domain modules (authoritative roster: docs/INVENTORY.md)
│   ├── workflows/*.md              # Workflow definitions (authoritative roster: docs/INVENTORY.md)
│   ├── references/*.md             # Shared reference docs (authoritative roster: docs/INVENTORY.md)
│   └── templates/                  # Planning artifact templates
├── agents/*.md                     # Agent definitions (authoritative roster: docs/INVENTORY.md)
├── hooks/*.js                      # Node.js hooks (statusline, guards, monitors, update check)
├── hooks/*.sh                      # Shell hooks (session state, commit validation, phase boundary)
├── settings.json                   # Hook registrations
└── VERSION                         # Installed version number
```

The project's own state lives in `.planning/` — every file and its producer is in [Planning artifacts](planning-artifacts.md).

## Install contract matrix

This matrix describes the runtime surfaces the installer materializes today.
The migration-specific ownership and source snapshots live in
[Installer Migrations](../installer-migrations.md#runtime-configuration-contract-registry).

| Runtime | Global root | Local root | Invocation surface | Agent surface | Config and hooks |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude` | `./.claude` | Global `skills/gsd-*/SKILL.md` (flat, #924); local `commands/gsd/*.md` | `agents/gsd-*.md` | `settings.json` hook and statusLine entries |
| OpenCode (1.x and 2.x) | `~/.config/opencode` | `./.opencode` | `commands/gsd-*.md`; every command is also a model-loadable skill (`skills/gsd-*/SKILL.md`) | `agents/gsd-*.md`, with a `permission:` block denying the tools an agent's `tools:` allowlist leaves out | `opencode.json` or `opencode.jsonc` (edited as text, so a commented file keeps its comments); one native plugin, `plugins/gsd-core.js`, that serves both generations and runs the `hooks/` guards under Node — see [OpenCode 1.x and 2.x](../ARCHITECTURE.md#opencode-1x-and-2x) |
| Kilo | `~/.config/kilo` | `./.kilo` | `command/gsd-*.md` | `agents/gsd-*.md` | `kilo.json` or `kilo.jsonc`; no GSD hooks |
| Kimi CLI | First-existing generic root: `~/.config/agents` recommended, then `~/.agents` when `~/.agents/skills` exists and `~/.config/agents/skills` does not | Deferred and guarded | `skills/gsd-*/SKILL.md` (flat) invoked as `/skill:gsd-*` | `agents/gsd.yaml`, `agents/gsd.md`, and `agents/subagents/gsd-*` YAML/prompt pairs | Explicit `kimi --agent-file <configRoot>/agents/gsd.yaml`; no GSD hooks or statusline |
| Codex | `~/.codex` | `./.codex` | `skills/gsd-*/SKILL.md` (flat) | `agents/` source markdown plus per-agent TOML (Codex auto-discovers each `agents/gsd-*.toml`; this is the sole canonical role registration, #2406) | `config.toml` bare `[agents]` dispatch-tuning scalar (`max_depth`, no per-role `[agents.gsd-*]` tables), `[features].hooks` (canonical; legacy alias `codex_hooks` is recognized and migrated forward on reinstall, #3566), and hook tables |
| GitHub Copilot | `~/.copilot` | `./.github` | `skills/gsd-*/SKILL.md` (flat), `copilot-instructions.md`, and `AGENTS.md` (repo root, local) | `.agent.md` files | Self-contained `sessionStart` hook (`hooks/gsd-session.json`, inline `command` type); no statusline |
| Antigravity | auto-detected: `~/.gemini/antigravity`, `~/.gemini/antigravity-ide`, or `~/.gemini/antigravity-cli` | `./.agent` | `~/.gemini/config/skills/gsd-*/SKILL.md` (flat, #1614; global home override #3738) | `~/.gemini/config/agents/gsd-*.md` (#3738) | Gemini-style `settings.json` hook entries when installed by GSD |
| Cursor | `~/.cursor` | `./.cursor` | `skills/gsd-*/SKILL.md` (flat) | `agents/gsd-*.md` | Rule references under `rules/`; `hooks.json` with sessionStart context injection and postToolUse STATE.md monitor (#777) |
| Windsurf | `~/.codeium/windsurf` config | `./.windsurf` | `workflows/gsd-*.md` slash-command workflows | No custom-agent artifact surface | No GSD hooks |
| Augment Code | `~/.augment` | `./.augment` | `skills/gsd-ns-*/SKILL.md` (6 routers) + `skills/gsd-ns-*/skills/<name>/SKILL.md` (nested concretes) | `agents/gsd-*.md` | No GSD hooks or statusline |
| Trae | `~/.trae` | `./.trae` | `skills/gsd-ns-*/SKILL.md` (6 routers) + `skills/gsd-ns-*/skills/<name>/SKILL.md` (nested concretes) | `agents/gsd-*.md` | Rule references under `rules/`; no GSD hooks |
| Qwen Code | `~/.qwen` | `./.qwen` | `skills/gsd-ns-*/SKILL.md` (6 routers) + `skills/gsd-ns-*/skills/<name>/SKILL.md` (nested concretes) | `agents/gsd-*.md` | Common GSD settings and hook entries where supported |
| Hermes Agent | `~/.hermes` | `./.hermes` | `skills/gsd/ns-*/SKILL.md` (6 routers, prefix='') + `skills/gsd/ns-*/skills/<name>/SKILL.md` (nested concretes) | `agents/gsd-*.md` | Common GSD settings and hook entries where supported |
| CodeBuddy | `~/.codebuddy` | `./.codebuddy` | `skills/gsd-*/SKILL.md` (flat, `user-invocable: false`) | `agents/gsd-*.md` | `/gsd-*` slash commands under `commands/`; common GSD settings and hook entries where supported |
| Cline | `~/.cline` | project root | `skills/gsd-ns-*/SKILL.md` (6 routers) + `skills/gsd-ns-*/skills/<name>/SKILL.md` (nested concretes) + `.clinerules` | Rules only | No GSD hooks or statusline |

## Upstream contract sources

Runtime install expectations are checked against primary documentation where
available. The current source snapshot is 2026-05-11, with Kimi CLI rechecked
on 2026-06-07:

- Claude Code: Anthropic slash commands, settings, hooks, and subagents docs.
- OpenCode and Kilo: OpenCode config docs and Kilo custom subagent docs.
- Qwen Code: command/config docs; Qwen command docs were last
  updated 2026-05-06.
- Kimi CLI: Agent Skills docs for user-level brand roots and first-existing
  generic roots (`~/.config/agents/skills/` recommended, then
  `~/.agents/skills/`), plus Agents docs for YAML files, `system_prompt_path`,
  `kimi_cli.tools.*` module paths, and explicit `kimi --agent-file` launch.
- Codex: OpenAI Codex docs and `config-schema.json`; the installer also carries
  Codex 0.124.0 compatibility for agent table shape.
- Copilot, Cursor, Cline, Augment, Hermes, and CodeBuddy: vendor docs for
  custom instructions, rules, skills, or config.
- Antigravity, Windsurf, and Trae: source-limited rows. The installer documents
  current compatibility shims, and migrations must refresh those sources before
  rewriting their config.

---

## Related

- [Architecture — Runtime Abstraction](../ARCHITECTURE.md#runtime-abstraction) — why translation happens at install time
- [Install on your runtime](../how-to/install-on-your-runtime.md) — the steps per runtime
- [Installer flags](installer-flags.md) — what the installer itself accepts
- [Planning artifacts](planning-artifacts.md) — the `.planning/` directory the install feeds
