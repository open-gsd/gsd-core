---
type: Changed
pr: 823
---
Agent `color:` frontmatter now uses Claude Code's documented named colors (`red`/`blue`/`green`/`yellow`/`purple`/`orange`/`pink`/`cyan`) instead of hex values or the undocumented `magenta`, so the intended per-agent TUI color differentiation renders reliably across the Claude Code runtime. Display-only metadata; no behavior change. (#771)