# Regression-Test Hardening — Shrinking + Oracle + Boundaries

Loaded by `gsd-debugger` via `@-include` from Test-First Debugging (and referenced
from Minimal Reproduction). Extends the regression test from a symptom-check
into a **root-cause check** — which is exactly what the Phase 1A fix-acceptance
guardrail needs to bite.

## Why this exists

The existing Minimal Reproduction + Test-First Debugging steps minimize by hand
and default to a shallow "didn't crash / error gone" assertion. Two failure
modes follow: (1) the regression seed is a noisy, large input that's hard to
reason about and hides the real defect; (2) a weak oracle (implicit "no crash")
passes against a fix that suppressed the symptom without addressing the cause —
and the Phase 1A mutant at the fix site survives because the test asserts the
wrong thing. Three additions, all extending existing steps, close those gaps.

## 1. Shrinking-based repro minimization (input-space bugs)

**When** the bug triggers on a *class* of inputs (not a single hardcoded
value), wrap the failing input in a property and let the framework's **shrinker**
auto-minimize the counterexample:

- **JS/TS** — `fast-check`: declare the property with an `fc.*` generator over
  the input space; on failure the shrinker walks the counterexample down to a
  minimal failing input.
- **Python** — `Hypothesis`: `@given(...)` over the input strategy;
  `shrink()` minimizes automatically; the example database caches it.

**Store the minimized counterexample as the regression seed**, not the original
noisy repro. The minimized seed is comprehensible, exposes the precise defect
shape, and is what the regression test asserts against.

**Degradation (Gall):** no PBT framework available → fall back to the existing
**manual minimization** steps in Minimal Reproduction (strip one piece at a
time). The shrinking step is additive; its absence is logged in Evidence, never
a silent pass. The oracle-classification and boundary steps below are
prompt-level and always apply regardless of framework.

## 2. Explicit oracle classification (before writing the assertion)

Before writing the regression assertion, **state which oracle the test uses**.
Record the type under `Resolution.oracle_type`:

- **Specified** — the spec/contract states the expected behavior directly
  (e.g., "sort returns ascending order"). Strongest.
- **Derived (contract/model)** — derived from a contract or a reference model
  (e.g., compare against a known-good implementation, or a simpler slow-path
  version).
- **Metamorphic** — no precise oracle exists (renderers, optimizers, ML); check
  a *relation* between related inputs (e.g., `f(x)` then `f(reverse(x))` should
  be equal; `process(n)` should equal `process(n-1) + step`). The oracle is the
  relation, not the output.
- **Implicit (crash)** — the only oracle is "doesn't crash / terminates /
  no exception thrown." **This is the weakest oracle.** It proves almost
  nothing about correctness. Never default to it silently — if implicit is the
  best available, state it explicitly and justify why no stronger oracle is
  possible.

The discipline's point: forcing the choice surfaces a weak oracle before the
fix lands, rather than discovering post-hoc that "it didn't crash" was the
entire justification.

## 3. Boundary neighbors (around the fixed equivalence class)

After the fix, generate boundary-adjacent cases **around the fixed defect's
equivalence class** — the single reported value misses the adjacent off-by-one:

- **Off-by-one** — `N-1`, `N`, `N+1` around the boundary the fix touched.
- **Min/max** — `0`, `length`, empty range, the max representable value.
- **Empty / singleton** — `[]`, `[x]`, `""`, `"c"`.

These are not generic edge cases; they are the neighbors of the fixed defect's
equivalence class. They catch the adjacent off-by-one that a single-value
regression seed misses.

## Why this matters for Phase 1A

A minimized seed + a real (non-implicit) oracle is what makes the Phase 1A
fix-acceptance **mutation guardrail bite**: a mutant seeded at the fix site is
killed only if the regression test asserts the *root-cause behavior*, not the
symptom. A noisy seed with an implicit oracle survives mutants — which is the
overfitting failure Phase 1A exists to prevent. These three steps harden the
regression test into a root-cause check.

## Scope boundary (Zawinski's Law)

Three extensions to existing techniques. No new subsystem, no new test framework
mandated (fast-check/Hypothesis are used *when present*; manual minimization
otherwise), no new debug-file section beyond the `oracle_type` field. The
minimized counterexample and the oracle type are recorded under the existing
`Resolution` section.
