---
type: Fixed
pr: 5499
---
**`gsd-tools skill-manifest` no longer hangs or runs out of memory on a hostile `SKILL.md`** — A `SKILL.md` that is a symlink to `/dev/zero`, a FIFO, or larger than 256 KiB is now skipped like a missing one in skill discovery (both layouts), the installed-runtime dependency manifest, and installed capability skills, instead of being read unbounded. (#5121)
