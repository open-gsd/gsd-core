---
type: Added
pr: 2039
---
**ZCode (Z.ai) is now an installable runtime** — a desktop Agentic Development Environment for the GLM-5.2 model can now be targeted with `--zcode`, landing GSD skills at `~/.zcode/skills/<name>/SKILL.md` plus slash commands and subagents. ZCode ships as a pure declarative capability descriptor (`capabilities/zcode/capability.json`) with zero hardcoded `runtime === 'zcode'` branches, reusing the Claude skill converter — the de-hardcoded, data-driven runtime path that 1.7.0 (ADR-1016 / ADR-1239) enables. (#1925)
