---
type: Fixed
pr: 2394
---
**Phase verification no longer reads `stale` from filesystem timestamps alone** — staleness is now derived from git commit times instead of file mtimes, so a phase whose report declares `status: passed` stays passed across a fresh `git clone`, `cp -R`, or an unrelated `touch`/reformat, instead of being silently downgraded to `stale` by a checkout-order mtime skew. (#2348)
