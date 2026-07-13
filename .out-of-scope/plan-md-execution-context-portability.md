# Clone-Portable `<execution_context>` in Committed PLAN.md

GSD does not make the `<execution_context>` block in committed `PLAN.md` files
clone-portable — it does not rewrite the planner's install-relative
`@…/gsd-core/…` references into repository-relative or install-neutral paths so
that a committed plan reads identically across developers, machines, or runtimes.

## Why this is out of scope

PLAN.md is a **machine artifact**, not a human- or clone-facing document — the
same principle that governs [plan-md-human-rendering.md](./plan-md-human-rendering.md)
(from #2158). A committed PLAN.md is a per-run agent instruction set, produced by
`gsd-planner` and consumed in place by `gsd-executor`, `gsd-plan-checker`, and
`gsd-verifier`. There is no documented step in which a plan is read on another
machine after `git clone` without a local GSD install.

Under that model, `<execution_context>`'s `@` references point at the reader's
own local GSD install (Claude `~/.claude/gsd-core/…`, Cursor `.cursor/gsd-core/…`,
or an absolute path for a `--local` install). They are install-relative by design,
and the executor loads those workflows from its own installed copy — it never
consumes the paths a *different* machine wrote into a committed plan.
`/gsd-execute-phase` builds its own `<execution_context>` inline from the
orchestrator's installed workflow (`workflows/execute-phase.md`), so the block a
planner writes into a committed plan does not gate execution anywhere.

Making committed plans clone-portable would treat PLAN.md as a shared
cross-developer document — the boundary #2158 declined to cross — for a block that
no consumer reads across machines.

**Revisit if** GSD introduces a documented cross-developer / cross-machine contract
for committed PLAN.md — a human- or teammate-facing use where plans are read after
`git clone` without a local install — at which point `<execution_context>`
portability becomes in scope.

## Prior requests

- #2238 — "Planner embeds machine-specific gsd-core paths in committed PLAN.md execution_context"

## Related

- `.out-of-scope/plan-md-human-rendering.md` — #2158, the governing "PLAN.md is a machine artifact" precedent.
- `docs/reference/plan-md.md` — the `<execution_context>` reference, which describes the install-relative behaviour.
