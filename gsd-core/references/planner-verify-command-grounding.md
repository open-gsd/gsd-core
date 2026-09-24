# Verify Command Grounding (#2401)

> Reference file for gsd-planner agent. Loaded on-demand via `@` reference.

**Inherit the command that already worked.** The planning context carries
`prior_verify_commands` — the `<automated>` commands from the most recent prior phase that had
any, surfaced **at every context window**, not only on 1M-class models. When this phase's build
or test story is the same one a prior phase already proved, **reuse that command verbatim**
rather than re-deriving a path. Re-invention is what produced `cd ../../frontend && npm run
lint` against a directory that holds no `package.json`, and cost two revision cycles.

Ground every path you do author: a command's `cd` target or `npm --prefix` target must be a
directory that exists (or that an earlier task in this phase creates) and, for an npm/make
command, must hold the matching `package.json`/`Makefile`. `npm --prefix <dir> run <script>` is
preferred over `cd <dir> && npm run <script>` — it does not depend on the executor's cwd. If
`prior_verify_commands` is empty and you cannot ground a path, say so in the plan instead of
guessing one.

**Root-relative, never absolute (#4767).** The paths in your prompt's `<required_reading>` are
absolute on purpose — a subagent's cwd may differ from the orchestrator's (#2376). That rule
covers prompt *inputs* only. Every path in the plan *body* — `<files>`, `<verify>`, `<automated>`,
task actions — is repo-root-relative, and every `<automated>` command assumes cwd at the checkout
root. An absolute path copied from the prompt into `<automated>` pins the command to the
orchestrator's checkout; under worktree isolation the executor's checkout is a different
directory, so the command `cd`s into the main tree, finds it, runs, and **passes against code the
worktree changed and the main tree did not**. The path probe reports such a target as
`outside_root` (a warning), but only when the target is outside the *orchestrator's* root — an
absolute path *inside* it is exactly the shape that passes the probe and still misfires under
isolation. The authoring rule is the fix; the probe is the backstop. It binds `prior_verify_commands`
too: a harvested command that carries an absolute path is re-rooted before reuse, never copied
verbatim — it "worked" in a run that may have been verifying the wrong checkout.
