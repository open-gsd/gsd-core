# Plan-Checker Dimension 11: Research Resolution

> Read by `agents/gsd-plan-checker.md` from its Dimension 11 section when the phase has a RESEARCH.md.
> The dimension's two BLOCKER examples stay in the agent.

Only the user closes a question: discuss-phase or the orchestrator records the ruling as a `D-NN`, never the researcher or planner.

**Process:**
1. Collect every question RESEARCH.md leaves needing an answer or a user ruling before planning, under any heading, in prose or a list, whatever status it claims (resolved, decided, closed). Not one: a fact settled with a cited source (no source settles a ruling); a question with a sourced recommendation in an area CONTEXT.md lists under Claude's Discretion; an `[ASSUMED]` fact, even unconfirmed (a ruling is never a fact). None → PASS.
2. A question passes only when every `D-NN` it cites is under CONTEXT.md's `<decisions>`, outside Claude's Discretion, and one answers it.
3. Every other question is a BLOCKER, however marked, in any letter case: no `D-NN`; a `D-NN` CONTEXT.md lacks or holds outside `<decisions>`; only `D-NN`s deciding something else; or resting only on a plan, a "planning-time disposition", the research itself, or another agent's output.
4. A `(RESOLVED)` heading suffix is never evidence. No CONTEXT.md: every question is a BLOCKER.

**Example — PASS if `<decisions>` has D-03 and D-04:**
```markdown
## Open Questions

1. **Hash prefix** — RESOLVED (D-03): Use "guest_contract:"
2. **Cache TTL** — RESOLVED (D-04): 5 minutes
```
