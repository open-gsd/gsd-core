> # Project Continuity Notice
>
> GSD is maintained by the **open-gsd** team at:
> **`open-gsd/get-shit-done-redux`**
>
> Use only these package names:
>
> - npm (main): `@opengsd/get-shit-done-redux`
> - npm (sdk): `@opengsd/gsd-sdk`
>
> The legacy upstream (`gsd-build/*`) is outside open-gsd control. Based on public transition announcements and repository ownership reality, we strongly recommend removing `gsd-build` organization packages and migrating to `@opengsd/*`.
>
> Security status:
>
> - maintainers completed an internal security audit
> - maintainers report an independent review pass
> - no known active exploit was found in tracked source during those passes
>
> See:
>
> - continuity announcement: https://github.com/open-gsd/get-shit-done-redux/discussions/109
> - audit transparency report: https://github.com/open-gsd/get-shit-done-redux/discussions/119
>
> ---

<div align="center">

# GET SHIT DONE

**English** · [Português](README.pt-BR.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

**A light-weight meta-prompting, context engineering, and spec-driven development system for Claude Code, OpenCode, Gemini CLI, Kilo, Codex, Copilot, Cursor, Windsurf, and more.**

**Solves context rot — the quality degradation that happens as your AI fills its context window.**

[![npm version](https://img.shields.io/npm/v/%40opengsd%2Fget-shit-done-redux?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/get-shit-done-redux)
[![npm downloads](https://img.shields.io/npm/dm/%40opengsd%2Fget-shit-done-redux?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/get-shit-done-redux)
[![Tests](https://img.shields.io/github/actions/workflow/status/open-gsd/get-shit-done-redux/test.yml?branch=main&style=for-the-badge&logo=github&label=Tests)](https://github.com/open-gsd/get-shit-done-redux/actions/workflows/test.yml)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/mYgfVNfA2r)
[![GitHub stars](https://img.shields.io/github/stars/open-gsd/get-shit-done-redux?style=for-the-badge&logo=github&color=181717)](https://github.com/open-gsd/get-shit-done-redux)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

<br>

```bash
npx @opengsd/get-shit-done-redux@latest
```

**Works on Mac, Windows, and Linux.**

<br>

![GSD Install](assets/terminal.svg)

<br>

*"If you know clearly what you want, this WILL build it for you. No bs."*

*"I've done SpecKit, OpenSpec and Taskmaster — this has produced the best results for me."*

*"By far the most powerful addition to my Claude Code. Nothing over-engineered. Literally just gets shit done."*

<br>

**Trusted by engineers at Amazon, Google, Shopify, and Webflow.**

</div>

---

> [!IMPORTANT]
> **Returning to GSD?**
>
> Run `/gsd-map-codebase` to re-index your codebase, then `/gsd-new-project` to rebuild GSD's planning context. Your code is fine — GSD just needs its context rebuilt. See the [CHANGELOG](CHANGELOG.md) for what's new.

---

## Why We Continue Building GSD

GSD exists to help solo builders and small teams ship reliably with AI: clear specs, controlled context, and verification before release.

In May 2026, maintainers published a continuity announcement and migrated active development to `open-gsd/get-shit-done-redux` after trust and ownership concerns around the former upstream, including a meme-coin rug-pull incident publicly associated with that ecosystem.

The former creator and the `gsd-build` lineage are no longer part of this program. This repository is the maintained continuation under open-gsd governance.

The current team continues release operations, triage, and security hardening in public. Audit status and follow-up security work are documented in Discussion #119 and linked issues.

---

## How It Works

The loop is six commands. Each one does exactly one thing.

### 1. Initialize

```bash
/gsd-new-project
```

Questions → research → requirements → roadmap. You approve it, then you're ready to build.

> **Already have code?** Run `/gsd-map-codebase` first. It analyzes your stack, architecture, and conventions so `/gsd-new-project` asks the right questions.

### 2. Discuss

```bash
/gsd-discuss-phase 1
```

Your roadmap has a sentence per phase. That's not enough to build it the way *you* imagine it. Discuss captures your decisions before anything gets planned: layouts, API shapes, error handling, data structures — whatever gray areas exist for this specific phase.

The output feeds directly into research and planning. Skip it, get reasonable defaults. Use it, get your vision.

### 3. Plan

```bash
/gsd-plan-phase 1
```

Research → plan → verify, in a loop until the plans pass. Each plan is small enough to execute in a fresh context window.

### 4. Execute

```bash
/gsd-execute-phase 1
```

Plans run in parallel waves. Each executor gets a fresh 200k-token context. Each task gets its own atomic commit. Walk away, come back to completed work with a clean git history.

Your main context window stays at 30–40%. The work happens in the subagents.

### 5. Verify

```bash
/gsd-verify-work 1
```

Walk through what was built. Anything broken gets a diagnosed fix plan — ready for immediate re-execution. You don't debug manually; you just run execute again.

### 6. Repeat → Ship

```bash
/gsd-ship 1
/gsd-complete-milestone
/gsd-new-milestone
```

Loop discuss → plan → execute → verify → ship until the milestone is done. Then archive, tag, and start the next one fresh.

---

## Getting Started

```bash
npx @opengsd/get-shit-done-redux@latest
```

The installer prompts for your runtime (Claude Code, OpenCode, Gemini CLI, Kilo, Codex, Copilot, Cursor, Windsurf, and more) and whether to install globally or locally.

```bash
claude --dangerously-skip-permissions
```

GSD is built for frictionless automation. Skip-permissions is how it's intended to run.

Install only the skills you need with `--profile=core` (six core-loop skills), `--profile=standard` (core + phase management), or the default full install. Profiles compose: `--profile=core,audit`. `--minimal` is an alias for `--profile=core`. See **[docs/USER-GUIDE.md](docs/USER-GUIDE.md)** for the full walkthrough, non-interactive install flags for all 15 runtimes, and permissions configuration. See [ADR-0011](docs/adr/0011-skill-surface-budget-module.md) for the profile model and runtime surface control.

Current release highlights are in [docs/RELEASE-v1.42.1.md](docs/RELEASE-v1.42.1.md): package legitimacy checks, safer installer migrations, runtime surface control, custom ship PR sections, reviewer defaults, fallow structural review, and quota-aware execution recovery.

### Cross-runtime compatibility: installer required

The `agents/` and `commands/` directories in this repository are Claude Code-format source files. The installer (`npx @opengsd/get-shit-done-redux@latest`) transforms them per target runtime — stripping or converting frontmatter fields that Claude Code uses but other runtimes reject. For example, OpenCode requires `color` as a hex or semantic value from a fixed set, and does not accept a `tools:` frontmatter field; the installer function `convertClaudeToOpencodeFrontmatter` (`bin/install.js`) handles this automatically.

**Manually copying files** from `agents/` or `commands/` directly into a non-Claude-Code runtime config directory (e.g., `~/.config/opencode/agents`) skips the conversion step and will produce schema validation errors in that runtime.

If you are on a system without Node.js or npm (Windows + OpenCode is the most common case), see **[docs/USER-GUIDE.md — Manual install / no-Node.js setup](docs/USER-GUIDE.md#manual-install--no-nodejs-setup)** for the per-runtime conversion summary and alternative install paths.

---

## Commands

The main loop:

| Command | What it does |
|---------|--------------|
| `/gsd-new-project` | Questions → research → requirements → roadmap |
| `/gsd-discuss-phase [N]` | Capture implementation decisions before planning |
| `/gsd-plan-phase [N]` | Research + plan + verify |
| `/gsd-execute-phase <N>` | Execute plans in parallel waves |
| `/gsd-verify-work [N]` | Manual acceptance testing |
| `/gsd-ship [N]` | Create PR from verified phase work |
| `/gsd-progress --next` | Auto-detect and run the next step |
| `/gsd-complete-milestone` | Archive milestone and tag release |
| `/gsd-new-milestone` | Start next version |
| `/gsd:surface` | Enable/disable skill clusters at runtime without reinstall |

For ad-hoc tasks, autonomous mode, codebase analysis, forensics, and the full command surface — see **[docs/COMMANDS.md](docs/COMMANDS.md)**.

---

## Why It Works

Three things most AI-coding setups get wrong:

**1. Context bloat.** As a session grows, quality degrades. GSD keeps your main context clean by doing the heavy work in fresh subagent contexts. Researchers, planners, and executors each start fresh with exactly what they need.

**2. No shared memory.** GSD maintains structured artifacts that survive session boundaries: `PROJECT.md` (vision), `REQUIREMENTS.md` (scope), `ROADMAP.md` (where you're going), `STATE.md` (current position and decisions), `CONTEXT.md` (per-phase implementation decisions). Every new session loads these and knows exactly where things stand.

**3. No verification.** Code that "runs" isn't code that "works." GSD's verify step walks you through what was built, diagnoses failures with dedicated debug agents, and generates fix plans before you declare a phase done.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how the multi-agent orchestration and context engineering work in detail.

---

## Configuration

Settings live in `.planning/config.json`. Configure during `/gsd-new-project` or update with `/gsd-settings`.

Key dials:

| Setting | What it controls |
|---------|-----------------|
| `mode` | `interactive` (confirm each step) or `yolo` (auto-approve) |
| Model profiles | `quality` / `balanced` / `budget` — controls which model each agent uses |
| `workflow.research` / `plan_check` / `verifier` | Toggle the quality agents that add tokens and time |
| `parallelization.enabled` | Run independent plans simultaneously |

Optional structural review: set `code_quality.fallow.enabled` to `true` to add a fallow pre-pass to `/gsd-code-review`. GSD writes `.planning/phases/<phase>/FALLOW.json` and surfaces a `Structural Findings (fallow)` section in `REVIEW.md`. Install with `npm install -D fallow@^2.70.0` (or system-wide via `cargo install fallow`; note that the Rust binary's JSON schema must match the documented v2.70+ contract — older versions may produce silent zero-finding output).

Package legitimacy checks are built into the research, planning, and execution path: recommended dependencies get audited, unverified packages require a human checkpoint, and failed installs stop instead of trying similarly named alternatives.

For the full configuration reference — all settings, git branching strategies, per-runtime model overrides, workstream config inheritance, agent skills injection — see **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**.

---

## Documentation

| Doc | What's in it |
|-----|-------------|
| [User Guide](docs/USER-GUIDE.md) | End-to-end walkthrough, install options, all runtime flags, configuration reference |
| [Commands](docs/COMMANDS.md) | Every command with flags and examples |
| [Configuration](docs/CONFIGURATION.md) | Full config schema, model profiles, git branching |
| [Architecture](docs/ARCHITECTURE.md) | How the multi-agent orchestration works |
| [CLI Tools](docs/CLI-TOOLS.md) | `gsd-sdk query` and programmatic SDK dispatch seams |
| [Features](docs/FEATURES.md) | Complete feature index |
| [Changelog](CHANGELOG.md) | What changed in each release |

---

## Troubleshooting

**Commands not showing up?** Restart your runtime after install. GSD installs to `~/.claude/skills/gsd-*/` (Claude Code), `~/.codex/skills/gsd-*/` (Codex), or the equivalent for your runtime.

**Codex users — minimum supported CLI version is `0.130.0`.** Codex CLI 0.130.0 ([release notes](https://github.com/openai/codex/releases/tag/rust-v0.130.0)) removed extra-skill-roots discovery via [openai/codex#21485](https://github.com/openai/codex/pull/21485); from that version onward Codex discovers skills from standard roots (including `~/.codex/skills/<name>/SKILL.md`). GSD installs there directly. Earlier Codex CLI versions may still discover additional roots, which can surface duplicate `gsd-*` entries (one from extra-roots discovery, one from `~/.codex/skills/`); restart Codex after install and either upgrade or accept the duplicate listing.

**Something broken?** Re-run the installer — it's idempotent:
```bash
npx @opengsd/get-shit-done-redux@latest
```

**Containers or Docker?** Set `CLAUDE_CONFIG_DIR` before installing to avoid tilde-expansion issues:
```bash
CLAUDE_CONFIG_DIR=/home/youruser/.claude npx @opengsd/get-shit-done-redux --global
```

Full troubleshooting and uninstall instructions in **[docs/USER-GUIDE.md](docs/USER-GUIDE.md#troubleshooting)**.

---

## Community

| Project | Platform |
|---------|----------|
| [gsd-opencode](https://github.com/rokicool/gsd-opencode) | Original OpenCode port |
| [Discord](https://discord.gg/mYgfVNfA2r) | Community support |

---

## Star History

<a href="https://star-history.com/#open-gsd/get-shit-done-redux&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=open-gsd/get-shit-done-redux&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=open-gsd/get-shit-done-redux&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=open-gsd/get-shit-done-redux&type=Date" />
 </picture>
</a>

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

<div align="center">

**Claude Code is powerful. GSD makes it reliable.**

</div>
