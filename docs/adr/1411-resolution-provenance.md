# Resolution must report provenance, not fall open silently

- **Status:** Accepted
- **Date:** 2026-06-17

## Context

A verb resolves config (or a skill set, or a planning path) from the invoking **cwd / `GSD_WORKSTREAM` / stored workstream pointer**. When that ambient context is "off" — a descendant subdirectory with no `.planning/`, or a workstream with no scoped config — resolution **silently falls open to bare defaults**, the verb **succeeds with empty output and no signal**, and a downstream subagent plans or verifies without its configured context. The gap is invisible: output is still produced.

We have shipped the **same fix-shape ≈11 times** between April and June 2026 — *anchor to the project root* / *fall back to the root config instead of defaults* / *bolt a diagnostic onto one verb*. The recurrence is concentrated, not scattered:

- **`loadConfig` is a 9-patch `try/catch` ladder** (#315, #443, #910, #1683, #2517, #2714, #3023, #3024, #3523). Each "config fell to defaults" bug adds a branch, and **the returned object is the same shape whether it found real config or bare defaults** — so every caller that cares re-detects degradation by sniffing the contents.
- The **agent-skills verb received this exact fix twice in two weeks**: #1374/#1376 (the `warnings[]` field) and then #1366 (PR #1408).
- The diagnostic half is **hand-rolled eight ways across seven files**; the I/O Module's `output()` has no notion of a "degraded" result.
- The walk-up to the project root exists **three-to-four times**; PR #1408 adds a *weaker fourth* (`resolvePlanningCwd`) because the canonical `findProjectRoot` (Project-Root Resolution Module) skips the plain single-repo-descendant case.

### The #1366 trigger

`gsd-tools query agent-skills <agent>` resolved a configured agent's `<agent_skills>` block to **empty** with no diagnostic under two invocation-context drifts: (1) invoked from a descendant subdirectory with no `.planning/`, config fell through to bare defaults → `agent_skills` was `{}`; (2) `GSD_WORKSTREAM` pointed at a workstream with no scoped config → the same fall-through. In both cases the verb exited 0 and emitted an empty block, so a planner/checker subagent planned or verified without its configured skill/rule context, invisibly.

### The generalizing precedent

**ADR-227** established that *input* validation at a trust boundary must check semantic shape, not just type, and surface coercion rather than propagate a contractually-invalid value. This ADR is the analog for the *resolution* side of the same trust boundary: looking a value up from ambient context (cwd, env, a stored pointer) is itself a trust boundary, and **silently substituting defaults when the lookup misses is the resolution-side equivalent of propagating a garbage value** — the caller cannot tell a real answer from a degraded one. CONTEXT.md's *Planning Path Projection Module* already states the rule for the SDK path-projection seam — "invalid workspace context is a validation error at this seam rather than a silent fallback" — but the CJS `loadConfig` never adopted it.

## Decision

Context resolution at a trust boundary — reading config, anchoring to a project root, resolving a workstream — **MUST report its provenance**. A resolver may fall back, but the fallback **must be a visible value, not a silent substitution**. Three sub-rules:

1. **Deterministic anchoring.** Resolve the project root through **one** walk-up module. Resolution MUST NOT depend on an arbitrary descendant cwd. The single owner is the Project-Root Resolution Module; ad-hoc walk-ups (e.g. `resolvePlanningCwd`) are retired into it.
2. **Provenance, not a bare value.** A resolver returns *what* it resolved **and** *where it came from*. Callers branch on the provenance field, never on the resolved contents, to detect degradation.
3. **Visible degradation.** A *configured* input that resolves empty MUST emit a diagnostic. "Not configured" and "configured-but-resolved-empty" MUST be distinguishable in the output contract.

Concretely, the principle binds three seams:

- **Config Loader Module** — `loadConfig` exposes a `ConfigResolution { config, source: 'workstream' | 'root' | 'global-defaults' | 'builtin-defaults', degraded: boolean }`. Introduced additively (`loadConfigResolved`) so the ~16 existing `loadConfig` call sites, SDK parity, and the generated `.cjs` are unaffected until they opt in.
- **Project-Root Resolution Module** — absorbs the nearest-`.planning/` ancestor as a first-class heuristic; `resolvePlanningCwd` and any sibling walk-up are deleted.
- **I/O Module** — a shared `Resolution<T> { value, configured, reason, warnings }` envelope; `output()` carries degradation so the eight hand-rolled `warnings[]` shapes converge on one.

A *configured* input that resolves empty **without** a reason is a CI-guarded regression (grandfather burn-down, mirroring the `no-adhoc-markdown-parsing` rule).

## Consequences

### Bug classes avoided

- **Silent context drop** — a planner/checker subagent planning or verifying without its configured skills (the #1366 / #1374 class).
- **N callers re-sniffing** — every consumer re-deriving "did this fall open?" from config contents instead of reading one field.
- **Walk-up drift** — a fourth or fifth project-root resolver diverging from the canonical one.

### Cost

- `loadConfig`'s result type grows — mitigated by the additive `loadConfigResolved`; callers migrate incrementally.
- One envelope to learn; ~18 verbs migrate onto it across phases P3–P4.

### Tradeoff

As in ADR-227, resolution may still fall back to preserve continuity — a missing workstream config should not abort the verb. The difference is that the fallback is now a **visible value plus an opt-in warning**, never a silent success. Fields where a miss is genuinely fatal may throw; that is a per-call decision, not the general rule.

## Alternatives considered

### Per-verb patching (status quo)

Rejected. The same fix-shape regenerated ≈11 times because each patch fixed one call site without changing the policy that the resolver fails open and hides which branch fired.

### Throw on a resolution miss

Rejected, for ADR-227's reason: throwing breaks pipeline continuity. A missing workstream config must not abort `query agent-skills`. Visible provenance preserves continuity *and* visibility.

### Deterministic anchoring only (no provenance)

Rejected. Fixing cwd/workstream drift removes the most common trigger but leaves callers re-sniffing contents and the diagnostic hand-rolled per verb — the bug class would keep regenerating at the next new consumer.

## Related

- **Epic:** #1411 (Resolution Provenance) · **This ADR (P0):** #1412
- **Supersedes** the tactical fix in PR #1408 (closed) — its `resolvePlanningCwd` and local `AgentSkillsReason`/`AgentSkillsDiagnostics` are redelivered through the seams above in P1–P3.
- **Builds on:** ADR-227 (input validation shape), ADR-0004 (Planning Workspace Module), ADR-0006 (Planning Path Projection Module).
- **Prior recurrences of this class:** #1374/#1376, #1683, #991, #2714, #2638, #3523, #2652, #2791, #2555, #2623, #3196.

## Amendment — 2026-06-18: P3 narrowed (the shared envelope is not a real seam)

The original P3 plan was a single `Resolution<T> { value, configured, reason, warnings }` envelope adopted by `agent-skills`, `capability-state`, and `capability-writer`. An adversarial fit-analysis showed this fails the deletion test: `configured`/`reason` are meaningless for the capability read/mutation verbs, and `capability-writer`'s `errors[]` (operation-not-applied) is load-bearing and cannot fold into `warnings[]` (advisory). The only genuinely shared seam across the three is `warnings: string[]`.

P3 is therefore narrowed to an honest convention rather than a forced generic:

- `Resolution<T> { value, configured, reason, warnings }` (`src/resolution.cts`) is the canonical shape for **config-interpreting read verbs**. `agent-skills` is the first adopter — the `value` field is added additively to its `--json` IR with the flat fields retained for back-compat; `source`/`degraded` remain config-provenance extras.
- Capability verbs keep their existing shapes, named explicitly: read = `{ runtimeConfigDir, capabilities, warnings? }`; mutation = `{ capabilities, warnings, errors }`.
- The shared contract is documented, not forced: read verbs expose `warnings[]`; mutation verbs expose `warnings[]` + `errors[]`; `configured`/`reason` appear only on config-interpreting read verbs.

Recurrence prevention does not depend on a shared envelope — it is delivered by P4's CI guard (a configured input resolving empty must carry a `reason`). (#1416)
