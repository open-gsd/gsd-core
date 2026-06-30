---
type: Fixed
pr: 1815
---
**`gsd-graphify-update.sh` now reads the full multi-line command in Gate 2 (#1772)** — the PostToolUse auto-update hook joined `tool_name` + `\n` + `tool_input.command` and extracted the command with `sed -n '2p'` (line 2 only). Agent runtimes (Claude Code's Bash tool among them) routinely emit HEAD-advancing commits as multi-line scripts (`cd /path`, then `git add`, then `git commit …`), so line 2 was the `cd`, Gate 2's `*"git commit"*` match failed, and the rebuild silently no-op'd on real commits even with `graphify.auto_update: true`. The failure was invisible in manual probes because a single-line `git commit -m x` passes line 2 verbatim. The hook now captures line 2 through EOF (`sed -n '2,$p'`) so the `case` glob sees the full command string; single-line behavior is unchanged and multi-line commands without a HEAD-advancing op still no-op cleanly.
