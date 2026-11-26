'use strict';

// Agents that read project skills carry one "Project skills" block that @-includes the shared
// discovery reference (#4649) and states, in one line under it, how that agent applies the rules.
// The reference scopes the read to frontmatter first and names no pack-specific layout; no agent
// or reference tells the reader to refuse AGENTS.md. The doc writer also guards the doc_assignment
// block against user data. The agent .md files are the installed instructions, so their text is the
// contract. Was tests/agent-skills-awareness.test.cjs.

const REFERENCE = 'gsd-core/references/project-skills-discovery.md';
const INCLUDE = '@~/.claude/gsd-core/references/project-skills-discovery.md';
// A guard against regrowth, not a measure of delivery: the reference is prompt text every spawn of
// every skills-carrying agent pays for. LF-normalised bytes, as the emitted-attribution gate counts.
const REFERENCE_MAX_BYTES = 1600;

// The 21 canonical agents that run project-skills discovery.
const DISCOVERY_AGENTS = [
  'gsd-code-fixer',
  'gsd-code-reviewer',
  'gsd-codebase-mapper',
  'gsd-debugger',
  'gsd-doc-verifier',
  'gsd-doc-writer',
  'gsd-eval-auditor',
  'gsd-executor',
  'gsd-integration-checker',
  'gsd-intel-updater',
  'gsd-nyquist-auditor',
  'gsd-pattern-mapper',
  'gsd-phase-researcher',
  'gsd-plan-checker',
  'gsd-planner',
  'gsd-roadmapper',
  'gsd-security-auditor',
  'gsd-ui-auditor',
  'gsd-ui-checker',
  'gsd-ui-researcher',
  'gsd-verifier',
];

// Their compact variants (served to non-Claude runtimes); the plan checker and the five agents the
// compact generator does not ship have none.
const COMPACT_AGENTS = DISCOVERY_AGENTS.filter(
  (name) => !['gsd-debugger', 'gsd-executor', 'gsd-phase-researcher', 'gsd-plan-checker', 'gsd-planner', 'gsd-verifier'].includes(name),
);

const AGENTS_REQUIRING_SKILLS = [
  'gsd-debugger',
  'gsd-integration-checker',
  'gsd-security-auditor',
  'gsd-nyquist-auditor',
  'gsd-codebase-mapper',
  'gsd-roadmapper',
  'gsd-eval-auditor',
  'gsd-intel-updater',
  'gsd-doc-writer',
];

// The first non-blank line under the include is the agent's own application line: a bullet that
// names skills. An include followed by nothing, or by another block, tells the agent what to read
// but not what to do with it.
function roleStatementUnderInclude(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.includes(INCLUDE));
  if (at === -1) return 'the include is missing';
  const next = lines.slice(at + 1).find((line) => line.trim() !== '') ?? '';
  if (/^- .*\bskills?\b/i.test(next)) return true;
  return `the line under the include is not a bullet that names skills: ${JSON.stringify(next.slice(0, 60))}`;
}

module.exports = {
  id: 'agent-skills-awareness',
  check(ctx) {
    for (const name of AGENTS_REQUIRING_SKILLS) {
      ctx.doc(`agents/${name}.md`)
        .has('Project skills', `${name} missing Project skills block`)
        .lacks('Read AGENTS.md', `${name} should not instruct loading full AGENTS.md`)
        .lacks('load AGENTS.md', `${name} should not instruct loading full AGENTS.md`);
    }
    ctx.doc('agents/gsd-doc-writer.md')
      .has('doc_assignment', 'gsd-doc-writer missing security note for doc_assignment block')
      .has('SECURITY', 'gsd-doc-writer missing security note for doc_assignment block');

    // Every discovery agent, canonical and compact, includes the one shared reference and restates
    // none of it (#4649): 21 + 15 files, one owner.
    const files = [
      ...DISCOVERY_AGENTS.map((name) => `agents/${name}.md`),
      ...COMPACT_AGENTS.map((name) => `agents/${name}.compact.md`),
    ];
    for (const rel of files) {
      ctx.doc(rel)
        .has(INCLUDE, `${rel} must @-include the shared project-skills-discovery reference`)
        .lacks(/lightweight index|~130[- ]line|\(~130 lines\)/i, `${rel} restates the old index-size claim inline`)
        .lacks(/Read `SKILL\.md` (?:for each|per skill)|Read each `SKILL\.md`|read each `SKILL\.md`/, `${rel} restates the read-every-SKILL.md step inline`)
        .lacks(/(?:do not|never) load full `?AGENTS\.md`?/i, `${rel} tells the reader not to load AGENTS.md`)
        .lacks(/Load specific `rules\/\*\.md`|load `rules\/\*\.md`/i, `${rel} restates the rules/*.md step inline`)
        .satisfies(roleStatementUnderInclude, `${rel} needs its own application line under the include`);
    }

    // The reverse leg: an agent that includes the reference is on the list above, so a new includer
    // cannot slip in unlisted and a listed agent cannot drop the include unnoticed.
    const listed = new Set(files);
    for (const rel of ctx.list('agents', '.md', 'the agent files that may include the discovery reference')) {
      if (listed.has(rel)) continue;
      ctx.doc(rel).lacks(INCLUDE, `${rel} includes the discovery reference but is not in the agent-skills-awareness list`);
    }

    // The reference itself: frontmatter first, a description gate, the no-description fallback,
    // deferred skills stay reachable, generic resource loading, and nothing from the dropped dedup
    // step or the old pack-specific steps.
    ctx.doc(REFERENCE)
      .has(/only the (?:YAML )?frontmatter/i, 'step 3 must scope the index read to the frontmatter')
      .has('`description`', 'the read must be gated on the skill description')
      .has(/no `description`/, 'a skill without a description must still be read in full')
      .has(/stays available|remains available/i, 'a skill that was not read must stay reachable')
      .has(/a `SKILL\.md` references/, 'resource loading must follow what a SKILL.md references')
      .lacks(/config-get|gsd_run|agent_skills/, 'the agent_skills dedup step was dropped (#4649, 2026-10-14)')
      .lacks(/AGENTS\.md/, 'the reference must not mention AGENTS.md')
      .lacks('rules/*.md', 'the reference must not encode one pack\'s rules/*.md layout')
      .satisfies(
        (text) => {
          const bytes = Buffer.byteLength(text, 'utf8');
          return bytes <= REFERENCE_MAX_BYTES ? true : `${bytes} bytes, expected at most ${REFERENCE_MAX_BYTES}`;
        },
        'the shared reference is paid for on every spawn of every discovery agent',
      );
  },
};
