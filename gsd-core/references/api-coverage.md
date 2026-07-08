# API Coverage Gate (Full Coverage by Default — Opt Out, Never Opt In)

> Reference for the `api-coverage` gate on the `ai-integration` capability (#1562).
> Config key: `workflow.api_coverage_gate` (default `true`). Gate point: `verify:pre`.

## The problem this closes

"We integrated the API" too often silently means "we integrated whatever the
first use case exercised." Every un-built capability is then an invisible hole,
discovered later by a user who reasonably expected it to work. The phase sealed
green because its tasks completed — nobody *decided* the gaps were acceptable,
because nobody *enumerated* them.

This gate makes the API surface **visible and decided** before the phase can
seal. Full coverage is the default starting position; the coverage matrix is the
*subtraction record*. Every gap is an explicit, reasoned opt-out rather than a
surprise.

## When it fires

The gate runs at `verify:pre` (before `/gsd:verify-work` begins UAT). A phase is
treated as an external-API integration when **either**:

1. a `COVERAGE.md` matrix is present in the phase directory (the planner produced
   one at `plan:pre`), **or**
2. the phase scope shows a strong external-API-integration signal (an integration
   verb co-occurring with an external-API noun, or an explicit `<Service>
   API|SDK|REST|GraphQL` surface) and no matrix yet exists.

Non-API phases (refactors, bug fixes, internal-only work, features that merely
*mention* an existing internal API) do **not** fire the gate — the trigger
requires a compound signal, so a bare word like "api" in "the public API of
UserController" is intentionally ignored.

## The two touch points

1. **Plan time (`plan:pre`).** A contribution to the planner prompts it to run
   the deterministic detector over the phase scope and, when an integration is
   detected, produce `COVERAGE.md`. See
   `capabilities/ai-integration/fragments/api-coverage-plan-pre.md`.
2. **Seal time (`verify:pre`).** The blocking `api-coverage.verify-pre` gate
   runs `check api-coverage.verify-pre <phase-dir>` and blocks unless a valid
   matrix exists (or no integration is detected).

## The coverage matrix format

Canonical form — a markdown table (human-editable, diff-friendly):

```markdown
# API Coverage — <service>

> Full coverage by default. Opt-outs are explicit, reasoned decisions.

| capability | decision | reason |
|---|---|---|
| search | INTEGRATE | |
| playlists | INTEGRATE | |
| skip | OPT-OUT | not needed yet — tracked for follow-up phase |
```

- **`INTEGRATE` is the default.** Every capability starts as INTEGRATE.
- **Every `OPT-OUT` MUST carry a one-line reason** (`not needed`, `not needed
  yet`, `explicitly out of scope`, …). An opt-out without a reason is an
  un-decided hole — the exact failure mode this gate exists to close.
- A fenced ` ```coverage ` JSON block (`[{"capability":…,"decision":…,"reason":…}]`)
  is also accepted for machine-generated matrices.

Rules enforced at seal time: the matrix must be non-empty; every capability name
must be non-empty and unique; every decision must be `INTEGRATE` or `OPT-OUT`;
every `OPT-OUT` must have a reason. Violations block the seal with a precise
error.

## A second integration against the same need

A second platform for an existing capability (e.g. adding YouTube alongside
Spotify for media playback) starts from the **same full-coverage baseline** as
the first. Do not carry over the first integration's opt-outs silently —
re-decide each capability for the new surface, so a first-class/fallback
asymmetry cannot accumulate into a later user-facing bug.

## The matrix persists

`COVERAGE.md` is a phase artifact. A future phase that extends the same
integration starts from the recorded surface and decisions rather than from
zero — the matrix is the durable subtraction record.

## Tuning

- **Disable entirely:** set `workflow.api_coverage_gate: false` in
  `.planning/config.json` (the gate unregisters from `verify:pre`).
- **Widen the trigger vocabulary:** the detector accepts `--verbs` / `--nouns`
  overrides (see `capabilities/ai-integration/fragments/api-coverage-plan-pre.md`).
  The default vocabulary is additive-only.

## Detector CLI

```bash
echo "$PHASE_SCOPE" | node gsd-core/bin/lib/api-coverage.cjs --json
# exit 0 = integration detected, 1 = none, 2 = startup error
```

The detector is a pure function (`detectApiIntegration` → `{ detected, signals,
terms }`) shared by the plan-time prompt and the seal-time gate, so the
low-false-positive guarantee is testable rather than a judgment call.
