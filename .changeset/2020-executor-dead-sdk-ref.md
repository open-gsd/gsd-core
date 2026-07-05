---
type: Fixed
pr: 2027
---
**Removed dead SDK file references from runtime-loaded markdown that triggered an infinite `find.exe` storm on Windows** — `agents/gsd-executor.md` pointed at `sdk/src/query/QUERY-HANDLERS.md` and `gsd-core/workflows/reapply-patches.md` at `sdk/dist/cli.js`, both retired with the SDK package (ADR-0174). AI runtimes that resolve doc references by filesystem search ran `find / -iname …`; on Git Bash for Windows `/` maps to the drive root, so `find.exe` traversed the whole disk (14h+, orphaned processes, 4M+ open handles each, unkillable). The references now resolve to live paths, and a new regression guard asserts no `sdk/src|sdk/dist|sdk/handlers` file references remain in agents/workflows/references markdown. (#2020)
