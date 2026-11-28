---
type: Fixed
pr: 6880
---
**A verified phase stays `passed` when `milestone complete`, `phases clear`, `workstream complete` or the cleanup workflow moves its directory** — these movers rename a phase directory (`milestone complete` with or without `--ws`, `phases clear` including its `.N` collision suffix) without changing a byte, yet its VERIFICATION report read `stale`, because `covered_files` and the digest name the old paths. The check now recomputes a moved report as it was emitted and accepts the move only when that reproduces the stored digest exactly, so one changed covered byte still reads `stale`, and `moved_files` names files where they live now. A `REQUIREMENTS.md` the complete-milestone workflow deletes after archiving it is read from its archived copy. New fingerprints are v5: a phase in a workstream's milestone archive keeps that workstream's `ROADMAP.md` shared; stored v1-v4 reports keep their meaning. (#6811)
