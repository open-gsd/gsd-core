---
id: 11
title: Autonomous Mode
group: Planning Features
---

**Command:** `/gsd-autonomous [--from N]`

**Purpose:** Run all remaining phases autonomously — discuss → plan → execute per phase.

**Requirements:**
- REQ-AUTO-01: System MUST iterate through all incomplete phases in roadmap order
- REQ-AUTO-02: System MUST run discuss → plan → execute for each phase
- REQ-AUTO-03: System MUST pause for explicit user decisions (hard-to-reverse and preference gray areas, blockers, validation)
- REQ-AUTO-04: System MUST re-read ROADMAP.md after each phase to catch dynamically inserted phases
- REQ-AUTO-05: `--from N` flag MUST start from a specific phase number
- REQ-AUTO-06: Smart discuss MUST classify each gray-area question before presenting it: reversible technical questions are decided without a prompt, hard-to-reverse technical questions are asked with a recommendation, and product / UX / preference questions are asked neutrally (#5069)

#### Why smart discuss classifies questions

Most discuss questions in an autonomous run are cheap technical choices — where a helper lives, what an internal field is called — that users accept almost every time. Prompting for each one added latency without adding judgment, while preference questions arrived already biased by a "Recommended" label. Smart discuss therefore interrupts only where the user's input changes the outcome: decisions that are hard to undo (they reuse the `costly` / `one-way` ratings of the planner's reversibility taxonomy) and questions with no objectively better answer.

The tie-breaks deliberately lean toward asking. A question that might be hard to reverse is asked, because a wrongly auto-decided one-way door is far more expensive than one extra prompt. For the same reason, the planner does not treat `### Decided autonomously` entries as human-settled: if one turns out to be `one-way`, the planner still inserts a checkpoint before implementing it.

Nothing is decided silently. Every autonomous decision is listed on screen, recorded in `CONTEXT.md` under `### Decided autonomously` and in `DISCUSSION-LOG.md` as an `[auto]` line, and can be reversed before planning. There is no confirmation gate, because a gate would bring back the prompt this removes.
