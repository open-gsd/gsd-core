---
type: Fixed
pr: 1113
---
**`state record-session` updates an existing `## Session Continuity` section in place instead of appending a duplicate `## Session` block** — on a freshly bootstrapped project (workstream / gsd2-import / new-project templates all emit `## Session Continuity`), the auto-create path recognised only the normalized `## Session` heading, so it appended a second session block. It now inserts only the missing canonical fields after the `## Session Continuity` heading, preserving the heading and any existing prose, and the snapshot / frontmatter readers recognise that heading. (The originally reported `recorded:false`-yet-mutated symptom was already resolved by #944/#948.) (#1101)
