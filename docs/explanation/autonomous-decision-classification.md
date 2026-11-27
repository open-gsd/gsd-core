# About autonomous decision classification

Why `/gsd-autonomous` decides some discuss-phase questions itself and asks about others, and why the boundary sits where it does. The behavior contract is the `REQ-AUTO-06` requirement in the [Autonomous Mode](../FEATURES.md#11-autonomous-mode) entry and the [autonomous command](../COMMANDS.md); this page carries the reasoning.

## Why most questions stop being prompts

Most discuss questions in an autonomous run are cheap technical choices — where a helper lives, what an internal field is called — that users accept almost every time. Prompting for each one added latency without adding judgment, while preference questions arrived already biased by a "Recommended" label. Smart discuss therefore interrupts only where the user's input changes the outcome: decisions that are hard to undo (they reuse the `costly` / `one-way` ratings of the planner's reversibility taxonomy) and questions with no objectively better answer.

## Why the tie-breaks lean toward asking

A question that might be hard to reverse is asked, because a wrongly auto-decided one-way door is far more expensive than one extra prompt. For the same reason, the planner does not treat `### Decided autonomously` entries as human-settled: if one turns out to be `one-way`, the planner still inserts a checkpoint before implementing it.

## Why there is no confirmation gate

Nothing is decided silently. Every autonomous decision is listed on screen, recorded in `CONTEXT.md` under `### Decided autonomously` and in `DISCUSSION-LOG.md` as an `[auto]` line, and can be reversed before planning. There is no confirmation gate, because a gate would bring back the prompt this removes.

---

## Related

- [Interview vs assumptions mode](../workflow-discuss-mode.md)
- [The phase loop](the-phase-loop.md)
- [Multi-agent orchestration](multi-agent-orchestration.md)
