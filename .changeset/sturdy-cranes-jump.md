---
type: Fixed
pr: 0
---
**Installed third-party capability skills now materialize as real slash commands** — a capability could pass every check (`installed: true, surfaced: true, active: true`) and still never exist on disk: the registry layer counted the capability's skill as surfaced, but the file-copy step only ever scanned gsd-core's own bundled commands, so nothing was ever written to the runtime's `skills/` directory and the command was never invocable. Installed capability skills are now staged verbatim from where they live, with first-party skills winning any name collision.
