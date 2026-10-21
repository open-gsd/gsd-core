# Pi parity matrix

What each part of a GSD install becomes on [Pi](https://pi.dev), checked against the shipped sources by `tests/pi-parity-matrix.test.cjs`. The test installs GSD for Pi into an empty directory and fails when a command, workflow, agent role or hook that Claude Code ships has no Pi counterpart and no recorded disposition below. A disposition that stops being true fails the same test.

## Summary

| Surface | Claude Code ships | On Pi | Not available on Pi |
|---|---|---|---|
| Commands | 72 | 72 skills, run as `/skill:gsd-<command>` | `/skill:gsd-debug` prints that it is unsupported |
| Workflows | 181 workflow files, including those in subdirectories | all installed under the engine root, each reached through a skill | `debug.md`, which only `/gsd-debug` runs |
| Agent roles | 35 roles and 29 compact variants | 35 roles under `agents/`, run through `gsd_dispatch`; compact variants are not installed | none |
| Hooks | 28 hook scripts, 8 of them for Cursor or Windsurf only | bridged through `tool_call`, `tool_result`, `session_start`, `before_agent_start` and `session_before_compact` | the hooks listed under [Hooks](#hooks) |

The counts are the state at the time of writing; the test, not this table, is the authority.

## Commands

Every `commands/gsd/<name>.md` becomes the Pi skill `gsd-<name>`. A skill whose workflow cannot run on Pi is installed as a stub that prints its reason and stops, so the command is still discoverable instead of missing.

| Pi skill | Disposition | Reason |
|---|---|---|
| `/skill:gsd-debug` | unsupported-on-pi | needs nested dispatch; Pi dispatch is flat |

`gsd_dispatch` runs a role in a child `pi` process that has no dispatch tool of its own, so a role cannot start another role. `/gsd-debug` runs a session manager that starts `gsd-debugger`, which is a second level.

## Workflows

A workflow is reachable on Pi when a runnable Pi skill, an installed role or another reachable workflow names it. Every workflow Claude Code reaches is also reached on Pi except one. The files in `gsd-core/workflows/` that are not Markdown, `section-manifest.json` and the launcher snippet, are not workflows and are not checked.

| Workflow | Disposition | Reason |
|---|---|---|
| `debug.md` | unsupported-on-pi | only `/skill:gsd-debug` runs it, and that skill is unsupported on Pi: needs nested dispatch; Pi dispatch is flat |

## Agent roles

Each non-compact `agents/gsd-*.md` is installed under the Pi config home as a role file with Pi tool names (`read`, `write`, `edit`, `bash`, `grep`, `find`). A Claude tool with no Pi equivalent is dropped from the role and named in a comment. The `.compact.md` variants are not installed because Pi loads the one role file `gsd_dispatch` verifies against the install manifest.

## Hooks

Every hook script has a recorded Pi disposition, and so does every event and script pair in `hooks/hooks.json`. The hooks that are not bridged, or only partly (`gsd-context-monitor.js` is bridged on PreCompact and unsupported on its other events):

| Hook | Claude event | Disposition | Reason |
|---|---|---|---|
| `gsd-check-update.js` | SessionStart | unsupported | its cache is read only by the Claude statusline and update banner; Pi has neither, and Pi installs update through the installer or `pi update` |
| `gsd-update-banner.js` | statusLine | unsupported | renders into the Claude statusline; Pi extensions have no equivalent statusline command |
| `gsd-statusline.js` | statusLine | unsupported | Claude statusLine command; Pi extensions have no equivalent statusline command |
| `gsd-agent-isolation-guard.js` | PreToolUse | unsupported | guards the isolation argument of Claude's Agent call; `gsd_dispatch` has no isolation parameter and a dispatched role runs flat in its own process |
| `gsd-context-monitor.js` | PostToolUse, SubagentStop, Stop | unsupported | reads the context metrics the Claude statusline writes; Pi has no statusline to produce them |
| `gsd-config-reload.js` | FileChanged | unsupported | Pi 1.3.0 has no file-change event for extensions |
| `gsd-check-update-worker.js`, `gsd-node-runner.sh` | none | internal | helpers of other hooks, not events |
| `gsd-cursor-*.js`, `gsd-windsurf-*.js` | none | not-applicable | hooks for Cursor and Windsurf only |

The bridged hooks, the Pi event each one uses and the verified Pi event contract are in [Pi hook and lifecycle parity](pi-hook-parity.md).

## Related

- [How GSD runs on Pi](../explanation/how-gsd-runs-on-pi.md)
- [Start a GSD workflow from Pi](../how-to/start-a-gsd-workflow-from-pi.md)
- [Per-runtime skill mapping matrix](skill-mapping-matrix.md)
