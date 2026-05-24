---
type: Fixed
pr: 213
---
Add Antigravity 2.x config-dir compatibility by auto-detecting `~/.gemini/antigravity-ide` and `~/.gemini/antigravity-cli` (with legacy `~/.gemini/antigravity` fallback), then routing installer, SDK runtime config resolution, and `/gsd-update` runtime classification through the same detection model.
