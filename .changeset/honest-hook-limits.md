---
type: Fixed
pr: 6756
---
**The hook safety properties in `docs/ARCHITECTURE.md` now match the hook sources** — the stdin timeout is 3 s, 5 s, 8 s or 10 s depending on the hook rather than 3 s for all, enforcement hooks take a declared crash policy instead of always exiting silently, and the hooks table states the `hooks.community` opt-in and the injection scanner's WebFetch and WebSearch scope. (#6755)
