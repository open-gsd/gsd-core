---
type: Fixed
pr: 1909
---
Fixed: a hand-authored non-inferable backstop truth with a stray trailing space or surrounding quotes no longer silently grades green — it correctly abstains (insufficient_spec), restoring the #1154 honest-verifier guarantee.
