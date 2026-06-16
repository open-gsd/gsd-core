# Planner Anti-Patterns and Specificity Examples

> Reference file for gsd-planner agent. Loaded on-demand via `@` reference.
> For sub-200K context windows, this content is stripped from the agent prompt and available here for on-demand loading.

## Checkpoint Anti-Patterns

### Bad — Asking human to automate

```xml
<task type="checkpoint:human-action">
  <action>Deploy to Vercel</action>
  <instructions>Visit vercel.com, import repo, click deploy...</instructions>
</task>
```

**Why bad:** Vercel has a CLI. Claude should run `vercel --yes`. Never ask the user to do what Claude can automate via CLI/API.

### Bad — Too many checkpoints

```xml
<task type="auto">Create schema</task>
<task type="checkpoint:human-verify">Check schema</task>
<task type="auto">Create API</task>
<task type="checkpoint:human-verify">Check API</task>
```

**Why bad:** Verification fatigue. Users should not be asked to verify every small step. Combine into one checkpoint at the end of meaningful work.

### Good — Single verification checkpoint

```xml
<task type="auto">Create schema</task>
<task type="auto">Create API</task>
<task type="auto">Create UI</task>
<task type="checkpoint:human-verify">
  <what-built>Complete auth flow (schema + API + UI)</what-built>
  <how-to-verify>Test full flow: register, login, access protected page</how-to-verify>
</task>
```

### Bad — Mixing checkpoints with implementation

A plan should not interleave multiple checkpoint types with implementation tasks. Checkpoints belong at natural verification boundaries, not scattered throughout.

## Specificity Examples

| TOO VAGUE | JUST RIGHT |
|-----------|------------|
| "Add authentication" | "Add JWT auth with refresh rotation using jose library, store in httpOnly cookie, 15min access / 7day refresh" |
| "Create the API" | "Create POST /api/projects endpoint accepting {name, description}, validates name length 3-50 chars, returns 201 with project object" |
| "Style the dashboard" | "Add Tailwind classes to Dashboard.tsx: grid layout (3 cols on lg, 1 on mobile), card shadows, hover states on action buttons" |
| "Handle errors" | "Wrap API calls in try/catch, return {error: string} on 4xx/5xx, show toast via sonner on client" |
| "Set up the database" | "Add User and Project models to schema.prisma with UUID ids, email unique constraint, createdAt/updatedAt timestamps, run prisma db push" |

**Specificity test:** Could a different Claude instance execute the task without asking clarifying questions? If not, add more detail.

## Context Section Anti-Patterns

### Bad — Reflexive SUMMARY chaining

```markdown
<context>
@.planning/phases/01-foundation/01-01-SUMMARY.md
@.planning/phases/01-foundation/01-02-SUMMARY.md  <!-- Does Plan 02 actually need Plan 01's output? -->
@.planning/phases/01-foundation/01-03-SUMMARY.md  <!-- Chain grows, context bloats -->
</context>
```

**Why bad:** Plans are often independent. Reflexive chaining (02 refs 01, 03 refs 02...) wastes context. Only reference prior SUMMARY files when the plan genuinely uses types/exports from that prior plan or a decision from it affects the current plan.

### Good — Selective context

```markdown
<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/phases/01-foundation/01-01-SUMMARY.md  <!-- Uses User type defined in Plan 01 -->
</context>
```

## Scope Reduction Anti-Patterns

**Prohibited language in task actions:**
- "v1", "v2", "simplified version", "static for now", "hardcoded for now"
- "future enhancement", "placeholder", "basic version", "minimal implementation"
- "will be wired later", "dynamic in future phase", "skip for now"

If a decision from CONTEXT.md says "display cost calculated from billing table in impulses", the plan must deliver exactly that. Not "static label /min" as a "v1". If the phase is too complex, recommend a phase split instead of silently reducing scope.

## Comment-Text Discipline (HARD GATE)

> Enforced at plan-write time by `verify.plan-structure` (the `validate_plan` step). Issue #429.

When an `<acceptance_criteria>` or `<verify>` block uses a **negative grep** — `grep -c 'LITERAL' file == 0`, meaning "this literal must NOT appear in the file" — that same `LITERAL` must not appear verbatim anywhere in an `<action>` body. Verbatim code blocks, JSDoc samples, head-comment references, and "what NOT to do" illustrations get echoed into the file the executor writes, so the executor's commit-time gate fails on the *comment text*, not on a real code regression. The work is correct; the gate output is semantically wrong; the executor wastes cycles and learns to distrust the gate.

**The gate:** plan creation FAILS (error, `valid: false`) when a confidently-extracted (quoted) negative-grep literal also appears in an `<action>` block. When the grep literal is unquoted and cannot be extracted unambiguously, the gate WARNS instead of failing (so you still get the plan, with the risk surfaced).

### Bad — JSDoc sample echoes the forbidden literal

```xml
<task>
  <action>
    Add a `?from=` query param to the share link. Do NOT reintroduce the old
    `?from=` referrer hack the JSDoc warned about.   <!-- echoes ?from= -->
  </action>
  <verify><automated>grep -c '?from=' src/animal-detail.tsx == 0</automated></verify>
</task>
```

### Good — rephrase the comment by concept

```xml
<task>
  <action>
    Add the share-link query param. Do NOT reintroduce the legacy referrer hack.
  </action>
  <verify><automated>grep -c '?from=' src/animal-detail.tsx == 0</automated></verify>
</task>
```

### Allowlist escape hatch

When the literal MUST appear in the plan body verbatim — e.g. the plan documents the test file that exercises the gate itself, or the literal is part of the verification command's own grep regex — add a marker on its own line so the gate skips that literal:

```
<!-- planner-discipline-allow: ?from= -->
```

One marker per literal. The marker exempts only the exact literal it names.

## Region-Scoped Negative Gates

> Surfaced at plan-write time by `verify.plan-structure` (the `validate_plan` step), WARN-level. Issue #968.

A **negative grep** — `! grep -Eq 'PAT' file` or `grep -c 'PAT' file == 0` — asserts a construct is absent. `grep` is file-scoped by nature: it has no notion of function or region. This breaks down when a phase splits one file across parallel tasks with legitimately opposite needs for the same construct in different regions:

- **Task A** bans the construct file-wide — a synchronous factory must not block on a refresh: `! grep -Eq 'await .*refresh' app/page.py`.
- **Task B** legitimately requires it elsewhere in the same file — a post-reindex handler must `await bridge.refresh()` to repopulate state.

Both occurrences are real, correct production code in different functions of one file. A file-wide negative grep cannot say "absent in function X, present in function Y", so the two gates are mutually unsatisfiable with a direct call — the executor is pushed into an indirection whose only purpose is to relocate the matched string out of the file (pure gate-appeasement, zero behaviour change). This is distinct from Comment-Text Discipline (#429): there is no comment echo and no allowlist helps — the construct must genuinely be present in one region and absent in another.

**The fix:** region-scope the negative gate so "absent in region X" stops implying "absent file-wide."

### Bad — file-wide ban unsatisfiable against a sibling's real code

```xml
<!-- Task A -->
<verify><automated>! grep -Eq 'await .*refresh' app/page.py</automated></verify>
<!-- Task B (same file, different function) -->
<action>Add a post-reindex handler in app/page.py that awaits bridge.refresh().</action>
<files>app/page.py</files>
```

Task B writing `await bridge.refresh()` trips Task A's file-wide gate, though both are correct.

### Good — scope the gate to the factory region

```xml
<!-- Task A: ban only inside the synchronous factory, not the whole file -->
<verify><automated>! awk '/^def make_page/,/^def /' app/page.py | grep -Eq 'await .*refresh'</automated></verify>
<!-- or a fixed line range -->
<verify><automated>! sed -n '12,40p' app/page.py | grep -Eq 'await .*refresh'</automated></verify>
```

The factory region is asserted clean; the reindex handler elsewhere in the same file keeps its required `await bridge.refresh()`. Both gates pass with no code restructuring. Prefer an AST/structural check or a focused unit test where region extraction is fragile.

### When the split is intentional and unavoidable

If region-scoping is genuinely impractical and the file split is intentional, suppress the warning with a marker naming the pattern:

```
<!-- planner-region-allow: await .*refresh -->
```

One marker per pattern. The marker exempts only the exact pattern it names. Prefer region-scoping over suppression.
