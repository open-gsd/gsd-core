---
type: Added
pr: 2205
---
**GSD is now installable on pi** — `npx @opengsd/gsd-core --pi` installs the GSD extension to `~/.pi/agent/extensions/gsd.cjs`, and `/gsd <family> <subcommand>` now dispatches real commands through the embedded engine (the reference binding previously could only run `query help`). Drives pi through the negotiated imperative Host-Integration adapter, with active-model steering and the full pi lifecycle-event surface. (#2102)
