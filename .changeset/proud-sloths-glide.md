---
type: Fixed
pr: 1574
---
**OpenCode and other AGENTS-native runtimes now get a root `AGENTS.md` from `/gsd:new-project`** — the workflow hardcoded a codex-only branch that sent every other runtime to `.claude/CLAUDE.md`, a location OpenCode never loads. A shared `getProjectInstructionFile(runtime)` policy (claude→`.claude/CLAUDE.md`, codex/opencode/kilo/kimi→`AGENTS.md`, copilot→`.github/copilot-instructions.md`, antigravity/gemini→`GEMINI.md`) is now the single source of truth consumed by both the new-project workflow and the generate-claude-md path, with a parity test guarding drift.
