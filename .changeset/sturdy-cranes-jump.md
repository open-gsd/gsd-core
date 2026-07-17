---
type: Fixed
pr: 2340
---
**Installed third-party capability skills now materialize as real slash commands** — a capability could pass every check (`installed: true, surfaced: true, active: true`) and still never exist on disk: the registry layer counted the capability's skill as surfaced, but the file-copy step only ever scanned gsd-core's own bundled commands, so nothing was ever written to the runtime's `skills/` directory and the command was never invocable. Installed capability skills are now staged from where they live, bound to the capability that actually declared and registered them (never inferred from directory listing order), and are subject to the same runtime-targeted body rewrites as first-party skills — first-party skills still win any name collision.
