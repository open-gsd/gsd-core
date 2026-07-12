---
type: Fixed
pr: 0
---
**Non-frontend phases with `UI hint: no` are no longer blocked by the UI-SPEC gate** — the UI safety gate's token list included the bare token `UI`, which matched GSD's own `**UI hint**: no` metadata line and false-detected a UI, blocking backend/infra phases at /gsd-plan-phase. An explicit `UI hint: yes|no` is now authoritative and the hint line is no longer token-sniffed. (#2150)
