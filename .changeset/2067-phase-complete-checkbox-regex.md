---
type: Fixed
pr: 2079
---
**`phase complete` no longer ticks the wrong phase's ROADMAP checkbox** — completing a phase whose number also appears in a later phase's description (e.g. an idempotent re-run of an already-complete phase) used to mark the *wrong* phase done, because the checkbox-matching regex greedily spanned from `]` to any later "Phase N" mention instead of only the immediately-following phase title. (#2067)
