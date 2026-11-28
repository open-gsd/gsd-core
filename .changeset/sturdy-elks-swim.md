---
type: Fixed
pr: 0
---
**A verified phase stays `passed` after its directory is archived or moved** — `milestone complete` (with or without `--ws`), `phases clear` (including its `.N` collision suffix), `workstream complete` and the cleanup workflow move a phase directory without changing a byte, yet its VERIFICATION report read `stale`, because `covered_files` and the digest name the old paths. The check now recomputes a moved report as it was emitted and accepts the move only when that reproduces the stored digest exactly, so one changed covered byte still reads `stale`, and `moved_files` names files where they live now. New fingerprints are v5: a phase in a workstream's milestone archive keeps that workstream's `ROADMAP.md` shared; stored v1-v4 reports keep their meaning. (#6811)
