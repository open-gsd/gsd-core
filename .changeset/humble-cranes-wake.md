---
type: Fixed
pr: 1568
---
**Shipped milestones with a retired/folded phase now reach 100%** — a phase struck through in ROADMAP (marked `[x]`, with a directory but no completion artifact) was counted in `progress.total_phases` but could never be counted complete, freezing the milestone below 100% (e.g. 5/6 = 83%) with `state sync --verify` reporting no drift. Both STATE counting paths (`state json` and `state sync`) now exclude retired phases — detected from GFM strikethrough whose subject is the phase on a checklist/heading line — from both the phase-dir set and the heading count, via the canonical phase-id helpers so numeric, decimal, and project-code IDs match alike. (#1514)
