# Pi hook and lifecycle parity

What GSD's Claude Code hooks become on [Pi](https://pi.dev). The Pi extension (`pi/gsd.cjs`) runs the same hook scripts as a subprocess bridge, so a guard behaves the same on Pi as on Claude Code where Pi's events allow it.

## Pi event contract (verified on Pi 1.3.0)

Checked by driving a real `pi` with a local OpenAI-compatible fake model that asks for tool calls (`tests/pi-hook-bridge.test.cjs`).

| Event | Payload fields | Result the bridge uses |
|---|---|---|
| `tool_call` | `toolName`, `toolCallId`, `input` (lowercase tool names) | `{ block: true, reason }` stops the call. The model sees `reason` as the tool result. Pi sends no `tool_result` for a blocked call. |
| `tool_result` | `toolName`, `toolCallId`, `input`, `content[]`, `isError` | `{ content }` replaces the model-facing content. The bridge appends advisories as extra text parts. |

Pi inputs the bridge maps to the Claude shape the hook scripts read:

| Pi tool | Pi input | Claude tool | `tool_input` sent to hooks |
|---|---|---|---|
| `write` | `path`, `content` | `Write` | `file_path`, `content` |
| `edit` | `path`, `edits[].oldText/newText` | `Edit` | `file_path`, `old_string`, `new_string` (edits joined with newlines) |
| `read` | `path` | `Read` | `file_path` |
| `bash` | `command` | `Bash` | `command` |
| `grep` | `pattern`, `path`, `glob` | `Grep` | `pattern`, `file_path`, `glob` |
| `find` | `pattern`, `path` | `Glob` | `glob`, `file_path` |

A tool with no row (for example `ls` or `gsd_dispatch`) runs no hook. Pi's default active tools are `read`, `bash`, `edit` and `write`; `grep` and `find` are covered when you enable them.

## Fail-open

Pi blocks a tool whose `tool_call` handler throws, so the bridge never throws. A missing hook script, a spawn error, a timeout, unreadable JSON or an unexpected input all allow the call. A hook blocks only by exiting 2 or printing `{"decision":"block","reason":"..."}`.

## Disposition of every hook

| Hook | Claude event | On Pi |
|---|---|---|
| `gsd-ensure-canonical-path.js` | SessionStart | bridged: `session_start` |
| `gsd-session-state.sh` | SessionStart | bridged: first `before_agent_start`, delivered as a custom message (opt-in `hooks.community`) |
| `gsd-prompt-guard.js`, `gsd-read-guard.js`, `gsd-worktree-path-guard.js` | PreToolUse | bridged: `tool_call` for `write`, `edit` |
| `gsd-write-guard.js` | PreToolUse | bridged: `tool_call` for `write` |
| `gsd-workflow-guard.js` | PreToolUse | bridged: `tool_call` for `write`, `edit`, `bash` |
| `gsd-secret-read-guard.js` | PreToolUse | bridged: `tool_call` for `read`, `grep`, `bash` |
| `gsd-validate-commit.sh` | PreToolUse | bridged: `tool_call` for `bash` (opt-in `hooks.community`) |
| `gsd-read-injection-scanner.js` | PostToolUse | bridged: `tool_result` for `read` |
| `gsd-phase-boundary.sh` | PostToolUse | bridged: `tool_result` for `write`, `edit` (opt-in `hooks.community`) |
| `gsd-graphify-update.sh` | PostToolUse | bridged: `tool_result` for `bash` (opt-in `graphify.auto_update`, off under `CI`) |
| `gsd-context-monitor.js` | PreCompact | bridged: `session_before_compact` |
| `gsd-context-monitor.js` | PostToolUse, SubagentStop, Stop | unsupported: it reads context metrics the Claude statusline writes; Pi has no statusline to produce them |
| `gsd-agent-isolation-guard.js` | PreToolUse | unsupported: it guards the isolation argument of Claude's `Agent` call; `gsd_dispatch` has no such parameter |
| `gsd-config-reload.js` | FileChanged | unsupported: Pi 1.3.0 has no file-change event for extensions |
| `gsd-check-update.js` | SessionStart | unsupported: its cache is read only by the Claude statusline and update banner; Pi updates through the installer or `pi update` |
| `gsd-statusline.js`, `gsd-update-banner.js` | statusLine | unsupported: Pi extensions have no statusline command |
| `gsd-check-update-worker.js`, `gsd-node-runner.sh` | internal | not run on their own |
| `gsd-cursor-*`, `gsd-windsurf-*` | other runtimes | not applicable |

The table is `PI_HOOK_DISPOSITIONS` in `pi/gsd.cjs`; a test fails if a managed hook or a `hooks.json` event has no entry.

## Known limits

- A role run by `gsd_dispatch` starts with `--no-extensions` (ADR-5559), so these guards do not run inside a dispatched role.
- Advisories raised before a tool runs reach the model with that call's result, not before it.
- When `GSD_HOOK_RUNTIME` is set the hooks run under it; otherwise they run under the Node that hosts Pi (`node` when Pi runs under Bun).
