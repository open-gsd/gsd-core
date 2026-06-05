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

### OpenCode

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

Skills land in `~/.config/opencode/` (XDG) or `~/.opencode/`. The installer converts agent frontmatter to OpenCode's schema — removing the `tools:` field and converting colour values to hex. See [Installing without Node.js — OpenCode transformations](#opencode--required-transformations) if you need to understand what changes.

**Override the install directory:**

```bash
OPENCODE_CONFIG_DIR=~/.config/opencode-alt npx @opengsd/gsd-core@latest --opencode --global
```

---

### Kilo

```bash
npx @opengsd/gsd-core@latest --kilo --global
```

Skills land in `~/.config/kilo/` (XDG) or `~/.kilo/`. Uses the same OpenCode-style flat markdown command format.

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

Cline uses a rules-based integration — GSD installs as `.clinerules` rather than slash commands.

```bash
# Global install (all projects)
npx @opengsd/gsd-core@latest --cline --global

# Local install (this project only)
npx @opengsd/gsd-core@latest --cline --local
```

Global installs write to `~/.cline/`. Local installs write to `./.cline/`. Rules are loaded automatically by Cline — no custom slash commands are registered.

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

---

### Augment Code

```bash
npx @opengsd/gsd-core@latest --augment --global
```

Skills land in `~/.augment/`. GSD installs skills and agents. No hook or statusline ownership.

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

### "… is not on your PATH" after install

If the installer's global bin directory is not on your `PATH`, it prints a one-time warning with a copy-paste command for your shell. The suggestion list covers `zsh`, `bash`, and `fish` (plus PowerShell, cmd.exe, and Git Bash on Windows):

```fish
# fish — persists via fish's universal variables
fish_add_path '/path/to/global/bin'
```

The installer also suppresses this warning when your shell already covers the directory — for fish that means an existing `fish_user_paths` entry (in `~/.config/fish/fish_variables`) or a `fish_add_path` / `set -gx PATH` line in `~/.config/fish/config.fish`. If the directory is already covered but the warning still mentions reopening your shell, open a new session (`exec fish`) to pick up the change.

---

## Related

- [Your first project](../tutorials/your-first-project.md)
- [Update GSD Core](update-gsd.md)
- [Configuration](../CONFIGURATION.md)
- [Docs index](../README.md)
