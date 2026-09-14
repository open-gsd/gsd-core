---
type: Fixed
pr: 4711
---
**Runtime detection no longer resolves a retired runtime to Claude Code** — workflows still mapped `/.gemini/` and `$GEMINI_CONFIG_DIR` to the `gemini` runtime that was removed in 1.8.0, and an unrecognized id silently falls back to Claude Code's config dir, label, and instruction file. Detection now maps Antigravity's real directories, the runtime menu no longer offers the retired Gemini CLI, and the model-tier table no longer advertises built-in defaults for a runtime the catalog does not define. (#4709)
