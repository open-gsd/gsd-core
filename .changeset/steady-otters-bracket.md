---
type: Changed
pr: 4773
---
**Bracket-configured projects now emit canonical bracket phase identifiers on the phase and state write paths**: `phase add`, `phase add-batch`, and `phase insert` write `### [CODE.MM] NN: Name` headings and `CODE.MM-NN-name` directories through the shared phase-ID owner, scoped to the active milestone, and `insert` accepts bare, qualified (`CK.02-02`) and display (`[CK.02] 02`) arguments; manager and planning-inspect dependency readers take only the phase token from bracket display, dash, labeled-display, and bare references; bracket writers refuse symlinked or escaping phase-directory destinations before mutation; `phase remove` accepts the same forms, refuses before any mutation when the id belongs to another milestone, still has sub-phases, or sits outside the located milestone window, renumbers later phases and their sub-phases on disk and in ROADMAP.md together while preserving historical lines inside reader-classified closed-milestone details or closed milestone sections, keeping active collapsed details live, and ignoring fenced example headings as historical boundaries, and reports `roadmap_lines_rewritten` and `references_left_untouched` in its JSON output; STATE.md descriptive text renders the bracket display. `null`, `sequential`, and `milestone-prefixed` projects retain their existing output. (#4304)

<!-- docs-exempt: the governing ADR already documents bracket emit and PR-6 owns the generated user-facing convention guidance -->

Bracket phase directories emitted by these writers are also resolved by `find-phase` and every consumer of `findPhaseInternal`; non-bracket lookup bytes remain unchanged.
When a closed details archive sits inside the active milestone range, phase removal now skips its historical heading before selecting the live section to delete.
Bracket dependency forms use the new shared grammar without changing either legacy reader's pre-existing token bytes under null, sequential, or milestone-prefixed conventions.
