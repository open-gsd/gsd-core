# How to install GSD Core on your runtime

Install GSD Core (`@opengsd/gsd-core`) into the AI coding runtime you use every day. This guide gives you the standard installer path for each supported runtime, then covers the manual path for machines without Node.js.

**What you need:** Node.js 18+ and npm (or npx). If you do not have Node.js, jump to [Installing without Node.js](#installing-without-nodejs).

---

## Why the installer is required

GSD Core ships agent and command files in Claude Code's native frontmatter format. Each supported runtime expects a different schema, directory layout, and command-invocation syntax. The installer performs the necessary transformations — for example, converting tool lists and colour values for OpenCode, writing TOML agent entries for Codex, and rewriting every command body from hyphen form (`/gsd-update`) to colon form (`/gsd:update`) for Gemini CLI.

**Do not copy files from `agents/` or `commands/` directly.** Doing so bypasses the transformations and produces schema-validation errors or missing commands.

---

## Standard install

Run the installer from any directory. It prompts for your runtime and whether to install globally (all projects) or locally (this project only).

```bash
npx @opengsd/gsd-core@latest
```

That is the only command you need for a fresh install or to re-run the installer after switching runtimes.

---

## Per-runtime instructions

### Claude Code

```bash
npx @opengsd/gsd-core@latest --claude --global
```

Skills land in `~/.claude/`. Commands appear as `/gsd-*` slash commands in your next Claude Code session. Restart Claude Code to pick them up.

**Override the install directory:**

```bash
CLAUDE_CONFIG_DIR=~/.claude-alt npx @opengsd/gsd-core@latest --claude --global
```

---

### Claude Code — native plugin install

GSD Core ships a `.claude-plugin/plugin.json` manifest, which enables installation and lifecycle management through the Claude Code plugin system. This path is **additive** — the npm installer above remains fully supported, and the two approaches differ in namespace and lifecycle only.

**Install paths**

*Option A — marketplace or git install (once listed):*

```bash
claude plugin install gsd-core
```

*Option B — zero-friction skills-dir load:* Claude Code automatically discovers any directory under `~/.claude/skills/` that contains a `.claude-plugin/plugin.json` as a plugin. To use gsd-core this way, place (or symlink) the gsd-core package directory there:

```bash
# Example: place the package under ~/.claude/skills/gsd-core/
# Claude Code loads it as gsd-core@skills-dir on the next session start.
# No explicit install step required.
```

**Command namespace**

Plugin commands are namespaced as `/gsd-core:<command>` — for example, `/gsd-core:plan-phase`. This is distinct from the classic npm/file-copy installer, which exposes commands as `/gsd:<command>`. Use whichever namespace corresponds to your install method.

**Lifecycle**

```bash
claude plugin enable gsd-core
claude plugin disable gsd-core
claude plugin update gsd-core
```

**Hooks**

The plugin wires gsd-core's always-on guard and update hooks automatically via `hooks/hooks.json`. No manual hook registration is required.

**Prerequisites**

The `gsd-tools` binary (installed as part of the `@opengsd/gsd-core` npm package) must be available on your `PATH` for gsd commands to execute their backing logic. The plugin delivers the command, agent, and hook surface; the npm package delivers the runtime CLI.

Node.js (`node`) must also be available on your `PATH`. The plugin's always-on guard hooks (wired in `hooks/hooks.json`) are invoked as `node "${CLAUDE_PLUGIN_ROOT}/hooks/<script>"`. Some Claude Code distributions ship as a standalone binary and do not expose a `node` executable on `PATH`; in those environments the plugin's hooks will not run. Verify with `node --version` before relying on the plugin hooks.

---

### Gemini CLI

```bash
npx @opengsd/gsd-core@latest --gemini --global
```

Skills land in `~/.gemini/`. The installer rewrites all command bodies to Gemini's colon namespace (`/gsd:update`, `/gsd:config`, etc.). Restart Gemini CLI after install.

**Override the install directory:**

```bash
GEMINI_CONFIG_DIR=~/.gemini-alt npx @opengsd/gsd-core@latest --gemini --global
```

---

### Gemini CLI — native extension install (#775)

GSD also ships a `gemini-extension.json` extension manifest, so you can manage GSD through Gemini's own extension lifecycle and see it in `gemini extensions list`:

```bash
gemini extensions install https://github.com/open-gsd/gsd-core   # install
gemini extensions update gsd-core                                # update
gemini extensions uninstall gsd-core                             # remove
gemini extensions link /path/to/gsd-core                         # dev: symlink a checkout
```

The extension loads GSD's operating context (`GEMINI.md`) into every session and gives you the discoverable install/update/remove lifecycle. The `/gsd:*` slash commands, agents, and hooks are installed separately by `npx @opengsd/gsd-core --gemini --global` (above). The two paths are complementary and additive — neither replaces the other, and slash-command projection into the extension is a planned follow-up.

---

### OpenCode

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

The installer writes three surfaces under `~/.config/opencode/` (XDG) or `~/.opencode/`: flat slash commands in `command/`, file-based subagents in `agents/`, and on-demand skills in `skills/<name>/SKILL.md`. It converts agent frontmatter to OpenCode's schema — removing the `tools:` field and converting colour values to hex — and emits each skill with spec-compliant frontmatter (`name` matching the skill directory plus a `description`). Skills are loaded on demand via OpenCode's native skill tool; commands remain invokable as `/gsd-*`. See [Installing without Node.js — OpenCode transformations](#opencode--required-transformations) if you need to understand what changes.

**Override the install directory:**

```bash
OPENCODE_CONFIG_DIR=~/.config/opencode-alt npx @opengsd/gsd-core@latest --opencode --global
```

---

### Kilo

```bash
npx @opengsd/gsd-core@latest --kilo --global
```

The installer writes the same three surfaces under `~/.config/kilo/` (XDG) or `~/.kilo/` as for OpenCode — flat commands in `command/`, subagents in `agents/`, and skills in `skills/<name>/SKILL.md` — since Kilo derives from OpenCode and shares its config schema and skill layout.

**Override the install directory:**

```bash
KILO_CONFIG_DIR=~/.config/kilo-alt npx @opengsd/gsd-core@latest --kilo --global
```

---

### Codex

```bash
npx @opengsd/gsd-core@latest --codex --global
```

Skills land in `~/.codex/skills/gsd-*/SKILL.md`. Agents are written with per-agent TOML entries in `config.toml`. Restart Codex (or run `codex --reload`) after install.

**Minimum supported version:** Codex CLI 0.130.0. Earlier versions had additional skill-root scanning that can produce duplicate listings.

---

### GitHub Copilot

```bash
npx @opengsd/gsd-core@latest --copilot --global
```

Skills land in `~/.copilot/`. GSD installs as agent `.md` files and repository instruction files.

GSD also wires Copilot's lifecycle hooks and instruction files:

- **`AGENTS.md`** (local installs) — written at the repository root, which GitHub Copilot CLI reads as primary instructions, alongside `copilot-instructions.md`.
- **Lifecycle hook** — a `sessionStart` hook config is written to `.github/hooks/gsd-session.json` (local) or `~/.copilot/hooks/gsd-session.json` (global). It is a self-contained inline `command` hook (no separate hook script to install), so it can never reference a missing script. The hook is advisory-only: at session start it surfaces whether the project has a `.planning/` workflow.

Both are removed (and any user-authored content preserved) on `--uninstall`.

**Override the install directory:**

```bash
COPILOT_CONFIG_DIR=~/.copilot-alt npx @opengsd/gsd-core@latest --copilot --global
```

---

### Cursor

```bash
npx @opengsd/gsd-core@latest --cursor --global
```

Skills land in `~/.cursor/`. GSD installs skills, agents, and rule references.

**Override the install directory:**

```bash
CURSOR_CONFIG_DIR=~/.cursor-alt npx @opengsd/gsd-core@latest --cursor --global
```

---

### Windsurf

```bash
npx @opengsd/gsd-core@latest --windsurf --global
```

Skills land in `~/.codeium/windsurf/`. GSD installs skills, agents, and workspace rules.

**Override the install directory:**

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-alt npx @opengsd/gsd-core@latest --windsurf --global
```

---

### Cline

GSD gives Cline both skills (≥ v3.48.0) and the `.clinerules/` directory integration — no custom slash commands are registered.

```bash
# Global install (all projects — skills + rules directory)
npx @opengsd/gsd-core@latest --cline --global

# Local install (this project only — rules directory only)
npx @opengsd/gsd-core@latest --cline --local
```

GSD writes the [`.clinerules/` directory form](https://docs.cline.bot/customization/cline-rules):

- **`.clinerules/gsd.md`** — the GSD rule file. Cline loads every `.md`/`.txt` file in
  the `.clinerules/` directory automatically; no custom slash commands are registered.
- **`.clinerules/hooks/PreToolUse`** — a [lifecycle hook](https://cline.bot/blog/cline-v3-36-hooks)
  (Cline v3.36+). It is an executable script that receives the tool-call context as JSON on
  stdin and returns a JSON decision (`cancel` / `errorMessage` / `contextModification`). The
  GSD hook guards `.planning/` artifacts from direct edits and otherwise allows the operation;
  it fails open, so a hook error never blocks you. Cline runs hooks on macOS and Linux only.

**Global install additionally:**

- Emits each GSD command as **`~/.cline/skills/<name>/SKILL.md`**. Cline ≥ v3.48.0 loads
  skills from `~/.cline/skills/` automatically — no configuration needed.
- Merges GSD instructions into **`~/.agents/AGENTS.md`**, the cross-tool global instruction
  file Cline reads. The block is marker-delimited, so your own `AGENTS.md` content (and other
  tools' entries) is preserved, and `--uninstall` strips only the GSD block.

**Local install** writes the `.clinerules/` directory into the current project only. No skills
directory is created for local scope.

> Cline's *global* hook directory (`~/Documents/Cline/Rules/Hooks/`) is not yet populated by the
> installer — project-scope hooks (`.clinerules/hooks/`) and the global `AGENTS.md` instruction
> target cover the common cases.

---

### CodeBuddy

```bash
npx @opengsd/gsd-core@latest --codebuddy --global
```

Skills land in `~/.codebuddy/skills/gsd-*/SKILL.md`.

---

### Qwen Code

Qwen Code uses the same open skills standard as Claude Code 2.1.88+.

```bash
npx @opengsd/gsd-core@latest --qwen --global
```

Skills land in `~/.qwen/skills/gsd-*/SKILL.md`.

**Override the install directory:**

```bash
QWEN_CONFIG_DIR=~/.qwen-alt npx @opengsd/gsd-core@latest --qwen --global
```

**Hook coverage**

Qwen Code supports 15 hook events. GSD registers the following events automatically on install:

| Event | Hook | Purpose |
|---|---|---|
| `SessionStart` | `gsd-check-update.js`, `gsd-session-state.sh` | Update check, session orientation |
| `PostToolUse` | `gsd-context-monitor.js`, `gsd-read-injection-scanner.js`, `gsd-phase-boundary.sh`, `gsd-graphify-update.sh` | Context monitoring, read-time scan, phase boundary detection |
| `PreToolUse` | `gsd-prompt-guard.js`, `gsd-read-guard.js`, `gsd-workflow-guard.js`, `gsd-worktree-path-guard.js`, `gsd-validate-commit.sh` | Prompt guard, read-before-edit, workflow + worktree safety, commit validation |
| `SubagentStop` | `gsd-context-monitor.js` | Context headroom tracking after subagent completion |
| `Stop` | `gsd-context-monitor.js` | Context headroom tracking before model stop |
| `PreCompact` | `gsd-context-monitor.js` | Context awareness before conversation compaction |

---

### Augment Code

```bash
npx @opengsd/gsd-core@latest --augment --global
```

Skills land in `~/.augment/skills/` and slash command definitions land in `~/.augment/commands/`. GSD installs skills, agents, and commands (`/gsd-phase`, `/gsd-ship`, etc.). No hook or statusline ownership.

---

### Antigravity

```bash
npx @opengsd/gsd-core@latest --antigravity --global
```

The installer auto-detects the Antigravity config directory (`~/.gemini/antigravity`, `~/.gemini/antigravity-ide`, or `~/.gemini/antigravity-cli`). Uses Gemini-compatible settings policy.

**Override the install directory:**

```bash
ANTIGRAVITY_CONFIG_DIR=~/.gemini/antigravity-alt npx @opengsd/gsd-core@latest --antigravity --global
```

---

### Trae

```bash
npx @opengsd/gsd-core@latest --trae --global
```

Skills land in `~/.trae/`. GSD installs skills, agents, and rule references.

---

## Local vs global install

All examples above use `--global`, which installs GSD once for your user account. To scope an install to a single project, replace `--global` with `--local`:

```bash
npx @opengsd/gsd-core@latest --claude --local
```

A local install writes into the `.claude/` directory at your project root. Local install settings take precedence over global ones when both exist.

---

## Installing prerelease editions (Next / Nightly / Insiders / Preview)

Prerelease editions of runtimes (Windsurf Next, Cursor Nightly, VS Code Insiders, Codex preview channels, etc.) read from a sibling config directory. Set the matching `*_CONFIG_DIR` env var before running the installer:

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

Select the corresponding stable runtime in the installer prompt. GSD does not enumerate prerelease editions as separate named runtimes — they are best-effort via this env-var mechanism and are not separately tested in release CI.

---

## Installing without Node.js

If you cannot run `npx` (for example, on a Windows machine without Node.js), you have two options.

**Option A — Use a machine that has Node.js.** Any machine with Node.js will do: WSL, a Linux VM, a CI runner, or a Docker container. Run the installer there, then copy the output directory to your target machine. For OpenCode:

```bash
npx @opengsd/gsd-core@latest --opencode --global
# Then copy ~/.config/opencode/agents/ to the Windows machine
```

**Option B — Manually transform the source files.** The agent source files live in `agents/` in the GSD Core repository and are in Claude Code's native frontmatter format. Each runtime expects a different shape. For the exact field transformations per runtime, see [Manual install / no-Node.js setup](../USER-GUIDE.md#manual-install--no-nodejs-setup) in the User Guide, which covers the OpenCode transformations in full detail and points to the installer's `convert*Frontmatter` functions for other runtimes.

---

## After install

Restart your runtime to pick up new commands and agents. Then start your first project:

```bash
/gsd-new-project
```

If the command is not found after restart, verify the install directory matches the runtime's expected config path. The prerelease-editions section above covers the most common mismatch.

---

## Related

- [Your first project](../tutorials/your-first-project.md)
- [Update GSD Core](update-gsd.md)
- [Configuration](../CONFIGURATION.md)
- [Docs index](../README.md)
