---
type: Fixed
pr: 0
---
**Gating critics now self-disconfirm their own verdict (#5, #25)** — gsd-verifier, gsd-plan-checker and gsd-code-reviewer run a verdict self-check (false-PASS / strongest-counterargument) before finalizing, via a shared verdict-self-check reference. Based on arXiv 2503.06139 (Goal-Reversal), 2507.11662, 2507.10124, 2507.02778.
