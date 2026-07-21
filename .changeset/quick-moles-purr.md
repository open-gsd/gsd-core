---
type: Changed
pr: 2493
---
**The `claude` reviewer in `/gsd:review` no longer inherits your CLAUDE.md or auto-memory** — the leg is now dispatched with a per-invocation `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, so it reviews the same self-contained prompt the gemini and codex legs already receive. It was previously the only reviewer additionally seeing your global CLAUDE.md, the project CLAUDE.md, and Claude Code auto-memory — a context asymmetry against the workflow's own independent-review premise, and a measured ~4k extra input tokens per spawn. Affects `/gsd:review` (and the convergence flow that reuses it) invoked from a non-Claude-Code runtime; inside Claude Code the claude leg already self-skips for independence. (#2483)
