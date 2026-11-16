---
type: Fixed
pr: 6252
---
**A decimal phase written `02.1` in its heading and `2.1` in the checklist or progress table is now one phase, not two** — the milestone phase-id scan kept both spellings, so smart-entry reported an inflated position and total (`Phase 5 of 5` for four phases) and the roadmap phase list repeated the phase. The first-seen spelling is kept; custom, letter-suffixed and milestone-prefixed ids keep their own identities. (#5895)
