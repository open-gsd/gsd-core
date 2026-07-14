---
type: Added
pr: 2183
---
**Opt-in git branch and working-state segment in the statusline** — the shell prompt's branch/dirty-state signal is hidden for the whole session under the Claude Code TUI, so wrong-branch commits and ship-time push rejections surface only after the fact. New `statusline.show_git` config (default `false`) renders the branch name plus staged/unstaged/untracked/ahead/behind markers (or ✓ when clean and in sync) after the directory segment. When disabled, no git subprocess is spawned and output is unchanged. (#2163)
