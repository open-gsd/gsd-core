# Pi parity matrix

What each part of a GSD install becomes on [Pi](https://pi.dev), checked against the shipped sources by `tests/pi-parity-matrix.test.cjs`. The test installs GSD for Pi into an empty directory and fails when a command, workflow, agent role or hook that Claude Code ships has no Pi counterpart and no recorded disposition below. A disposition that stops being true fails the same test.

## Summary

| Surface | Claude Code ships | On Pi | Not available on Pi |
|---|---|---|---|
| Commands | 72 | 72 skills, run as `/skill:gsd-<command>` | none; `/skill:gsd-debug` is adapted, see [Commands](#commands) |
| Workflows | 181 workflow files, including those in subdirectories | all installed under the engine root, each reached through a skill | none |
| Agent roles | 35 roles and 29 compact variants | 35 roles under `agents/`, run through `gsd_dispatch`; compact variants are not installed | none |
| Hooks | 29 hook scripts, 8 of them for Cursor or Windsurf only | bridged through `tool_call`, `tool_result`, `session_start`, `before_agent_start` and `session_before_compact` | the hooks listed under [Hooks](#hooks) |

The counts are the state at the time of writing; the test, not this table, is the authority.

## Commands

Every `commands/gsd/<name>.md` becomes the Pi skill `gsd-<name>`. A skill whose workflow cannot run on Pi is installed as a stub that prints its reason and stops, so the command is still discoverable instead of missing.

| Pi skill | Disposition | Runs on Pi | What differs from Claude |
|---|---|---|---|
| `/skill:gsd-debug` | adapted-on-pi | `list`, `status <slug>`, `continue <slug>`, a new session and `--diagnose` | the checkpoint loop runs in the top-level session instead of in `gsd-debug-session-manager`; specialist skill review is not run |

`gsd_dispatch` runs a role in a child `pi` process that has no dispatch tool of its own, so a role cannot start another role. On Claude, `/gsd-debug` runs a session manager (`gsd-debug-session-manager`) that starts `gsd-debugger`, which is a second level. On Pi the skill never dispatches the session manager: the top-level session runs the manager's return-classification loop and dispatches `gsd-debugger` at the one level Pi allows. The loop handles the same six returns as the manager (`ROOT CAUSE FOUND`, `TDD CHECKPOINT`, `DEBUG COMPLETE`, `CHECKPOINT REACHED`, `INVESTIGATION INCONCLUSIVE`, `FIX REJECTED BY GUARDRAIL`), keeps its state (`goal`, `tdd_mode`, `tdd_phase`, `resume_count`, `awaiting`, `question`, `last_next_action`) in the `## Session Loop` section of `.planning/debug/<slug>.md`, and asks its questions as plain text. `--diagnose` ends at the Root Cause Report. No command is installed as a full stub today; a command that lists no workflow to read falls back to one.

## Workflows

A workflow is reachable on Pi when a runnable Pi skill, an installed role or another reachable workflow names it. Every workflow Claude Code reaches is also reached on Pi. The files in `gsd-core/workflows/` that are not Markdown, `section-manifest.json` and the launcher snippet, are not workflows and are not checked.

No workflow carries a disposition: `debug.md` is reached by the adapted `/skill:gsd-debug`.

## Agent roles

Each non-compact `agents/gsd-*.md` is installed under the Pi config home as a role file with Pi tool names (`read`, `write`, `edit`, `bash`, `grep`, `find`). A Claude tool with no Pi equivalent is dropped from the role and named in a comment. The `.compact.md` variants are not installed because Pi loads the one role file `gsd_dispatch` verifies against the install manifest.

## Hooks

Every hook script has a recorded Pi disposition, and so does every event and script pair in `hooks/hooks.json`. The hooks that are not bridged, or only partly (`gsd-context-monitor.js` is bridged on PreCompact and unsupported on its other events):

| Hook | Claude event | Disposition | Reason |
|---|---|---|---|
| `gsd-check-update.js` | SessionStart | unsupported | its cache is read only by the Claude statusline and update banner; Pi has neither, and Pi installs update through the installer or `pi update` |
| `gsd-path-export.js` | SessionStart | unsupported | persists the `gsd_run` directory through `$CLAUDE_ENV_FILE`, which Claude Code provides only to SessionStart, Setup, CwdChanged and FileChanged hooks; Pi has no equivalent env file |
| `gsd-update-banner.js` | statusLine | unsupported | renders into the Claude statusline; Pi extensions have no equivalent statusline command |
| `gsd-statusline.js` | statusLine | unsupported | Claude statusLine command; Pi extensions have no equivalent statusline command |
| `gsd-agent-isolation-guard.js` | PreToolUse | unsupported | guards the isolation argument of Claude's Agent call; `gsd_dispatch` has no isolation parameter and a dispatched role runs flat in its own process |
| `gsd-context-monitor.js` | PostToolUse, SubagentStop, Stop | unsupported | reads the context metrics the Claude statusline writes; Pi has no statusline to produce them |
| `gsd-config-reload.js` | FileChanged | unsupported | Pi 1.3.0 has no file-change event for extensions |
| `gsd-check-update-worker.js`, `gsd-node-runner.sh` | none | internal | helpers of other hooks, not events |
| `gsd-cursor-*.js`, `gsd-windsurf-*.js` | none | not-applicable | hooks for Cursor and Windsurf only |

The bridged hooks, the Pi event each one uses and the verified Pi event contract are in [Pi hook and lifecycle parity](pi-hook-parity.md).

## Live verification

`/skill:gsd-new-project --auto @idea.md` was run on Pi 1.3.0 against a local model (`mlx-community/Qwen3.8-27B-bf16` served by `mlx_lm.server`), in an isolated `HOME` and Pi config directory, with GSD installed by `bin/install.js --pi --global`. The project was an empty git repository containing a one-page brief for a Node command-line todo app.

The run produced, in order, the files and commits a Claude install produces:

| Step | Result |
| --- | --- |
| Workflow load | The skill read its workflow and includes from the Pi install tree. |
| Init and config | `.planning/config.json` written and committed (`chore: add project config`). |
| Project | `.planning/PROJECT.md` written and committed (`docs: initialize project`). |
| Requirements | `.planning/REQUIREMENTS.md` written and committed (`docs: define v1 requirements`). |
| Roadmap | `gsd_dispatch(role="gsd-roadmapper")` ran an isolated child `pi` process, which wrote `ROADMAP.md` (one phase, seven of seven requirements mapped, `**Mode:** mvp`) and `STATE.md`, and returned its final message. Committed as `docs: create roadmap (1 phases)`. |

This is a recorded session, not a CI test. Limits of the run:

- The session was split across several Pi invocations. Earlier invocations stopped on the local server, not on GSD: the context window was too small, the model server ran out of Metal memory, and a long prompt prefill outlasted Pi's client timeout. The roadmap step ran last, in a fresh session started with the earlier files in place.
- `workflow.research` was set to `false` in the project config. With it on, `gsd_dispatch` ran four `gsd-project-researcher` roles one after another (the queue is sequential), and the first two stopped at the 30 minute dispatch timeout on this model with the documented `timeout` error result. That is the tool's fail-closed behavior, observed live; the research files were not produced.
- A smaller model (`Qwen3-8B`) ran the skill but called `gsd_dispatch` with the skill name as the role. The tool refused with `role-unresolved`, which is the documented error for a role that is not installed.

## Live verification: `/skill:gsd-debug`

`/skill:gsd-debug` was run on Pi 1.3.0 against the same local model (`mlx-community/Qwen3.8-27B-bf16`), in an isolated Pi config directory with GSD installed by `bin/install.js --pi --global`, on a three-file Node project whose `mean([])` returns `NaN`. The model server was started from inside Pi with `/mlx-last`. Each Pi invocation was a non-interactive `pi -p` turn that continued the previous session.

| Turn | Input | Result |
| --- | --- | --- |
| 1 | `/skill:gsd-debug --diagnose` with the five symptom fields | Routed to the new-session form, printed the five fields as a plain-text prompt and ended the turn. |
| 2 | `1` (confirm) | Created `.planning/debug/mean-empty-array-nan.md`, dispatched `gsd-debugger` once with `gsd_dispatch`, received `ROOT CAUSE FOUND`, printed the Root Cause Report with no fix offered, and committed the session file. |
| 3 | `/skill:gsd-debug continue mean-empty-array-nan` | Reset `goal` to `find_and_fix` and `resume_count` to 0 in `## Session Loop`, dispatched `gsd-debugger`, received `CHECKPOINT REACHED` (human-verify) after the debugger applied a guard and a regression test, wrote `awaiting` and the full `question` to the file, and ended the turn. |
| 4 | `confirmed fixed` | Dispatched the continuation, archived the session to `.planning/debug/resolved/`, and committed the fix and the session file. |

Limits of the run:

- The dispatched child runs with `--no-extensions`, so the extension-provided model provider was not visible to it and the first dispatch returned `gsd_dispatch child-failed ... No API key found for the selected model`. The skill stopped, printed that error and left the session file in place, as specified. The run then used a static `mlx-local` provider in the Pi `models.json` for the same server, which the child can read.
- The loop state is written by the model, not by code. In one earlier run the model recorded `resume_count: 1` while it reported no re-dispatches.
- This is a recorded session, not a CI test.

## Related

- [How GSD runs on Pi](../explanation/how-gsd-runs-on-pi.md)
- [Start a GSD workflow from Pi](../how-to/start-a-gsd-workflow-from-pi.md)
- [Per-runtime skill mapping matrix](skill-mapping-matrix.md)
