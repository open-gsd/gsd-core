---
type: Changed
pr: 5750
---
**Bracket projects now write bracket phase ids** — on `phase_id_convention: "bracket"`, the phase and state writers emit `[CODE.MM] NN` identities instead of legacy ones (#4304):
- `phase add`, `add-batch` and `insert` write `### [CK.02] 02: Name` headings and `CK.02-02-name` directories in the active milestone; a supplied `--id` or `phase_naming: "custom"` is refused until #5067.
- `phase add` and `add-batch` depend on the nearest lower phase declared by a heading in the active milestone, or `Nothing` when none exists; batch items chain to the preceding inserted phase. Directory and sibling-worktree reservations affect allocation only.
- `phase remove` accepts `02`, `CK.02-02` or `[CK.02] 02`, renumbers later phases and sub-phases on disk and in ROADMAP.md, leaves shipped history untouched, and reports `roadmap_lines_rewritten` and `references_left_untouched`. It refuses, with nothing changed, the shapes listed in docs/CLI-TOOLS.md, which also lists its known limits.
- `phase remove` validates the complete delete-and-rename sequence before changing any phase directory: repeated slugs can reuse names vacated by the target or earlier renames, while destinations that stay occupied are refused.
- `phase next-decimal` returns canonical bracket sub-phases, and STATE.md descriptive text uses the bracket display.
- `find-phase`, the manager and the other phase lookups resolve the emitted directories and bracket dependencies.
- `null`, `sequential` and `milestone-prefixed` projects are unchanged.

- Bracket `phase remove` refuses nonexistent targets and `.00` sub-phases before changing any files.
- Slug-bearing bracket removal arguments must exactly match the selected directory slug.
