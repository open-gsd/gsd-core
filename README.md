<div align="center">

# GSD OMP

**A downstream GSD Core fork maintained for native Oh My Pi support.**

**English** · [Português](README.pt-BR.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

**GSD Core's context-engineering workflow, kept compatible with upstream while adding native OMP commands, skills, agents, rules, and extensions.**

[![upstream npm](https://img.shields.io/npm/v/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837&label=upstream%20npm)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![upstream downloads](https://img.shields.io/npm/dm/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837&label=upstream%20downloads)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![Tests](https://img.shields.io/github/actions/workflow/status/sh1ny/gsd-omp/test.yml?branch=main&style=for-the-badge&logo=github&label=Tests)](https://github.com/sh1ny/gsd-omp/actions/workflows/test.yml)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/mYgfVNfA2r)
[![GitHub stars](https://img.shields.io/github/stars/sh1ny/gsd-omp?style=for-the-badge&logo=github&color=181717)](https://github.com/sh1ny/gsd-omp)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

</div>

---

## Why this fork exists

`sh1ny/gsd-omp` is a downstream fork of [`open-gsd/gsd-core`](https://github.com/open-gsd/gsd-core). Upstream declined in-repository OMP runtime support in [open-gsd/gsd-core#874](https://github.com/open-gsd/gsd-core/issues/874) and pointed OMP users at [`open-gsd/gsd-pi`](https://github.com/open-gsd/gsd-pi). This fork keeps the lighter GSD Core runtime-integration path available for users who want GSD Core artifacts installed directly into OMP.

We maintain this fork to track upstream GSD Core fixes while preserving native OMP install behavior. The maintenance policy is deliberately small: merge upstream `next`, keep OMP-specific installer/runtime support working, and avoid changing non-OMP behavior unless upstream compatibility requires it.

---

## What is GSD Core

GSD Core is a context-engineering and spec-driven development framework that drives AI coding agents (Claude Code, Codex, Gemini CLI, Kimi CLI, Copilot, Cursor, and more) through a disciplined phase loop. It solves [context rot](docs/explanation/context-engineering.md) — the quality degradation that accumulates as an AI fills its context window — by running all heavy research, planning, and execution work in fresh-context subagents while keeping your main session lean.

---

## How this fork differs from upstream

| Area | Upstream `open-gsd/gsd-core` | This fork `sh1ny/gsd-omp` |
|------|-------------------------------|----------------------------|
| OMP runtime | No in-repo native OMP runtime support. | Adds `--omp` install support. |
| Install targets | Installs supported upstream runtime artifacts. | Also installs `.omp/{commands,skills,agents,rules,extensions}/` locally, or `$OMP_CONFIG_DIR` / `~/.omp/agent` globally. |
| OMP extension | Not shipped. | Ships `.omp/extensions/gsd-core/` for guardrails, update checks, context warnings, and status behavior. |
| OMP rules | Not shipped. | Installs explicit safe static rules from `gsd-core/omp/rules/manifest.json`. |
| Agent model overrides | No OMP agent frontmatter handling. | Embeds resolved OMP model overrides into generated `.omp/agents/gsd-*.md` frontmatter. |
| Upstream tracking | Owns the main runtime set and release process. | Tracks upstream while keeping OMP as a fork-local integration. |

For operational details, see [OMP Support](docs/omp-support.md).

---

## How it works

Each milestone repeats the same five-step loop, one phase at a time:

1. **Discuss** — capture implementation decisions before anything is planned
2. **Plan** — research, decompose, and verify the plan fits a fresh context window
3. **Execute** — run plans in parallel waves; each executor starts with a clean 200k-token context
4. **Verify** — walk through what was built; diagnose and fix before declaring done
5. **Ship** — create the PR, archive the phase, repeat for the next one

---

## Quickstart

For OMP, install from this fork checkout:

```bash
git clone git@github.com:sh1ny/gsd-omp.git
cd gsd-omp
node bin/install.js --local --omp
```

For a global OMP install, set `OMP_CONFIG_DIR` or let the installer fall back to `~/.omp/agent`:

```bash
OMP_CONFIG_DIR=~/.omp/agent node bin/install.js --global --omp
```

The upstream npm package remains `@opengsd/gsd-core`; use it for upstream GSD Core installs, not for this fork's OMP-only additions.

For non-OMP runtime details inherited from upstream, see [Install on your runtime](docs/how-to/install-on-your-runtime.md).

Once installed, start your first project:

```bash
/gsd-new-project
```

New here? Follow [Your first project](docs/tutorials/your-first-project.md) for a guided walkthrough from install to first shipped phase.

---

## Documentation

**Tutorials** — learning by doing:
- [Your first project](docs/tutorials/your-first-project.md)
- [Onboarding an existing codebase](docs/tutorials/onboarding-an-existing-codebase.md)

**How-to guides** — task-focused recipes:
- [Install on your runtime](docs/how-to/install-on-your-runtime.md)
- [Plan a phase](docs/how-to/plan-a-phase.md)
- [Verify and ship](docs/how-to/verify-and-ship.md)
- … [see all how-to guides](docs/README.md#how-to-guides)

**Reference** — authoritative facts:
- [Commands](docs/COMMANDS.md)
- [Configuration](docs/CONFIGURATION.md)
- [CLI tools](docs/CLI-TOOLS.md)

**Explanation** — concepts and design decisions:
- [Context engineering](docs/explanation/context-engineering.md)
- [The phase loop](docs/explanation/the-phase-loop.md)
- [Architecture](docs/ARCHITECTURE.md)

Full index: [docs/README.md](docs/README.md). Other languages: [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md) · [Português](README.pt-BR.md) · [简体中文](README.zh-CN.md).

---

## Why it works

Most AI-coding setups fail at scale because context bloat silently degrades output quality, there is no shared memory between sessions, and nothing verifies that code actually works. GSD Core solves all three: heavy work runs in fresh subagents, structured artifacts like `STATE.md` and `CONTEXT.md` survive session boundaries, and the verify step walks through what was built and generates fix plans before a phase is declared done. See [docs/explanation/context-engineering.md](docs/explanation/context-engineering.md) for the full reasoning.

Troubleshooting? See [docs/how-to/recover-and-troubleshoot.md](docs/how-to/recover-and-troubleshoot.md).

---

## Related projects

| Project | Purpose |
|---------|---------|
| [open-gsd/gsd-core](https://github.com/open-gsd/gsd-core) | Upstream project tracked by this fork |
| [open-gsd/gsd-pi](https://github.com/open-gsd/gsd-pi) | Upstream's OMP/GSD Pi direction |
| [gsd-opencode](https://github.com/rokicool/gsd-opencode) | Original OpenCode port |
| [Discord](https://discord.gg/mYgfVNfA2r) | Community support |

---

## Star History

<a href="https://star-history.com/#sh1ny/gsd-omp&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=sh1ny/gsd-omp&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=sh1ny/gsd-omp&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=sh1ny/gsd-omp&type=Date" />
 </picture>
</a>

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

<div align="center">

**GSD Core upstream moves fast. GSD OMP keeps it native on Oh My Pi.**

</div>
