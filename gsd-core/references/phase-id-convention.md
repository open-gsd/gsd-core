# Bracket phase-ID convention

The bracket convention is opt-in through `phase_id_convention: "bracket"`.
Its compact grammar card below is generated from `src/phase-id-card.cts`; edit
that module, not this block.

<!-- PHASE-ID-CARD:START -->
```text
[GSD.02] 05.03-01
 │   │   │  │   │
 │   │   │  │   └── plan        01
 │   │   │  └────── subphase    03
 │   │   └───────── phase       05
 │   └───────────── milestone   02
 └───────────────── project     GSD

milestone = bracket integer; dots = phase-levels; one hyphen = plan; no 'Phase' word, no vX.Y
```
<!-- PHASE-ID-CARD:END -->

<!-- PHASE-ID-CONVENTION:START -->
## Phase ID convention

Resolve phase_id_convention from config independently of phase_naming.
Use CLI/writer identities and returned paths; never build paths from display labels.
Unset/null or sequential: Phase N; retain the legacy artifact rendering and paths.
milestone-prefixed: Phase M-NN. M is the active milestone integer; NN is padded to at least two digits. Do not include project_code in legacy headings or checklists.
bracket: [PROJECT.MM] PP[.SS], plan [PROJECT.MM] PP[.SS]-LL, directory PROJECT.MM-PP[.SS]-slug. MM is the active milestone integer; widths are at least two digits. Do not prepend Phase or vX.Y. Preserve milestone metadata; never migrate implicitly.
Resolve every identity placeholder from the per-flow sources below. A display_id is optional on phase rows; when absent or before rows exist, apply this reference grammar to the resolved identity and milestone metadata.
Progress table cells are reader identities, not display labels: phase_table_id is phase_number with only the configured project-code prefix removed. Keep its numeric milestone/phase spelling, including under bracket.
Backlog labels remain Phase plus the CLI backlog number under all conventions; never project them into the active milestone. Keep the existing backlog directory layout and pass the same CLI number to find-phase.
Sequential template bodies and titles retain their legacy spelling. In display output, retained Phase {N}, Phase [X] and Phase ${CLIARG} forms are contextual aliases for the complete phase_display identity: replace the whole token, including the Phase prefix. Generic N, X, Y, Z, A, B and C refer to the phase selected by that instruction when used as phase placeholders; the same letters used for counts remain counts. Resolve next, dependency, source and destination phase records independently, using next_phase_display or dependency_phase_display where applicable; never reuse the current phase identity for a different phase. This projection applies to messages, banners, questions, generated prose and display text inside shell examples. CLI arguments, frontmatter identities, filenames and milestone metadata keep their canonical input or artifact identities; do not project them as display labels. For other conventions, substitute resolved identities and artifact paths without changing other content. Numeric CLI arguments remain valid inputs, not convention switches.

### Retained display aliases

`Phase {N}`, `Phase {X}`, `Phase {Y}`, `Phase {Z}`, `Phase {A}`, `Phase {B}`, `Phase {C}`, `Phase {target}`, `Phase {phase}`, `Phase {phase_number}`, `Phase {phase_num}`, `Phase {PHASE}`, `Phase {PHASE_ARG}`, `Phase {next_integer}`, `Phase {src}`, `Phase {dest}`, `Phase [N]`, `Phase [X]`, `Phase [Y]`, `Phase [Z]`, `Phase [X+1]`, `Phase ${PHASE}`, `Phase ${PHASE_NUM}`, `Phase ${PHASE_NUMBER}`, `Phase ${PHASE_ARG}`, `Phase ${ONLY_PHASE}`, `Phase ${INCOMPLETE_PHASE}`, `Phase ${TARGET_PHASE}`, `Phase ${phase_number}`, `Phase ${N}`

### Placeholder sources

- `{phase_display}` (progress/stats/init manager phase rows; init plan-phase/execute-phase/phase-op; phase add/insert; roadmapper/new-project/new-milestone): Use the selected phase row display_id when present. init plan-phase, execute-phase and phase-op return phase_number, not display_id; phase add/insert return phase_number and roadmap_entry, not display_id. Read the writer-created roadmap heading, or render the resolved phase_number using the reference grammar. Before rows exist (roadmapper, new-project, new-milestone), render the proposed phase number from resolved config and the intended milestone integer. Never assume a missing display_id field exists.
- `{next_phase_display}`, `{dependency_phase_display}` (roadmap generation; mvp-phase; dependencies): Apply phase_display resolution to the next or dependency phase, using that phase record and its own milestone; before a record exists, render its proposed number with the reference grammar.
- `{backlog_phase_display}` (add-backlog; next; verify-work): Use Phase plus the exact CLI backlog number under every convention; never project the backlog number into the active milestone.
- `{plan_display}` (roadmapper; roadmap template): Use an existing writer-created plan identity when present. Otherwise render the phase identity and proposed two-digit plan number: sequential Phase N-LL, milestone-prefixed Phase M-NN-LL, bracket [PROJECT.MM] PP[.SS]-LL. Sequential roadmap checklists retain the Phase prefix.
- `{shipped_milestone_display}`, `{active_milestone_display}`, `{planned_milestone_display}` (roadmap template): Use the matching shipped, active or planned milestone metadata. Retain its version (for example v1.0) under sequential/milestone-prefixed; bracket renders [PROJECT.MM] with that milestone integer. A planned milestone must not borrow the active milestone integer.
- `{phase_table_id}` (roadmap Progress tables): Use CLI phase_number with only the configured project-code prefix removed, preserving the numeric milestone/phase spelling. Before rows exist, use the numeric phase identity that the writer will record, never a display label.
- `{phase_dir}`, `{phaseDir}`, `{PHASE_DIR}` (init consumers; phase creation): Use init phase_dir or query find-phase directory; phase add/insert return directory. Resolve a relative returned directory against the project root. Do not derive a directory from a display label.
- `{phase}`, `{phase_num}`, `{phase_number}`, `{PHASE_NUM}`, `{PHASE_NUMBER}`, `{PHASE}`, `{PHASE_ARG}`, `{next_phase}`, `{origin_phase}`, `{current_phase}`, `{NEXT_PHASE_NUMBER}`, `{decimal_phase}`, `{after_phase}` (phase query/mutation/dispatch): Use the workflow-selected CLI phase argument or the matching phase_number/next_phase returned by its init, roadmap or mutation query. Preserve exact custom and backlog identities; these are CLI inputs or artifact identities, not display labels.
- `{padded_phase}`, `{PADDED_PHASE}` (init consumers; artifact writers): Use init padded_phase, the canonical artifact stem; it can include a configured identity and is not always a zero-padded integer.
- `{plan}`, `{plan_id}`, `{plan_number}`, `{plan_padded}`, `{current_plan_number}`, `{completed_plan_ids}` (planning; execution; pause/resume): Use the selected plan record, plan frontmatter or plan-index response. plan_number is the within-phase number; plan_padded pads that number to at least two digits; plan_id and completed_plan_ids retain the IDs returned by the plan index. Do not substitute plan_display into CLI or file identities.
- `{plan_path}`, `{summary_path}` (planner; executor): These are orchestrator substitutions, not init response fields. For new plans use resolved phase_dir, init padded_phase and the within-phase plan number (at least two digits): phase_dir/padded_phase-LL-PLAN.md and the matching -SUMMARY.md. For an existing plan use the actual path supplied in the prompt, or join a basename from init plans to its returned phase_dir; derive summary_path by replacing its final -PLAN.md with -SUMMARY.md. Preserve the entire basename. Artifact references retain project-relative legacy spelling when the supplied path is inside the project; write operations resolve that path against the project root.
- `{plan_file}`, `{plan_paths}`, `{phase_dirs}`, `{milestones_path}` (plan index; review/audit; milestone setup): Use the corresponding query/index response or the explicit paths read by the workflow: existing plan file/list, phase directory list, or planning milestones path. Preserve returned paths rather than reconstructing them from labels.
- `{milestone}`, `{milestone_version}`, `{queued_milestone_version}` (milestone/state consumers): Use the workflow-selected milestone version or the matching current/queued milestone metadata from STATE, ROADMAP or init; this is metadata, not a projected phase display.
- `{phase_slug}` (phase artifact setup): Use the phase_slug returned by init or the resolved writer slug; a slug alone is not a phase identity or path.
<!-- PHASE-ID-CONVENTION:END -->

Regenerate both regions with `npm run build:lib` followed by
`node scripts/gen-phase-id-convention.cjs --write`; check with `--check`.

The generator selects full agent definitions, phase-emitting workflow instructions,
and seven core templates. Files whose text is user-facing command output are not
targets: `help/modes/brief.md`, `default.md`, and `full.md` are explicitly excluded
by the manifest and evidence gate. The generator owns the exact reviewed selection.
