<!-- PHASE-ID-CONVENTION:START -->
Resolve phase_id_convention independently of phase_naming. Use returned paths; never derive them from display labels.
Use CLI display_id when present; otherwise use reference grammar. Before emitting identities, Read `~/.claude/gsd-core/references/phase-id-convention.md`.
<!-- PHASE-ID-CONVENTION:END -->

Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

# Checkpoint heartbeats (#2410)

Stream-idle-timeout prevention. The host `execute_waves` step emits each line below
at its own boundary; this file holds why they exist and the full format.

Multi-plan phases can accumulate enough subagent context that the Claude API
SSE layer terminates with `Stream idle timeout - partial response received`
between a large tool_result and the next assistant turn (seen on Claude Code
+ Opus 4.7 at ~200K+ cache_read). To keep the stream warm, emit short
assistant-text heartbeats — **no tool call, just a literal line** — at every
wave and plan boundary. Each heartbeat MUST start with `[checkpoint]` so
tooling and `/gsd:manager`'s background-completion handler can grep partial
transcripts. `{P}/{Q}` is the phase-wide completed/total plans counter and
increases monotonically across waves. `{status}` is `complete` (success),
`failed` (executor error), or `checkpoint` (human-gate returned).

```
[checkpoint] phase {PHASE_NUMBER} wave {N}/{M} starting, {wave_plan_count} plan(s), {P}/{Q} plans done
[checkpoint] phase {PHASE_NUMBER} wave {N}/{M} plan {plan_id} starting ({P}/{Q} plans done)
[checkpoint] phase {PHASE_NUMBER} wave {N}/{M} plan {plan_id} {status} ({P}/{Q} plans done)
[checkpoint] phase {PHASE_NUMBER} wave {N}/{M} complete, {P}/{Q} plans done ({wave_success}/{wave_plan_count} ok)
```
