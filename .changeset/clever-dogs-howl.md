---
type: Fixed
pr: 4832
---
**`--auto` no longer stops on an artifact that already exists** — `/gsd-ui-phase <phase> --auto` blocked on "UI-SPEC.md already exists for Phase {N}" whenever the file was on disk, which is most often after an earlier run left an unverified draft, so a headless or board run stalled on a question nobody could answer. It now reuses the existing UI-SPEC untouched and proceeds to the checker. `/gsd-spec-phase --auto` had the opposite failure — it auto-selected "Update it" and regenerated a spec nobody was watching, discarding answers already recorded in it — and now also reuses it as-is. The max-revision-iterations escalation (Force approve / Edit manually / Abandon) still stops for a person under `--auto`, by design. (#4776)
