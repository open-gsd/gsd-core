---
type: Added
pr: 775
---
**Gemini CLI extension package** — gsd-core now ships a `gemini-extension.json` manifest (plus a `GEMINI.md` context payload) at the repository root, so Gemini CLI users can install, update, and remove GSD through Gemini's own extension lifecycle: `gemini extensions install https://github.com/open-gsd/gsd-core`, `gemini extensions update gsd-core`, `gemini extensions uninstall gsd-core`, and `gemini extensions link <path>` for local dev. The extension is discoverable in `gemini extensions list` and loads GSD's operating context into every session. Additive — the existing `npx gsd-core --gemini` installer (which provides the `/gsd:*` slash commands) is unchanged. (#775)
