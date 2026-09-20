---
type: Removed
pr: 4716
---
**Retired the Gemini CLI reviewer lane** — Google stopped serving Gemini CLI for free/Pro/Ultra on 2026-06-18, so `/gsd-review --gemini` spawned a binary that no longer answers for most users. The `--gemini` flag, its three `review.*.gemini` config keys, and its documentation in all five locales are gone; Antigravity's `--agy` lane already covers the Google slot. `gsd config-set review.models.gemini` now reports an unknown key — an existing key in `.planning/config.json` still parses and is simply never read. (#4709)
