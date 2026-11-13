---
type: Fixed
pr: 5550
---
**`.planning/state.json` no longer leaves the tree dirty, so `/gsd-ship` stops refusing on it** — the derived cache was rewritten at every boundary command but never ignored, so each run left a modified or untracked file behind; new projects now commit an ignore rule for it, a project that already tracks it is migrated at the next boundary command (with `commit_docs` on), and `/gsd-health` warns (`W031`) about a copy GSD could not untrack. (#5505)
