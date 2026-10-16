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

**Run a count/match gate before it ships (#4927).** A gate you author — or one a `RESEARCH.md`
hands you — that counts or matches text (`grep -c`, `grep -q`, `rg`, `test -n "$(grep …)"`) is a
claim about the tree, and two defects are invisible to reading and take one command to expose. You
have a shell when you author the plan, so run each such gate against the **current tree** and write
the pre-change result next to it as its baseline (`# baseline at HEAD: 0`):

- **It already passes at HEAD.** `grep -c "Agent" .planning/PROJECT.md` returned `6` before any work
  existed, because the word sat in an unrelated row — the gate measures nothing and passes whether
  or not the work happens. Fix the gate: anchor it to the new heading, key, or line the task
  creates, or assert a delta from the recorded baseline.
- **Its literal can never match the deliverable.** `grep` is case-sensitive, so `grep -c "quickstart"`
  fails on a correct `## Quickstart`. Match the real casing of the text the task writes, or use
  `-i` when casing is not part of the contract.

A gate that is meant to prove a *negative* is checked the other way: it must pass after the work
and its baseline must show the thing was there to remove. Only read-only commands are safe to run
this way — run `grep`/`rg`/`test` gates; do not execute a gate that builds, installs, or writes.

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
