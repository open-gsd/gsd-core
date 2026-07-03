# ADR 1866: agent_skills dual injection — orchestrator-side + agent-side self-load

- **Status:** Accepted
- **Date:** 2026-07-01
- **Issue:** [#1866](https://github.com/open-gsd/gsd-core/issues/1866)

## Context

The documented `agent_skills` injection contract ([Agent Skills Injection](../CONFIGURATION.md#agent-skills-injection)) is **orchestrator-side**: at spawn time, the *workflow* calls `gsd-tools query agent-skills <type>` in its bash init and interpolates the resulting `<agent_skills>` block into the `Task()`/`Agent()` prompt. This is established across ~25 workflows and was extended to the review family by #991 / PR #1005.

Three gaps make orchestrator-side injection insufficient on its own:

1. **`/gsd-autonomous`** delegates plan/execute/review via flat `Skill()` invocations and resolves no `agent_skills` itself — it relies on the delegated workflow's bash init running. On runtimes where `Skill()`-delegated workflow bash does not reliably execute (Cursor; assessed in #1600 / #1601 — "Phase C+D per-platform plugin skill model assessment, all N/A"), the configured skills never reach the consumer agent.
2. **GSD agent definitions** (`agents/gsd-*.md`) discover project skills via `project-skills-discovery.md` but never call `query agent-skills` for the `agent_skills` config map.
3. The gap is **invisible**: output still looks successful, so users who configure `agent_skills` in `.planning/config.json` see no error — the skills are silently ignored (same failure class as #991).

`cmdAgentSkills` (`src/init.cts`) is read-only and idempotent — it exits 0 with an empty block when nothing is configured for a type. So an agent re-invoking it at its own init is safe and zero-overhead for unconfigured types.

## Decision

Adopt a **dual injection** contract. The orchestrator-side path stays as-is (no removal from the ~25 workflows); each of the 22 consumer agents *additionally* self-loads in its mandatory init step.

- A shared reference, [`gsd-core/references/agent-skills-bootstrap.md`](../../gsd-core/references/agent-skills-bootstrap.md), owns the contract: the query, the `Read` step, the per-runtime coverage matrix, and the **dedup guard**.
- Each consumer agent file carries one self-load line naming its own type (e.g. `query agent-skills gsd-executor`) and `@`-including the shared reference.
- **Dedup guard (load-bearing):** if the agent's prompt already contains an `<agent_skills>` block, self-load is skipped. On runtimes where orchestrator-side injection also runs (Claude Code), this prevents the prompt from carrying two copies — a real context-cost regression that the guard closes.

### Why not orchestrator-side only (Lens A)

Extending `autonomous.md` to resolve skills itself (the #991 pattern) fixes the *autonomous-orchestrator* gap but not the deeper one: on Cursor, the agent *definition* is what the runtime loads, and the workflow bash init is the unreliable seam. Agent-side self-load moves the resolution to the agent definition, which is the surface Cursor actually consumes. We retain the autonomous.md documentation note (the workflow no longer needs per-delegation injection) but do not duplicate injection code there.

### Why not remove orchestrator-side injection

The ~25 workflows' injection is the proven, tested path on Claude Code and remains the primary channel there. Removing it would regress the runtime that works today. The dual contract keeps both; the dedup guard makes coexistence cost-free.

## Coverage

| Skill form | Orchestrator-side | Agent self-load |
|---|---|---|
| Project-relative path | all runtimes | all runtimes |
| `global:<name>` | all runtimes | all runtimes |
| `global:<plugin>:<skill>` | Claude only (Skill-tool directive) | Claude only — **not closeable on Cursor** (#1601); no plugin/Skill-tool model exists there |

The `global:plugin:skill` gap on Cursor is **out of scope** for this ADR — it is a runtime limitation, not an injection-contract one.

## Drift guard

Three surfaces share the consumer-agent set: the `CONSUMER_AGENTS` list in `tests/agent-skills.test.cjs`, the agents carrying the bootstrap, and the `query agent-skills <type>` calls in workflows. `tests/agent-skills-bootstrap.test.cjs` asserts the bijection between `CONSUMER_AGENTS` and agents-with-bootstrap (Generative-Fix-Divergence, `CLAUDE.md`), with a `fast-check` property test over the agent file set. Any new consumer agent added without the bootstrap (or vice versa) fails CI.

## Consequences

- **Positive:** `agent_skills` config reaches consumer agents on every runtime regardless of orchestrator bash discipline; the `/gsd-autonomous` + Cursor path works without project-level workarounds.
- **Negative:** Two injection seams to maintain. Mitigated by the dedup guard (no double-load) and the bijection drift-guard test (no silent desync).
- **Neutral:** The documented contract in `CONFIGURATION.md` is updated to describe both paths.

## References

- #991 / PR #1005 — orchestrator-side injection precedent (review family)
- #1258 / #1243 / PR #1261 — cross-runtime skill mapping epic & Claude plugin-skill consumption
- #1366 / #1374 / #1400 / #1410 / #1415 / #1424 / #1425 — `agent_skills` resolver hardening (cwd-drift, diagnostics, provenance, flush)
- #1600 / #1601 — per-platform plugin skill model assessment (Cursor N/A)
