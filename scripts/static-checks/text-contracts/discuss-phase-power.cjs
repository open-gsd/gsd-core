'use strict';

// discuss-phase --power (#1513) and the discuss-phase text guards folded into its test: the command and workflow
// document --power; discuss-phase-power.md carries the generate, notify, wait, refresh and finalize steps and the
// QUESTIONS.json / QUESTIONS.html contract; advisor mode spawns the registered gsd-advisor-researcher (#2771); the
// four text inconsistencies of #2772; every discuss mode carries the same check_spec contract (#5629) and no workflow
// globs for the phase SPEC. Where the test accepted a bare word the workflow carries many times (generate, wait or
// notify, refresh, finalize, padded_phase) the contract asks for the step or marker the file has. Each file is read
// once; a line that breaks both SPEC rules of discuss-phase.md or plan-phase.md is one finding. Was
// tests/discuss-phase-power.test.cjs.

const { asciiLower } = require('./lib/ascii-lower.cjs');
const { LINE_ENDS } = require('./lib/line-ends.cjs');
const { loadLib } = require('./lib/load-lib.cjs');

const COMMAND = 'commands/gsd/discuss-phase.md';
const WORKFLOW = 'gsd-core/workflows/discuss-phase.md';
const POWER = 'gsd-core/workflows/discuss-phase-power.md';
const POWER_MODE = 'gsd-core/workflows/discuss-phase/modes/power.md';
const ADVISOR = 'gsd-core/workflows/discuss-phase/modes/advisor.md';
const AUTO = 'gsd-core/workflows/discuss-phase/modes/auto.md';
const GATE_PROMPTS = 'gsd-core/references/gate-prompts.md';
const ASSUMPTIONS = 'gsd-core/workflows/discuss-phase-assumptions.md';
const PLAN_PHASE = 'gsd-core/workflows/plan-phase.md';
const WORKFLOWS_DIR = 'gsd-core/workflows';

const need = (condition, message) => condition || message;
const hasAny = (text, words) => words.some((word) => text.includes(word));
const isWordChar = (char) => char !== undefined && /[A-Za-z0-9_]/.test(char);

// A pattern's word boundary on both sides (`\bWORD\b`, the word starting and ending with a word character).
function hasWord(text, word) {
  let at = text.indexOf(word);
  while (at !== -1) {
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + word.length])) return true;
    at = text.indexOf(word, at + 1);
  }
  return false;
}

// The phrase, lower-cased over ASCII only, as an ASCII case-insensitive pattern matches it.
const mentions = (text, phrase) => asciiLower(text).includes(phrase);

// The first `first` comes before the first `second`; a missing `first` is its own step's finding (and a missing
// `second` too, unless `second` has no check of its own).
function precedes(text, first, second, secondIsOwn = false) {
  const at = text.indexOf(first);
  const next = text.indexOf(second);
  if (at === -1) return true;
  if (next === -1) return secondIsOwn ? `${second} not found` : true;
  return at < next || `${second} comes first`;
}

// A manual instruction to read the agent definition: `read`, one or more blanks, `@`, then the file name later on that
// line (the old pattern was /read\s+@.*gsd-advisor-researcher\.md/i; `.` stops at a line end).
function readsAgentDef(text) {
  const lower = asciiLower(text);
  let at = lower.indexOf('read');
  while (at !== -1) {
    let cursor = at + 4;
    while (cursor < lower.length && /\s/.test(lower[cursor])) cursor += 1;
    if (cursor > at + 4 && lower[cursor] === '@') {
      let end = cursor + 1;
      while (end < lower.length && !LINE_ENDS.has(lower[end])) end += 1;
      if (lower.slice(cursor + 1, end).includes('gsd-advisor-researcher.md')) return true;
      // The rest of this line holds no file name, so no later `read @` on it can match: resume at the line end.
      at = lower.indexOf('read', end);
    } else {
      at = lower.indexOf('read', at + 1);
    }
  }
  return false;
}

// A line that pairs the word `ls` with `*-SPEC.md`: the phase SPEC is read from init, never globbed. `split` is the
// line splitter (the test used splitLines of gsd-core/bin/lib/text-lines.cjs: CRLF or LF breaks, a lone CR does not).
const lsGlobsSpec = (text, split) => split(text).some((line) => hasWord(line, 'ls') && line.includes('*-SPEC.md'));

// One verdict per file: a globbing line, or the file's own literal (discuss-phase.md and plan-phase.md carry one).
function noSpecGlob(text, own, split) {
  if (lsGlobsSpec(text, split)) return 'a line pairs ls with *-SPEC.md';
  if (own && text.includes(own.literal)) return own.message;
  return true;
}

const OWN_SPEC_RULES = {
  [WORKFLOW]: { literal: 'ls ${phase_dir}/*-SPEC.md', message: 'discuss-phase.md reads has_spec / spec_path from init instead of its own ls' },
  [PLAN_PHASE]: { literal: '*-SPEC.md" 2>/dev/null | grep', message: 'plan-phase.md filters SPEC names itself' },
};

const SPEC_ANALYZER_OPEN = 'Agent(subagent_type="gsd-assumptions-analyzer"';
const SPEC_ANALYZER_CLOSE = '${AGENT_SKILLS_ANALYZER}\n""")';
const ENDS_WORKFLOW = ['end here', 'workflow is complete'];

// The line splitter loads through `loadTextLines` so a test can hand in a loader that throws.
function buildCheck(loadTextLines = () => require('../../../gsd-core/bin/lib/text-lines.cjs')) {
  return function check(ctx) {
    const command = ctx.doc(COMMAND);
    const workflow = ctx.doc(WORKFLOW);
    const power = ctx.doc(POWER);
    const powerMode = ctx.doc(POWER_MODE);
    const advisor = ctx.doc(ADVISOR);
    const auto = ctx.doc(AUTO);
    const gate = ctx.doc(GATE_PROMPTS);
    const assumptions = ctx.doc(ASSUMPTIONS);
    const plan = ctx.doc(PLAN_PHASE);

    command.has('--power', 'commands/gsd/discuss-phase.md should document the --power flag')
      .has('discuss-phase-power', 'command file should reference discuss-phase-power workflow');

    // The power dispatch lives in modes/power.md since the modes split (#717); the parent references it.
    let powerModeText = null;
    powerMode.satisfies((text) => { powerModeText = text; return true; }, 'modes/power.md must load');
    workflow.satisfies((text) => {
      if (powerModeText === null) return true;
      const content = `${text}\n${powerModeText}`;
      return need(hasAny(content, ['power_user_mode', 'power user mode', 'modes/power.md']) || content.includes('discuss-phase-power'),
        'neither a power section nor a reference found');
    }, 'discuss-phase.md (or modes/power.md after the discuss-phase/modes split) should have power_user_mode section or reference discuss-phase-power.md');
    workflow.has('--power', 'discuss-phase.md should describe --power flag handling');

    const waitStep = power.step('wait_loop');
    power.has('<step name="generate_json">', 'power workflow should describe generating questions')
      .has('<step name="notify_user">', 'power workflow should describe the notify step after generating files');
    waitStep.has('**"refresh"**', 'power workflow should describe the refresh step for processing answers');
    power.has('<step name="finalize">', 'power workflow should describe the finalize step for generating CONTEXT.md')
      .has('QUESTIONS.json', 'should mention QUESTIONS.json file')
      .has('"phase"', 'JSON structure should include phase field')
      .has('"stats"', 'JSON structure should include stats field')
      .has('"sections"', 'JSON structure should include sections field')
      .satisfies((text) => {
        const missing = ['"id"', '"title"'].filter((word) => !text.includes(word));
        return need(missing.length === 0, `missing ${missing.join(', ')}`);
      }, 'JSON structure should include question id and title fields')
      .has('"options"', 'JSON structure should include options array')
      .has('"answer"', 'JSON structure should include answer field')
      .has('"status"', 'JSON structure should include status field')
      .has('QUESTIONS.html', 'power workflow should describe generating the HTML companion file')
      .has('HTML', 'power workflow should mention HTML output')
      .has('{padded_phase}', 'power workflow should describe file naming with padded phase number');

    advisor.has('subagent_type=', 'advisor.md must contain an Agent() subagent_type declaration')
      .has('subagent_type="gsd-advisor-researcher"', 'advisor mode must spawn subagent_type="gsd-advisor-researcher" (the registered agent def auto-loads) — not general-purpose (#2771)')
      .lacks('subagent_type="general-purpose"', 'advisor mode must NOT spawn subagent_type="general-purpose" (#2771)')
      .satisfies((text) => need(!readsAgentDef(text), 'found'),
        'advisor mode must not manually instruct reading the agent def — spawning by type auto-loads it (#2771)');

    auto.satisfies((text) => need(mentions(text, 'single pass'), 'not found'), 'auto.md must still mandate the single-pass rule')
      .lacks('MAX_PASSES=', 'auto.md must not read MAX_PASSES (dead config — single-pass rule governs) (#2772)')
      .lacks('max_discuss_passes', 'auto.md must not reference max_discuss_passes (contradicts the single-pass rule) (#2772)');

    // The gray-area-option marker is sliced once; the context-handling block ends where it begins, so a missing
    // marker is one finding (from the gray-area-option slice) and the block checks stay quiet.
    const GRAY_AREA = '## Pattern: gray-area-option';
    const contextOpen = '## Pattern: context-handling';
    // Only the first check reports a missing block marker; the second stays quiet on it.
    const inContext = (check, reportsMarkers) => (text) => {
      const start = text.indexOf(contextOpen);
      if (start === -1) return reportsMarkers ? `marker "${contextOpen}" not found` : true;
      // The block ends at the first gray-area-option marker anywhere (a missing one is the slice below's finding).
      const end = text.indexOf(GRAY_AREA);
      if (end === -1) return true;
      if (end < start) return reportsMarkers ? `closing marker ${GRAY_AREA} precedes ${contextOpen}` : true;
      return check(text.slice(start, end));
    };
    gate.satisfies(inContext((block) => need(block.includes('Update it | View it | Skip'), 'not found'), true),
      'context-handling options must be "Update it | View it | Skip" (the actual check_existing flow) (#2772)')
      .satisfies(inContext((block) => need(!block.includes('Overwrite | Append | Cancel'), 'found'), false),
        'context-handling must NOT document the obsolete "Overwrite | Append | Cancel" (#2772)');
    gate.slice(GRAY_AREA)
      .satisfies((text) => need(!mentions(text, 'always include "let claude decide"'), 'found'),
        'gray-area-option must NOT mandate "Let Claude decide" (#2772)');

    for (const [label, doc, banned] of [
      ['discuss-phase', workflow, 'route to `confirm_creation`'],
      ['discuss-phase-assumptions', assumptions, 'Route to confirm_creation step'],
    ]) {
      const advance = doc.step('auto_advance');
      advance.lacks(banned, `${label} auto_advance fallback must not route back to confirm_creation (circular) (#2772)`)
        .satisfies((text) => need(ENDS_WORKFLOW.some((phrase) => mentions(text, phrase)), 'neither phrase found'),
          `${label} auto_advance fallback must explicitly END the workflow (#2772)`);
    }

    let parentBlock; // stays undefined when the parent block is missing (already one finding)
    workflow.slice('<answer_validation>', '</answer_validation>')
      .satisfies((text) => { parentBlock = text; return true; }, 'the parent answer_validation block must load');
    const assumptionAnswers = assumptions.slice('<answer_validation>', '</answer_validation>');
    assumptionAnswers.has('"Other" with empty text', 'assumptions answer_validation must include the "Other" empty-text branch (was drifted) (#2772)')
      .satisfies((text) => (parentBlock === undefined ? true : need(text === parentBlock, 'the blocks differ')),
        'discuss-phase-assumptions answer_validation must match the parent canonical block exactly (single source of truth) (#2772)');

    // #5629: every discuss mode carries the same check_spec contract, and decides WHAT to discuss under HOW only.
    const specSteps = {};
    const specDocs = {};
    const assumptionsPrompt = assumptions.slice(SPEC_ANALYZER_OPEN, SPEC_ANALYZER_CLOSE);
    for (const [mode, doc] of [['default', workflow], ['assumptions', assumptions], ['power', power]]) {
      const step = doc.step('check_spec');
      specDocs[mode] = step;
      step.satisfies((text) => { specSteps[mode] = text; return true; }, 'check_spec step must load');
      step.satisfies((text) => {
        const missing = ['has_spec', 'spec_path'].filter((word) => !text.includes(word));
        return need(missing.length === 0, `missing ${missing.join(', ')}`);
      }, `${mode}: check_spec reads the init facts has_spec / spec_path`)
        .has('spec_loaded = true', `${mode}: check_spec sets spec_loaded`)
        .has('locked_requirements', `${mode}: check_spec stores the locked requirements`);
      doc.has('<spec_lock>', `${mode}: the CONTEXT.md it writes carries <spec_lock>`)
        .has('Locked requirements — MUST read before planning', `${mode}: the SPEC is listed in canonical_refs`);
      const how = mode === 'default' ? workflow.slice('2b. **SPEC.md awareness**', '3. **Gray areas**')
        : mode === 'assumptions' ? assumptionsPrompt : doc.step('analyze');
      how.satisfies((text) => {
        const missing = ['HOW', 'WHAT'].filter((word) => !hasWord(text, word));
        return need(missing.length === 0, `missing ${missing.join(', ')}`);
      }, `${mode}: the step that picks what to discuss restricts it to HOW (WHAT is already locked)`);
    }
    for (const mode of ['assumptions', 'power']) {
      specDocs[mode].satisfies((text) => (specSteps.default === undefined ? true : need(text === specSteps.default, 'the bodies differ')),
        `${mode} check_spec matches the default flow exactly (single source of truth)`);
    }
    // The steps' own checks report a missing marker; the order is judged only when both are there.
    power.satisfies((text) => precedes(text, '<step name="check_spec">', '<step name="analyze">'),
      'check_spec runs before analyze: --power is dispatched past discuss-phase.md check_spec');
    assumptions.satisfies((text) => precedes(text, '<step name="check_spec">', '<step name="deep_codebase_analysis">', true),
      'check_spec runs before the analyzer step');
    assumptionsPrompt.satisfies((text) => {
      const missing = ['Locked requirements', '{locked_requirements}'].filter((word) => !text.includes(word));
      return need(missing.length === 0, `missing ${missing.join(', ')}`);
    }, 'the analyzer prompt carries the locked requirements')
      .has('HOW', 'the analyzer is told to form assumptions about HOW only');
    plan.has('_gsd_field "$INIT" spec_path', 'plan-phase.md reads spec_path from its init payload');

    // No workflow globs for the phase SPEC itself; discuss-phase.md and plan-phase.md also keep their own literal out.
    const lines = loadLib(loadTextLines, 'gsd-core/bin/lib/text-lines.cjs');
    if (lines.error) ctx.fail('gsd-core/bin/lib/text-lines.cjs', lines.error);
    const split = lines.error ? (text) => text.split('\n') : lines.lib.splitLines;
    const named = new Map([[WORKFLOW, workflow], [POWER, power], [POWER_MODE, powerMode], [ADVISOR, advisor], [AUTO, auto], [ASSUMPTIONS, assumptions], [PLAN_PHASE, plan]]);
    for (const rel of ctx.list(WORKFLOWS_DIR, '.md', 'the workflows must exist')) {
      (named.get(rel) || ctx.doc(rel)).satisfies((text) => noSpecGlob(text, OWN_SPEC_RULES[rel], split),
        'workflows read has_spec / spec_path from init instead of an ls over *-SPEC.md');
    }
  };
}

module.exports = {
  id: 'discuss-phase-power',
  issue: '#1513',
  walkers: { hasWord, mentions, readsAgentDef, lsGlobsSpec, noSpecGlob, precedes, buildCheck },
  check: buildCheck(),
};
