---
type: Fixed
pr: 0
---
**`roadmap analyze` no longer reports zero phases for a checklist-only ROADMAP.md, an ADR's `## N. Locked decisions` section is no longer silently dropped, and `phase complete` no longer folds an unrelated requirement citation from a list item into the wrong phase's Requirements field.** All three are the same class of defect (ADR-4910 section 5): a reader computed real evidence and then discarded it on the way to reporting an empty, success-looking result indistinguishable from "there is nothing here." (#4899) (#4900) (#4837)
