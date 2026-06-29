---
type: Fixed
pr: 1816
---
**`/gsd-thread close|resume` now writes the thread status/updated frontmatter (#1778)** — the thread workflow's CLOSE and RESUME branches invoked `frontmatter.set` with the pre-1.6 fully-positional shape (`frontmatter.set <file> <field> <value>`), but since 1.6 the dispatcher parses the file positionally and reads `field`/`value` from the named flags `--field`/`--value` via `parseNamedArgs`. The positional form left `field`/`value` undefined, `cmdFrontmatterSet` errored `file, field, and value required`, and the writes were silently skipped — so closing a thread never marked it `status: resolved` and resuming never marked it `status: in_progress`, with the error scrolling past on every thread command. All four sites (CLOSE `status`+`updated`, RESUME `status`+`updated`) now use the 1.6 hybrid form that `verify-work.md` already uses (`frontmatter.set <file> --field <field> --value <value>`).
