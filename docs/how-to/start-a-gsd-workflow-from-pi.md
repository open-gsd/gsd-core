# How to start a GSD workflow from Pi

Run GSD commands such as `new-project` or `plan-phase` from [Pi](https://pi.dev), instead of getting a JSON dump from `/gsd`.

**You need:** GSD installed for Pi (`npx @opengsd/gsd-core@latest --pi --global`, or `--local` for one project) and a restarted Pi session.

## Start a workflow

1. Run the command as a Pi skill. Every GSD command is installed as `gsd-<command>`:

   ```text
   /skill:gsd-new-project
   ```

   Text after the skill name is passed to the workflow as its arguments, for example `/skill:gsd-new-project --auto`.
2. The skill tells Pi to read the workflow files from your GSD install, then follow them. The paths are written for the scope you installed: `~/.pi/agent/gsd-core/` for a global install (or `$PI_CODING_AGENT_DIR/gsd-core/` when you set that variable), the project's `.pi/gsd-core/` for a local one.
3. Continue with the next command the workflow names, written in the same form, for example `/skill:gsd-plan-phase 1`.

You can also type `/gsd new-project`. For any command that has an installed skill, `/gsd <command> [arguments]` starts `/skill:gsd-<command> [arguments]` for you.

## What `/gsd` does with each name

- **Data families** keep their data behavior: the top-level families `gsd-tools.cjs` documents (`init`, `state`, `phase`, `progress`, `config-get`, `verify`, and the rest of the list `/gsd` autocompletes). `gsd_invoke` is unchanged, so scripts keep working.
- **Every other command name that has an installed skill** — for example `help`, `settings`, `health`, `stats`, `update` — now starts its workflow instead of printing data.
- **`/gsd init <workflow>`** still returns the init data a workflow consumes. Its output now ends with the line to run the workflow, for example:

  ```text
  Next: run /gsd new-project (or /skill:gsd-new-project) to start the new-project workflow — this output is only its init data.
  ```

## When a workflow stops at an agent step

Pi has no subagent primitive GSD can dispatch to yet. When a workflow reaches a step that spawns a `gsd-*` agent, the skill tells Pi to stop that step, name the role it needs, and report what was done before it. If the workflow marks the step optional, Pi offers to skip it and continue. It does not run the role itself. This is an instruction the model follows, not something the installer enforces. Work completed before that step (files written, config set) stays in place. Agent dispatch for Pi is tracked in [#5559](https://github.com/open-gsd/gsd-core/issues/5559) and epic [#5556](https://github.com/open-gsd/gsd-core/issues/5556).

## Check what was installed

- `ls ~/.pi/agent/skills` (or `.pi/skills` for a project install) lists `gsd-*` directories, each with a `SKILL.md`.
- If `/skill:gsd-new-project` is not offered in command discovery, restart Pi and check that `enableSkillCommands` is not `false` in your Pi settings. Typing the command by hand still works when it is off.
- A `--minimal` or `core` install only installs the skills in that profile; `/gsd <command>` for a command without an installed skill is sent to `gsd-tools.cjs` as a data command and reports its error if it does not know the name.
