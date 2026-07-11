---
type: Changed
pr: 2190
---
**Windsurf now enforces GSD's write/command safety guards through Cascade's native hook bus** — installing GSD into Windsurf registers blocking `pre_write_code`/`pre_run_command` hooks in `.windsurf/hooks.json` (exit-code-2 blocking) and drives Windsurf's install from its capability descriptor instead of hardcoded runtime branches. (#2100)
