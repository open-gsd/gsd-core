# How to start a GSD workflow from Pi

Run GSD commands such as `new-project` or `plan-phase` from [Pi](https://pi.dev), instead of getting a JSON dump from `/gsd`.

**You need:** GSD installed for Pi (`npx @opengsd/gsd-core@latest --pi --global`, or `--local` for one project), a restarted Pi session, and a model signed in to Pi.

## Start a workflow

1. Run the command as a Pi skill. Every GSD command is installed as `gsd-<command>`:

   ```text
   /skill:gsd-new-project
   ```

   Text after the skill name is passed to the workflow as its arguments, for example `/skill:gsd-new-project --auto`.
2. The skill tells Pi to read the workflow files from your GSD install, then follow them. The paths are written for the scope you installed: `~/.pi/agent/gsd-core/` for a global install (or `$PI_CODING_AGENT_DIR/gsd-core/` when you set that variable), the project's `.pi/gsd-core/` for a local one.
3. Continue with the next command the workflow names, written in the same form, for example `/skill:gsd-plan-phase 1`.

You can also type `/gsd new-project`. For any command that has an installed skill, `/gsd <command> [arguments]` starts `/skill:gsd-<command> [arguments]` for you.

## Get data instead of a workflow

`/gsd` still returns engine data for the scripted families `gsd-tools.cjs` documents (`init`, `state`, `phase`, `progress`, `config-get`, `verify`, and the rest of the list `/gsd` autocompletes), and `gsd_invoke` is unchanged, so scripts keep working. Every other command name that has an installed skill (for example `help`, `settings`, `health`, `stats`, `update`) starts its workflow instead of printing data.

`/gsd init <workflow>` returns the init data a workflow consumes, and its output ends with the line to run the workflow:

```text
Next: run /gsd new-project (or /skill:gsd-new-project) to start the new-project workflow — this output is only its init data.
```

## Agent steps on Pi

Pi has no subagent primitive of its own, so GSD installs one: the `gsd_dispatch` tool. When a workflow reaches a step that spawns a `gsd-*` agent, Pi calls `gsd_dispatch` with the role name and the task text. The installer rewrites each workflow's `Agent(...)` call to this form, and installs the role files under `~/.pi/agent/agents/` (or the project's `.pi/agents/` for a local install). With `pi install npm:@opengsd/gsd-core` the roles ship in the package (`pi/package-agents/`) and are rendered for the package location when a role starts.

Each dispatch starts a separate `pi` process that runs the role with its own prompt and tools, and returns the role's final answer to the workflow. Dispatches run one at a time, in the order Pi calls them.

Limits:

- **One level deep.** A dispatched role has no `gsd_dispatch` tool, so a role cannot spawn another role. `/gsd-debug` on Claude runs a session manager (`gsd-debug-session-manager`) that spawns `gsd-debugger`, so on Pi the skill never dispatches the manager: the Pi session runs the manager's loop itself and dispatches only `gsd-debugger`. See [Debug a bug from Pi](#debug-a-bug-from-pi).
- **No per-call model or background run.** The role uses the model of the Pi session that dispatches it, and a dispatch blocks until the role finishes.
- **GSD roles only.** The one workflow step that asks for the host's generic `general-purpose` agent (the assumptions mode of `/skill:gsd-discuss-phase`) has no role file, so `gsd_dispatch` refuses it with `role-unresolved` and the skill stops that step.
- **Installed roles only.** `gsd_dispatch` reads the role from your GSD install, never from the project's `.pi/agents/`, and refuses a role file that no longer matches the install's manifest.

If a dispatch fails, `gsd_dispatch` returns an error result and the skill tells Pi to stop that step and report it; it does not run the role's work itself. The error reads `gsd_dispatch <code>: <message>`:

| Error | Meaning | What to do |
|---|---|---|
| `role-unresolved` | The role name is malformed or not in the install | Reinstall GSD for Pi; check the name in the workflow. |
| `role-tampered` | The installed role file differs from the install manifest | Reinstall GSD for Pi. |
| `pi-not-found` | `pi` is not on the `PATH` of the Pi session | Make `pi` runnable from the shell Pi was started from. |
| `depth-exceeded` | A dispatched role tried to dispatch again | Expected on Pi; use a runtime with nested dispatch for that workflow. |
| `child-failed` | The child `pi` exited non-zero or ended in an error; the message ends with its stderr tail | Read the stderr tail; fix the model sign-in or the task and run the step again. |
| `timeout` | The role ran past the 30-minute dispatch limit, or Pi cancelled the call, and the role was stopped | Split the task, then run the step again. |

## Debug a bug from Pi

Every `/gsd-debug` form runs on Pi:

```text
/skill:gsd-debug list
/skill:gsd-debug status <slug>
/skill:gsd-debug continue <slug>
/skill:gsd-debug --diagnose <description>
/skill:gsd-debug <description>
```

`list` and `status <slug>` read `.planning/debug/` and start no agent. The other forms create or resume a session file there and run the checkpoint loop in your Pi session: the session dispatches `gsd-debugger` with `gsd_dispatch`, reads what it returns (a root cause, a TDD checkpoint, a checkpoint that needs you, an inconclusive investigation, a fix the guardrail rejected, or completion) and acts on it. What differs from Claude:

- **Questions are plain-text.** Pi has no structured question tool, so the session prints the question and its numbered options, ends its turn and waits for your reply. Type the number or your answer.
- **State is in the session file.** The loop keeps `goal`, `tdd_mode`, `tdd_phase`, `resume_count`, `awaiting`, `question` and `last_next_action` in the `## Session Loop` section of `.planning/debug/<slug>.md`, so `/skill:gsd-debug continue <slug>` resumes a session after Pi lost its context, including one waiting on your answer. The file exists once the five symptom answers are in; until then the answers live only in the conversation.
- **`--diagnose` stops at the root cause.** It prints the Root Cause Report and offers no fix; the session file is kept.
- **No specialist review.** The specialist skills that the Claude session manager invokes after a root cause (TypeScript, Swift and the like) are Claude skills, so the review step is skipped.
- **A dispatch error stops the loop.** `gsd_dispatch <code>: <message>` is printed, nothing is committed, and `continue <slug>` resumes the session.
- **Unrecognized returns are retried three times.** After three re-dispatches, or two that leave `next_action` unchanged, the session prints a blocker report.

## If it does not start

| What you see | Why | What to do |
|---|---|---|
| `/skill:gsd-new-project` is not offered when you type `/skill:` | Pi was not restarted after the install, or `enableSkillCommands` is `false` in your Pi settings | Restart Pi. Typing the full command by hand works even when the setting is off. |
| Right after `/gsd new-project`, Pi says `No API key found for the selected model` | The hand-off sent the skill to the model, and Pi has no credential for it | Sign in with Pi's `/login`, then run the command again. |
| `/gsd <command>` prints a `GSD error` from the engine | The command has no installed skill (a `--minimal` or `core` install only installs that profile's skills), so it was sent to `gsd-tools.cjs` as a data command | Reinstall without `--minimal`, or run the command from a runtime that has it. |
| `/gsd <command>` prints `This pi host cannot start a skill from /gsd. Run /skill:gsd-... to start ...` | An older Pi without `sendUserMessage` | Type the printed `/skill:` command. |
| Pi reports a name collision for `gsd-*` skills | A global and a local install both registered the same skill names; Pi keeps the first it loads | Harmless. Remove one of the two installs to silence it. |

To confirm what was installed, `ls ~/.pi/agent/skills` (or `.pi/skills` for a project install) lists `gsd-*` directories, each with a `SKILL.md`.
