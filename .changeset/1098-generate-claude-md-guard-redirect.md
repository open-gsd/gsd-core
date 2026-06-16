---
type: Fixed
pr: 1118
---
**`gsd-tools generate-claude-md` no longer clobbers a hand-crafted `CLAUDE.md`, and defaults the Claude-runtime output to `./.claude/CLAUDE.md`** — `/gsd-new-project` wrote a repo-root `CLAUDE.md` full of broad project documentation, overwriting/diluting an existing hand-authored instruction file. Now: (1) an existing instruction file that contains no GSD section markers (a hand-crafted file) is left untouched and the command reports `action: "skipped"` — pass `--force` to overwrite intentionally (the flag was already parsed but ignored); (2) the default output for Claude-family runtimes is `./.claude/CLAUDE.md` (a valid project-scoped memory location) instead of repo-root `./CLAUDE.md`, so generated content does not pollute a repo-root file. The config default (`claude_md_path`), the project config template, and the new-project workflow are aligned to the new location. Codex projects still write `AGENTS.md`. (#1098)
