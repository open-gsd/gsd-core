---
type: Fixed
pr: 512
---
**`/gsd:update` now detects local Antigravity (`.agent`) installs** — local Antigravity installs live in `./.agent/`, but the update detection cascade in `update.md` only knew the global `.gemini/antigravity{,-ide,-cli}` layout, so a local install was misclassified as `claude` and refreshed Claude artifacts instead. `.agent` → antigravity is now mapped across all four runtime-dir surfaces (path classifier, `RUNTIME_DIRS`, local-scope discovery loop, and the post-update cache-clear loop). (#503)
