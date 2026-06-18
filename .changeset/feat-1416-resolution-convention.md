---
type: Added
pr: 1425
---
**`agent-skills --json` IR gains an additive `value: { block, skills_count }` field** formalizing the `Resolution<T>` convention for config-interpreting read verbs; no breaking change. The new `src/resolution.cts` module exports `Resolution<T> { value, configured, reason, warnings }` (the canonical envelope) and `makeResolution<T>()` (the builder); `AgentSkillsValue { block, skills_count }` is the first adopter. All existing flat fields (`agent_type`, `block`, `skills_count`, `warnings`, `configured`, `reason`, `source`, `degraded`) are retained for back-compat. Capability-state and capability-writer keep their existing JSON shapes unchanged; only doc comments are added naming them the canonical read-verb and mutation-verb envelopes respectively. The shared seam across all shapes is `warnings: string[]`; a single generic across read+write verbs was rejected by the deletion test (ADR-1411 P3 amendment). (Part of #1411, P3 / #1416.)
