# GSD Core Documentation

Comprehensive documentation for GSD Core (Git. Ship. Done.) — a meta-prompting, context engineering, and spec-driven development system for AI coding agents.

Language versions: [English](README.md) · [Português (pt-BR)](pt-BR/README.md) · [日本語](ja-JP/README.md) · [简体中文](zh-CN/README.md)

## Documentation Index

| Document | Audience | Description |
|----------|----------|-------------|
| [Architecture](ARCHITECTURE.md) | Contributors, advanced users | System architecture, agent model, data flow, and internal design |
| [Installer Migrations](installer-migrations.md) | Contributors | Architecture for safe install-time migrations, cleanup, preservation, dry-run planning, and rollback |
| [Feature Reference](FEATURES.md) | All users | Feature narratives and requirements for released features |
| [Command Reference](COMMANDS.md) | All users | Stable commands with syntax, flags, options, and examples |
| [Configuration Reference](CONFIGURATION.md) | All users | Full config schema, workflow toggles, model profiles, git branching |
| [Custom PR Body Sections](ship-pr-body-sections.md) | All users | How to append project-specific PRD sections to `/gsd-ship` PR bodies |
| [CLI Tools Reference](CLI-TOOLS.md) | Contributors, agent authors | `gsd-tools.cjs` programmatic API for workflows and agents |
| [JSON Error Mode](json-errors.md) | Contributors, agent authors | Machine-readable `gsd-tools --json-errors` failure envelopes |
| [Agent Reference](AGENTS.md) | Contributors, advanced users | Role cards for primary agents — roles, tools, spawn patterns (the `agents/` filesystem is authoritative) |
| [User Guide](USER-GUIDE.md) | All users | Workflow walkthroughs, troubleshooting, and recovery |
| [Issue-Driven Orchestration](issue-driven-orchestration.md) | All users | Recipe for driving GSD from a tracker issue (GitHub / Linear / Jira) using existing primitives — no new commands or daemon |
| [Context Monitor](context-monitor.md) | All users | Context window monitoring hook architecture |
| [Discuss Mode](workflow-discuss-mode.md) | All users | Assumptions vs interview mode for discuss-phase |
| [Canary Stream](CANARY.md) | Maintainers | Archived stream notes; current public npm tags are `latest` and `next` |

## Quick Links

- **What's new:** install `@opengsd/gsd-core@latest` and use the npm/package version as the current source of truth; older release-note files are archived continuity notes
- **Preview streams:** current public npm tags are `latest` and `next`; older canary notes are archived in [Canary Stream](CANARY.md)
- **Getting started:** [README](../README.md) → install → `/gsd-new-project`
- **Full workflow walkthrough:** [User Guide](USER-GUIDE.md)
- **All commands at a glance:** [Command Reference](COMMANDS.md)
- **Configuring GSD:** [Configuration Reference](CONFIGURATION.md)
- **Customizing ship PR bodies:** [Custom PR Body Sections](ship-pr-body-sections.md)
- **How the system works internally:** [Architecture](ARCHITECTURE.md)
- **Contributing or extending:** [CLI Tools Reference](CLI-TOOLS.md) + [Agent Reference](AGENTS.md)
