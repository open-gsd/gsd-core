---
type: Fixed
pr: 5567
---
**Pi can start GSD workflows** — Pi installed one extension file and no command artifacts, so `/gsd init new-project` printed init JSON and stopped. Every GSD command now installs as a Pi skill (`/skill:gsd-new-project`, `/skill:gsd-plan-phase`, …), `/gsd <command>` starts the matching skill, and `/gsd init <workflow>` ends with the line to run it. Workflow steps that need a named agent role stop with an explicit message on Pi instead of running the role inline. (#5547)
