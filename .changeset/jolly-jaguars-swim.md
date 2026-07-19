---
type: Fixed
pr: 2433
---
**`/gsd-review` and `/gsd:ship` temp files are now scoped to a single per-run directory** — both workflows previously wrote prompt, section, and reviewer-output files to `/tmp/gsd-review-*-{phase}.*` keyed only on the bare phase number, so two projects sharing a phase number (or a crashed run's leftover file) could collide and silently feed a reviewer another project's stale content with no error; every temp path now lives under one `mktemp`-created run directory that's removed after the review completes. (#2358)
