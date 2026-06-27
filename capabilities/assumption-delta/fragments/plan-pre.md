# Assumption-Delta Architecture Checkpoint

> Advisory, non-blocking. Fires **only** when the phase scope shows a singular→plural / required→optional / derived→chosen transition. When it fires, it surfaces ONE identity-model question before the plan is finalized. Most phases will not fire it — that is the point.

## Why this exists

Most quietly-imported architectural debt does not come from a missing upfront design phase. It comes at the *seam*: a later phase introduces a second case (a second platform, auth method, tenant, region, source of truth) and nobody re-asks whether the original abstraction still names the right thing. The phase that adds the second case is exactly the 20-minute conversation that prevents an afternoon of later cleanup.

## Run the detector

The detector is a deterministic scan over the phase scope text. It strips fenced code blocks first, so a trigger word that appears only inside a code snippet does not fire. It returns a typed result: `{ detected, signals[], terms }`. Resolve it through the `assumption-delta scan` query (same phase-section resolver as `roadmap.get-phase`):

```bash
ASSUMPTION_DELTA_JSON=$(gsd_run query assumption-delta scan "${PHASE}" --json 2>/dev/null || echo '{"detected":false,"signals":[],"terms":{}}')
```

> If the phase section cannot be resolved (no `ROADMAP.md` / unknown phase), the query emits `{ "detected": false, ... }` — the checkpoint does not fire. Do not block on it.
>
> Optional tuning — pass `--terms <comma-list>` to replace the curated pluralization cues for this project (the `optional`/`chosen` cues keep their defaults): `gsd_run query assumption-delta scan "${PHASE}" --json --terms second,alternative,fallback`.

## Decision branch

Read `ASSUMPTION_DELTA_JSON`. Act on `detected` only — do **not** pattern-match the human prose.

**If `detected` is `false`:** this phase does not change a core assumption. Skip the checkpoint entirely and continue planning. Do not raise it with the user.

**If `detected` is `true`:** a core assumption may have lost its monopoly. The `signals[]` array tells you which family fired:

| `kind` | What changed | The question to answer |
|---|---|---|
| `pluralization` | A second X was introduced where there was one (second platform / auth method / tenant / region / source of truth) | Does the current primary key / identity model still name the right noun? |
| `optional` | A required / `only` field became optional | Is the field still the right anchor, or has the anchor moved? |
| `chosen` | A derived value became chosen, or a constant became a parameter | Has a configuration decision become a modeling decision? |

Before finalizing the plan, answer this for the user and record the decision explicitly:

> **Promote vs. add-alongside.** The usual correct move when a generalization occurs is to **promote** the new general representation to the primary and **demote** the old specific one to a detail of one variant — *not* to add the new one alongside the still-required old one. Adding alongside silently contradicts the generalized intent (a later variant that does not fit the old primary can be stored but never confirmed as a default).

Record the outcome in the PLAN.md front matter / a `<assumption_delta_decision>` block:

- The **noun** that is now primary (the generalized identity).
- The **decision**: `promote` | `add-alongside` | `no-change`, with a one-line rationale.
- If `add-alongside`: call it out as accepted debt and note what would force a later promote.

## Optional companion: an invariant test

When `detected` is `true`, suggest (do not require) a contract/invariant test that encodes the now-generalized intent — e.g. *"every confirmed default round-trips through the primary use-path, for every supported variant."* That test goes red the instant a future phase reintroduces the singular assumption, so the regression cannot land silently. If the user accepts, add the test as a task in the plan.

## Tuning the vocabulary (optional)

The trigger vocabulary is a curated, additive-only set in `gsd-core/bin/lib/assumption-delta.cjs` (`DEFAULT_ASSUMPTION_DELTA_TERMS`). Bare "or" is intentionally excluded — it is too common in prose and would make the gate fire constantly. To widen or narrow the cues for a project, override at the call site with `--terms <comma-list>` (replaces the pluralization cues; `optional`/`chosen` keep defaults). The whole checkpoint is toggleable via `workflow.assumption_delta` in `.planning/config.json`.

This checkpoint is advisory: it informs and records; it never blocks the phase.
