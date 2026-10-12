---
type: Added
pr: 5342
---
**OpenCode 2.x support in the GSD plugin (epic #5331, Phase 1)** — the OpenCode plugin now loads on OpenCode 2.x as well as 1.x and runs the same guards on both (including the 2.x `shell` and `patch` tools), detects the installed OpenCode generation, and avoids the 1.x-only `--dir` and `--variant` flags on 2.x. Plugin hooks now start under Node instead of the OpenCode executable, which had left the guards silently inactive (#4849).
