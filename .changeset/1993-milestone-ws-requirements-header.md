---
type: Fixed
pr: 2015
---
**`milestone complete --ws` requirements archive header now points at the workstream REQUIREMENTS.md** — the archive header string hardcoded the root path (`` `…see .planning/REQUIREMENTS.md` ``), so a workstream archive directed readers at the wrong file even though #1917 had already fixed the archive *locations* to land inside the workstream. The display path is now derived from the same workstream-aware `reqPath` the writer uses (`path.relative(cwd, reqPath)`), so root behavior is byte-identical and the workstream case correctly reads `.planning/workstreams/<ws>/REQUIREMENTS.md`. (#1993)
