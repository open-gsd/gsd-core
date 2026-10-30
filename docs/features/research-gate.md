---
id: 71
title: Research Gate
group: v1.32 Features
---

**Part of:** `/gsd-plan-phase`

**Purpose:** Block planning when RESEARCH.md has unresolved open questions, preventing plans built on incomplete information.

**Resolved means user-decided:** an open question counts as resolved only when it cites a `D-NN` decision under the phase's CONTEXT.md `<decisions>`; a mark the researcher wrote itself, a `(RESOLVED)` heading suffix included, does not (plan-checker Dimension 11, #5438).

**Requirements:**
- REQ-RESGATE-01: System MUST scan RESEARCH.md for unresolved open questions before planning begins
- REQ-RESGATE-02: System MUST block plan-phase entry when open questions exist
- REQ-RESGATE-03: System MUST surface the specific unresolved questions to the user

**Process:**
1. **Scan** — Check RESEARCH.md for open questions section with unresolved items
2. **Gate** — Block planning if unresolved questions are found
3. **Surface** — Display the specific open questions requiring resolution
