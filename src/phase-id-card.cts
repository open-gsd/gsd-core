/**
 * Canonical bracket convention card (#3638 / ADR-612 PR-5).
 *
 * This module is the sole editable source of the compact grammar diagram.
 * Render sites import phaseIdCard(); generated documentation is held to the
 * same bytes by tests/phase-id-card.test.cjs. PR-6 also renders the short
 * instruction region and the lazy reference rules from this module.
 */

const PHASE_ID_CARD = [
  '[GSD.02] 05.03-01',
  ' │   │   │  │   │',
  ' │   │   │  │   └── plan        01',
  ' │   │   │  └────── subphase    03',
  ' │   │   └───────── phase       05',
  ' │   └───────────── milestone   02',
  ' └───────────────── project     GSD',
].join('\n');

const PHASE_ID_LEGEND =
  "milestone = bracket integer; dots = phase-levels; one hyphen = plan; "
  + "no 'Phase' word, no vX.Y";

function phaseIdCard(options: { title?: string } = {}): string {
  const parts: string[] = [];
  if (options.title) parts.push(options.title, '');
  parts.push(PHASE_ID_CARD, '', PHASE_ID_LEGEND);
  return parts.join('\n');
}

type PhaseConventionRule = Readonly<{ id: string; text: string }>;

type PlaceholderSource = Readonly<{
  placeholders: readonly string[];
  flows: readonly string[];
  source: string;
}>;

// These are instruction substitutions, not additional CLI response fields.
const PHASE_ID_PLACEHOLDER_SOURCES: readonly PlaceholderSource[] = Object.freeze([
  { placeholders: ['phase_display'], flows: ['progress/stats/init manager phase rows', 'init plan-phase/execute-phase/phase-op', 'phase add/insert', 'roadmapper/new-project/new-milestone'], source: 'Use the selected phase row display_id when present. init plan-phase, execute-phase and phase-op return phase_number, not display_id; phase add/insert return phase_number and roadmap_entry, not display_id. Read the writer-created roadmap heading, or render the resolved phase_number using the reference grammar. Before rows exist (roadmapper, new-project, new-milestone), render the proposed phase number from resolved config and the intended milestone integer. Never assume a missing display_id field exists.' },
  { placeholders: ['next_phase_display', 'dependency_phase_display'], flows: ['roadmap generation', 'mvp-phase', 'dependencies'], source: 'Apply phase_display resolution to the next or dependency phase, using that phase record and its own milestone; before a record exists, render its proposed number with the reference grammar.' },
  { placeholders: ['backlog_phase_display'], flows: ['add-backlog', 'next', 'verify-work'], source: 'Use Phase plus the exact CLI backlog number under every convention; never project the backlog number into the active milestone.' },
  { placeholders: ['shipped_milestone_display', 'active_milestone_display', 'planned_milestone_display'], flows: ['roadmap template'], source: 'Use the matching shipped, active or planned milestone metadata. Retain its version (for example v1.0) under sequential/milestone-prefixed; bracket renders [PROJECT.MM] with that milestone integer. A planned milestone must not borrow the active milestone integer.' },
  { placeholders: ['phase_table_id'], flows: ['roadmap Progress tables'], source: 'Use CLI phase_number with only the configured project-code prefix removed, preserving the numeric milestone/phase spelling. Before rows exist, use the numeric phase identity that the writer will record, never a display label.' },
  { placeholders: ['phase_dir', 'phaseDir', 'PHASE_DIR'], flows: ['init consumers', 'phase creation'], source: 'Use init phase_dir or query find-phase directory; phase add/insert return directory. Resolve a relative returned directory against the project root. Do not derive a directory from a display label.' },
  { placeholders: ['phase', 'phase_num', 'phase_number', 'PHASE_NUM', 'PHASE_NUMBER', 'PHASE', 'PHASE_ARG', 'next_phase', 'origin_phase', 'current_phase', 'NEXT_PHASE_NUMBER', 'decimal_phase', 'after_phase'], flows: ['phase query/mutation/dispatch'], source: 'Use the workflow-selected CLI phase argument or the matching phase_number/next_phase returned by its init, roadmap or mutation query. Preserve exact custom and backlog identities; these are CLI inputs or artifact identities, not display labels.' },
  { placeholders: ['padded_phase', 'PADDED_PHASE'], flows: ['init consumers', 'artifact writers', 'roadmap Plans: rows'], source: 'Use init padded_phase, the canonical artifact stem; it can include a configured identity and is not always a zero-padded integer. A ROADMAP Plans: row is the plan file stem padded_phase-plan_padded, the identity roadmap update-plan-progress ticks; never a display label.' },
  { placeholders: ['plan', 'plan_id', 'plan_number', 'plan_padded', 'current_plan_number', 'completed_plan_ids'], flows: ['planning', 'execution', 'pause/resume'], source: 'Use the selected plan record, plan frontmatter or plan-index response. plan_number is the within-phase number; plan_padded pads that number to at least two digits; plan_id and completed_plan_ids retain the IDs returned by the plan index. Do not substitute plan_display into CLI or file identities.' },
  { placeholders: ['plan_path', 'summary_path'], flows: ['planner', 'executor'], source: 'These are orchestrator substitutions, not init response fields. For new plans use resolved phase_dir, init padded_phase and the within-phase plan number (at least two digits): phase_dir/padded_phase-LL-PLAN.md and the matching -SUMMARY.md. For an existing plan use the actual path supplied in the prompt, or join a basename from init plans to its returned phase_dir; derive summary_path by replacing its final -PLAN.md with -SUMMARY.md. Preserve the entire basename. Artifact references retain project-relative legacy spelling when the supplied path is inside the project; write operations resolve that path against the project root.' },
  { placeholders: ['plan_file', 'plan_paths', 'phase_dirs', 'milestones_path'], flows: ['plan index', 'review/audit', 'milestone setup'], source: 'Use the corresponding query/index response or the explicit paths read by the workflow: existing plan file/list, phase directory list, or planning milestones path. Preserve returned paths rather than reconstructing them from labels.' },
  { placeholders: ['milestone', 'milestone_version', 'queued_milestone_version'], flows: ['milestone/state consumers'], source: 'Use the workflow-selected milestone version or the matching current/queued milestone metadata from STATE, ROADMAP or init; this is metadata, not a projected phase display.' },
  { placeholders: ['phase_slug'], flows: ['phase artifact setup'], source: 'Use the phase_slug returned by init or the resolved writer slug; a slug alone is not a phase identity or path.' },
]);

// Complete legacy display tokens retained in installed instructions. Their
// variables are contextual references, not permission to force a Phase prefix.
const PHASE_ID_LEGACY_DISPLAY_ALIASES: readonly string[] = Object.freeze([
  ...['N', 'X', 'Y', 'Z', 'A', 'B', 'C', 'target', 'phase', 'phase_number', 'phase_num', 'PHASE', 'PHASE_ARG', 'next_integer', 'src', 'dest']
    .map(name => `Phase {${name}}`),
  ...['N', 'X', 'Y', 'Z', 'X+1'].map(name => `Phase [${name}]`),
  ...['PHASE', 'PHASE_NUM', 'PHASE_NUMBER', 'PHASE_ARG', 'ONLY_PHASE', 'INCOMPLETE_PHASE', 'TARGET_PHASE', 'phase_number', 'N']
    .map(name => `Phase $` + `{${name}}`),
]);

const PHASE_ID_RULES: readonly PhaseConventionRule[] = Object.freeze([
  { id: 'config', text: 'Resolve phase_id_convention from config independently of phase_naming.' },
  { id: 'identity', text: 'Use CLI/writer identities and returned paths; never build paths from display labels.' },
  { id: 'sequential', text: 'Unset/null or sequential: Phase N; retain the legacy artifact rendering and paths.' },
  { id: 'milestone-prefixed', text: 'milestone-prefixed: Phase M-NN. M is the active milestone integer; NN is padded to at least two digits. Do not include project_code in legacy headings or checklists.' },
  { id: 'bracket', text: 'bracket: [PROJECT.MM] PP[.SS], plan [PROJECT.MM] PP[.SS]-LL, directory PROJECT.MM-PP[.SS]-slug. MM is the active milestone integer; widths are at least two digits. Do not prepend Phase or vX.Y. Preserve milestone metadata; never migrate implicitly.' },
  { id: 'display', text: 'Resolve every identity placeholder from the per-flow sources below. A display_id is optional on phase rows; when absent or before rows exist, apply this reference grammar to the resolved identity and milestone metadata.' },
  { id: 'table', text: 'Progress table cells are reader identities, not display labels: phase_table_id is phase_number with only the configured project-code prefix removed. Keep its numeric milestone/phase spelling, including under bracket.' },
  { id: 'backlog', text: 'Backlog labels remain Phase plus the CLI backlog number under all conventions; never project them into the active milestone. Keep the existing backlog directory layout and pass the same CLI number to find-phase.' },
  { id: 'legacy', text: 'Sequential template bodies and titles retain their legacy spelling. In display output, retained Phase {N}, Phase [X] and Phase ${CLIARG} forms are contextual aliases for the complete phase_display identity: replace the whole token, including the Phase prefix. Generic N, X, Y, Z, A, B and C refer to the phase selected by that instruction when used as phase placeholders; the same letters used for counts remain counts. Resolve next, dependency, source and destination phase records independently, using next_phase_display or dependency_phase_display where applicable; never reuse the current phase identity for a different phase. This projection applies to messages, banners, questions, generated prose and display text inside shell examples. CLI arguments, frontmatter identities, filenames and milestone metadata keep their canonical input or artifact identities; do not project them as display labels. For other conventions, substitute resolved identities and artifact paths without changing other content. Numeric CLI arguments remain valid inputs, not convention switches.' },
]);

function phaseIdConventionRules(): string {
  return ['## Phase ID convention', '', ...PHASE_ID_RULES.map(rule => rule.text), '', '### Retained display aliases', '', PHASE_ID_LEGACY_DISPLAY_ALIASES.map(form => `\`${form}\``).join(', '), '', '### Placeholder sources', '', ...PHASE_ID_PLACEHOLDER_SOURCES.map(rule => `- ${rule.placeholders.map(name => `\`{${name}}\``).join(', ')} (${rule.flows.join('; ')}): ${rule.source}`)].join('\n');
}

function phaseIdConventionBlock(): string {
  return [
    'Resolve phase_id_convention independently of phase_naming. Use returned paths; never derive them from display labels.',
    'Use CLI display_id when present; otherwise use reference grammar. Before emitting identities, Read `~/.claude/gsd-core/references/phase-id-convention.md`.',
  ].join('\n');
}

export = {
  PHASE_ID_RULES,
  PHASE_ID_PLACEHOLDER_SOURCES,
  PHASE_ID_LEGACY_DISPLAY_ALIASES,
  phaseIdConventionRules,
  phaseIdConventionBlock,
  phaseIdCard,
  PHASE_ID_CARD,
  PHASE_ID_LEGEND,
};
