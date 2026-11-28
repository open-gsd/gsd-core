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
#### Why smart discuss classifies questions

The reasoning — why most questions stop being prompts, why the tie-breaks lean toward asking, and why there is no confirmation gate — is in [About autonomous decision classification](../explanation/autonomous-decision-classification.md).