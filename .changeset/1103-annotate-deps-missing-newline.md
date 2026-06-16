---
type: Fixed
pr: 1111
---
**`roadmap annotate-dependencies` no longer fuses the preceding summary line onto the `Plans:` header** — when the match regex's `(?:^|\n)` anchor consumed a leading newline (mid-string match), the replacement dropped it, producing corrupted output like `**Plans:** 3 plansPlans:`. The replacement now re-emits the leading newline when present. (#1103)
