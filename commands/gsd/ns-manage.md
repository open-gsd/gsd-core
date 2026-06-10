---
name: gsd-manage
description: "config workspace | workstreams thread update ship inbox"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [config, workspace, workstreams, thread, pause-work, resume-work, update, ship, inbox, pr-branch, undo, cleanup, health, manager, settings, stats, surface, help]
---

Route to the appropriate management skill based on the user's intent.
`gsd-config` (settings + advanced + integrations + profile) and `gsd-workspace`
(new + list + remove) are post-#2790 consolidated entries.

| User wants | Invoke |
|---|---|
| Configure GSD settings (basic / advanced / integrations / profile) | gsd-config |
| Manage workspaces (create / list / remove) | gsd-workspace |
| Manage parallel workstreams | gsd-workstreams |
| Continue work in a fresh context thread | gsd-thread |
| Pause current work | gsd-pause-work |
| Resume paused work | gsd-resume-work |
| Update the GSD installation | gsd-update |
| Ship completed work | gsd-ship |
| Process inbox items | gsd-inbox |
| Create a clean PR branch | gsd-pr-branch |
| Undo the last GSD action | gsd-undo |
| Archive accumulated phase directories | gsd-cleanup |
| Diagnose planning directory health | gsd-health |
| Open the interactive command center | gsd-manager |
| Configure workflow toggles and model profile | gsd-settings |
| Show project statistics | gsd-stats |
| Toggle which skills are surfaced | gsd-surface |
| Show the GSD command guide | gsd-help |

Invoke the matched skill directly using the Skill tool.
