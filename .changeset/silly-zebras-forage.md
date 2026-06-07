---
type: Fixed
pr: 817
---
**`/gsd:surface` no longer corrupts installed skill paths** — re-surfacing (profile/enable/disable/reset) now applies the same per-runtime path rewrites as install, so SKILL.md bodies keep the correct install target instead of reverting to the converter's default `~/.claude` paths.
