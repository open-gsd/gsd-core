---
type: Fixed
pr: 1084
---
Fix the workflow gsd_run launcher being unreachable in later bash blocks on runtimes that run each fenced block in a fresh shell (e.g. Claude Code): ship a standalone gsd-core/bin/gsd_run executable and have the per-file preamble persist the launcher's bin dir onto PATH via CLAUDE_ENV_FILE, with the inline function definition kept as the fallback for all other runtimes.
