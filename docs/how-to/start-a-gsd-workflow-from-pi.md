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

## When a workflow stops at an agent step

Pi has no subagent primitive GSD can dispatch to yet. When a workflow reaches a step that spawns a `gsd-*` agent, the skill tells Pi to stop that step, name the role it needs, and report what was done before it. It does not run the role itself. This is an instruction the model follows, not something the installer enforces. Work completed before that step (files written, config set) stays in place.

What you can do:

- If the workflow marks the step optional, Pi offers to skip it. Say yes and the workflow continues.
- If the step is required, the run stops there. Finish the workflow in a runtime that can dispatch agents (Claude Code, for example); the files written so far are read from `.planning/`, so work started in Pi carries over.
- Agent dispatch for Pi is tracked in [#5559](https://github.com/open-gsd/gsd-core/issues/5559) and epic [#5556](https://github.com/open-gsd/gsd-core/issues/5556).

## If it does not start

| What you see | Why | What to do |
|---|---|---|
| `/skill:gsd-new-project` is not offered when you type `/skill:` | Pi was not restarted after the install, or `enableSkillCommands` is `false` in your Pi settings | Restart Pi. Typing the full command by hand works even when the setting is off. |
| Right after `/gsd new-project`, Pi says `No API key found for the selected model` | The hand-off sent the skill to the model, and Pi has no credential for it | Sign in with Pi's `/login`, then run the command again. |
| `/gsd <command>` prints a `GSD error` from the engine | The command has no installed skill (a `--minimal` or `core` install only installs that profile's skills), so it was sent to `gsd-tools.cjs` as a data command | Reinstall without `--minimal`, or run the command from a runtime that has it. |
| `/gsd <command>` prints `This pi host cannot start a skill from /gsd. Run /skill:gsd-... to start ...` | An older Pi without `sendUserMessage` | Type the printed `/skill:` command. |
| Pi reports a name collision for `gsd-*` skills | A global and a local install both registered the same skill names; Pi keeps the first it loads | Harmless. Remove one of the two installs to silence it. |

To confirm what was installed, `ls ~/.pi/agent/skills` (or `.pi/skills` for a project install) lists `gsd-*` directories, each with a `SKILL.md`.
