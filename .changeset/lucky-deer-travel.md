---
type: Changed
pr: 5756
---

**Custom phase IDs resolve safely and consistently** — creation records the exact ID in `.phase-id`, preserving ownership through roadmap edits and archival. Recorded IDs take precedence over full directory basenames; basename lookup remains available when no recorded ID owns the query. Lifecycle, init, progress and health readers share custom-aware identities and roadmap order. Markerless directories with one known owner remain supported; ambiguous mutations refuse with candidates and a marker repair path. (#5186)

`phase.add --id` now returns a usage error unless effective `phase_naming` is `custom`, because its previous behavior wrote an unresolvable directory. Custom writers reject unreadable IDs, IDs already carrying the project prefix, equivalent recorded/declared/batch IDs and writes that would claim markerless directories. Marked prefix pairs remain supported. Custom add, add-batch, insert and scaffold refuse occupied directory targets or duplicate batch destinations before writing, preserving existing identity markers; numeric writers keep their idempotent directory creation. Add-batch validates all directory components and containment before writing.

Custom IDs in the readers' reserved backlog or icebox ranges are refused before writing, so ordinary listings cannot hide a newly created custom phase. Completion keeps prefix-related recorded IDs distinct and persists the next declared phase to STATE.md; checkbox and requirement updates bind to that exact identity.

Legacy numeric families retain padding-tolerant removal and renumbering, including inserted decimal children. Smart-entry failure detection handles numeric phases in custom projects.
