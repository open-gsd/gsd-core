---
type: Added
pr: 2183
---
Opt-in git branch and working-state segment in the statusline (`statusline.show_git`): branch name plus staged/unstaged/untracked/ahead/behind markers, or ✓ when clean and in sync, rendered after the directory segment. Default off; when disabled no git subprocess is spawned and output is unchanged.
