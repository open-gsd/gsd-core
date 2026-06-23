---
type: Fixed
pr: 1638
---
**Capability `settings.json` hooks no longer fire on every tool and no longer fail when non-executable** — installing a capability that declared a tool-scoped `PreToolUse`/`PostToolUse` hook wrote the entry with no `matcher`, so a guard intended for only `Write|Edit` fired on every tool call (including `Bash`) and a fail-closed guard could block the whole session; the emitted command was also a bare script path, so a `.js`-family hook delivered via `git`/tarball that lost the executable bit failed with `Permission denied` on every matching call. Install now honors a declared `matcher` (absent = match-all, unchanged for existing capabilities) and emits a `node`-prefixed command for `.js`/`.cjs`/`.mjs` hooks so they run regardless of file-mode bits. (#1634)
