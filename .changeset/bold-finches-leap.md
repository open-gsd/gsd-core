---
type: Fixed
pr: 2354
---
**OpenCode's first-time install baseline now protects pre-existing files under the `commands/` directory, not just the legacy `command/` alias** — after #2329 moved OpenCode command materialization to `commands/`, the baseline scan that guards a machine's very first GSD-tracked install still only knew about the legacy `command/` directory, so a pre-existing, unrelated `commands/gsd-*.md` file was silently deleted by ordinary command materialization instead of blocking the install for an explicit keep/remove choice — the same protection `command/` already had. The scan now covers both directories. Kilo is unaffected and keeps using `command/`.
