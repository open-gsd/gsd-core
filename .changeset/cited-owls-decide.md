---
type: Fixed
pr: 5466
---
**plan-checker no longer passes research questions the researcher marked resolved itself** — Dimension 11 passed on a `(RESOLVED)` heading suffix that the phase researcher could write over its own open questions. Each question RESEARCH.md leaves needing an answer or a ruling, under any heading or in prose, now needs a `D-NN` decision under the phase's CONTEXT.md `<decisions>` that answers it; the checker reports any other question as a blocker. The fix is to cite a decision already on record. Otherwise plan-phase asks the user and records the answer as a `D-NN`, or the user rules in `/gsd-discuss-phase` and re-runs the researcher with `/gsd-plan-phase --research`. The researcher is told never to mark its own questions resolved. (#5438)
