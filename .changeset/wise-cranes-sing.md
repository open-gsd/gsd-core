---
type: Added
pr: 1225
---
**`gsd-tools capability set` — turn capabilities on/off and gate hooks from one command.** Adds the write side of the capability system (ADR-857/ADR-1213): `capability set <id> --on|--off` toggles a capability through the runtime surface (the canonical on/off switch) and `--gate <key>=<true|false>` toggles a hook within an enabled capability, then re-resolves and reports — so disabling a capability is consistent across surface and config ("off means off") as a write-time invariant. `/gsd:settings` capability hook-gates now route through it. (#1213)
