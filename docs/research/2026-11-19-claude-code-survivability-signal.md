# Claude Code: can GSD tell a one-shot `claude -p` session from an interactive one?

Date: 2026-11-19. Point-in-time record for issue #6119 (part of epic #5969). Base: `next` at
`de0eefe1`. Docs read at code.claude.com on 2026-11-10 and again on 2026-11-19; the sub-agents
passages quoted below were re-read on 2026-11-21.

Question (the spike #6119 asks for first): is there a **documented** host signal that a hook or a
`gsd-tools` child process can read to tell a one-shot `claude -p` session from an interactive one?
If one exists, `dispatch-should-flatten` can keep one-shot sessions inline and let interactive
sessions take the background branch. If none exists, #6119's stated fallback applies: `claude` stays
flattened, and the capability matrix records the ceiling and its knob.

## 1. Why the question matters

Measured on Claude Code 2.1.322 on 2026-11-10, for #6007's merge conditions:

- Under `claude -p`, a backgrounded agent does not finish within the turn. The main turn ends first,
  and the process waits for background work. Its stderr then read: "Background tasks still running
  10m after the last turn (subagent "Plan phase 1: Greet"); stopping them. Set
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely." The background agent was killed and
  the process **exited 0**.
- With `dispatch-should-flatten` forced to `false`, `/gsd-autonomous --interactive --only 1` run under
  `-p` dispatched its plan agent in the background. The ceiling killed it at 644 s, and no `PLAN.md`
  was written.

So if `claude` takes the background branch in a one-shot session, the work can be lost while the run
still reports success.

The ceiling and its knob are documented:

- env-vars, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`: "Ceiling in milliseconds on idle waiting for
  background work, such as subagents and workflows, after the final turn in non-interactive mode with
  the `-p` flag. … Default: `600000`, or 10 minutes. When idle waiting reaches the ceiling, Claude Code
  stops waiting for the remaining background tasks. … Set to `0` to wait indefinitely. Requires Claude
  Code v2.1.182 or later".
- headless, "Background tasks at exit": "Unless a background command that the main conversation
  started is still running, Claude Code stops whatever is still running after 10 minutes of
  continuous idle waiting by default and drops its partial result."
- The exit code after a ceiling drop is not documented. The 2026-11-10 runs measured 0.

## 2. Documented candidates (read 2026-11-19)

| Candidate | What the docs say | Separates `-p`? |
|---|---|---|
| `CLAUDECODE` (env-vars) | "Set to `1` in subprocesses Claude Code spawns (Bash and PowerShell tools, … hook commands, status line commands, stdio MCP server subprocesses)." | No. It is `1` in both. |
| `CLAUDE_CODE_CHILD_SESSION` (env-vars) | "Set to `1` in subprocesses Claude Code spawns via the Bash, PowerShell, and Monitor tools, hook commands, and status line commands." | No. It is `1` in both. |
| `CLAUDE_CODE_SESSION_ID` (env-vars) | The current session id in Bash, hook and MCP subprocesses. | No. |
| Hook input `permission_mode` (hooks) | One of `"default"`, `"plan"`, `"acceptEdits"`, `"auto"`, `"dontAsk"`, `"bypassPermissions"`; Manual arrives as `"default"`. | No. A `-p` run in Manual sends the same `"default"` as an interactive Manual session. |
| SessionStart `source` (hooks) | `startup`, `resume`, `clear`, `compact`, `fork`. | No. No value names print mode. |
| Setup event (hooks) | Fires only for `--init-only`, or `--init` / `--maintenance` with `-p`. | No. It does not fire on a normal `-p` run. |
| Statusline JSON (statusline) | No mode field. | No. |
| Sub-agents page, nested background behavior (sub-agents) | Documents a difference without a readable marker: in an "Interactive terminal session", "a subagent that launches background subagents waits for their results before it finishes"; under "`claude -p` and the Agent SDK", "the spawning subagent waits only for a foreground nested subagent". | No. It describes the two shapes; it gives a session nothing to read. |
| `app.entrypoint` (monitoring-usage) | An OpenTelemetry attribute, "How the session was launched, such as `cli`, `sdk-cli`, `sdk-ts`, `sdk-py`, …", exported only with `OTEL_METRICS_INCLUDE_ENTRYPOINT=true`. | Not readable in-session. Its export to Bash or hook children is not documented. |

A full-text search of the docs export (`code.claude.com/docs/llms-full.txt`) and the changelog found
no mention of `CLAUDE_CODE_ENTRYPOINT` or `CLAUDE_CODE_SESSION_ATTENDED`.

Documented mitigations that remove the loss without detecting anything. Both are set by whoever
launches `claude -p`, not from inside the session:

- `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` waits without a ceiling.
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` removes `run_in_background` from the subagent tool and
  stops Claude Code from moving subagents to the background.

## 3. Measured, not documented

`printenv` in a Bash-tool child process:

| Session | `CLAUDE_CODE_ENTRYPOINT` | `CLAUDE_CODE_SESSION_ATTENDED` | Version |
|---|---|---|---|
| Interactive | `cli` | `1` | 2.1.322 |
| `claude -p`, both variables unset in the launching environment | `sdk-cli` | `0` | 2.1.325 |
| `claude -p`, launched with `cli` / `1` inherited | `sdk-cli` | `0` | 2.1.325 |

The host overwrites both variables in its children, so an inherited value does not leak through. The
interactive row was not re-measured on 2.1.325. On 2026-11-10 the same `CLAUDE_CODE_ENTRYPOINT`
values were measured on 2.1.322 for `-p` as well.

These variables would work as a signal today, but neither is documented, and #6119 and #6007 both
rule out an environment-variable heuristic.

## 4. Verdict

**No documented signal exists.** #6119's fallback applies:

- `claude` stays flattened. `dispatch-should-flatten` prints `true` for `claude` in every session
  shape, which is today's behavior and the fail-closed default.
- Mechanically, that `true` comes from the `claude` descriptor's `backgroundDispatch: false`
  (`capabilities/claude/capability.json`, matrix row `dispatch.backgroundDispatch`), not from any
  survivability logic. That row's quoted evidence, and the `maxDepth: 5` row's, no longer appear on the
  live sub-agents page ("up to three layers below the main conversation"). The verdict rests on that
  row until #6007 corrects it, and #6007 must then keep `claude` at `true` for the reason above.
- The capability matrix's `claude` section records the ceiling, its knob and this record.
- `tests/command-routing-hub.test.cjs` pins the `true` verdict with each measured set of undocumented
  markers. The rows pin the flatten function's output, not survivability; they go red for a heuristic
  keyed on `CLAUDE_CODE_ENTRYPOINT` or `CLAUDE_CODE_SESSION_ATTENDED`, and for any change that flips
  the `claude` verdict to `false`.

#6119's first acceptance criterion (`true` under `-p`, `false` in an interactive session, on a named
version) is therefore not met by this change. It can be met only if a documented signal appears, or
if the maintainer waives the documented-signal rule for a fail-closed allow-list: flatten unless
`CLAUDE_CODE_ENTRYPOINT === "cli"`, with any other or absent value flattening. That choice belongs to
the maintainer, and this record does not implement it.
