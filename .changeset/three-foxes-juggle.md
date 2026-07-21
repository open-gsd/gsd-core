---
type: Added
pr: 2487
---
**GSD now distinguishes Kimi Code (Node CLI) from Kimi CLI (Python) as a separate runtime** — `--kimi-code` installs GSD for Moonshot's Node-based Kimi Code CLI at `~/.kimi-code/` (via `KIMI_CODE_HOME`), distinct from the existing `--kimi` which targets the Python kimi-cli. The new `capabilities/kimi-code/capability.json` EoS descriptor declares Kimi Code's actual dispatch model — 3 built-in subagents (`coder`/`explore`/`plan`), NO custom named subagents, Agent Skills auto-discovery at `~/.kimi-code/skills/`, global `AGENTS.md` at `$KIMI_CODE_HOME/AGENTS.md`, `runtime: "node"` — so the descriptor (not hardcoded install.js branches) carries the per-runtime contract per ADR-1239. This PR is the descriptor-foundation slice: install layout (Agent Skills converter + AGENTS.md writer), `agent-install-check` semantics, `cmdAgentSkills` fallback, install-time decision logic, and migration guidance land in follow-up PRs (#2454 PR 2+).
