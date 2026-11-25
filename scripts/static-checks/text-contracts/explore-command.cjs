'use strict';

// /gsd:explore (#2229, #2543, #4648): the command has its frontmatter and points at the workflow; the workflow references
// questioning.md and domain-probes.md, documents the six output types, asks one question at a time, needs an explicit user
// selection before writing, respects commit_docs, and carries the research-pass claim disposition: the Unresolved-ledger anchor in
// Step 3, the [admit:/[refute:/[abstain: tags in the researcher spawn prompt (a refute needs a source authoritative for the claim)
// and in gsd-phase-researcher.md, the 5-value ledger-reason enum identical in explore.md, CONTEXT.md and the researcher agent, the
// conflict-abstention rule, the resolved researcher tier and bound model, the Tier-floor bullet (keyed on RESEARCHER_TIER and
// haiku, covering unknown/inherit/empty, turning a would-be admit into an abstain, disclosing both residual cases and sparing
// refute and abstain), the refute-versus-abstain procedure, the gsd_run bootstrap before the probe and before Step 3, the
// crystallize step's carry of the disposition, the Step 4 sink fence and exactly two guard bullets; step 5 plants seeds through
// `/gsd:capture --seed` and plant-seed.md still defines the contract. The tests' self-checks of their own helpers (the ledger anchor
// strip, the decoy bullet) are not carried over; "New phase" replaces the old `New phase || phase` (the first is the phrase the file
// carries). Was tests/explore-command.test.cjs.

const { asciiLower } = require('./lib/ascii-lower.cjs');
const { precedesWithin } = require('./lib/precedes-within.cjs');
const { hasSequence } = require('./lib/has-sequence.cjs');
const { LINE_ENDS } = require('./lib/line-ends.cjs');
const { includesBounded, precedesBounded, windowChain, collapseWhitespace } = require('./lib/bounded-walks.cjs');

const COMMAND = 'commands/gsd/explore.md';
const WORKFLOW = 'gsd-core/workflows/explore.md';
const RESEARCHER = 'agents/gsd-phase-researcher.md';
const PLANT_SEED = 'gsd-core/workflows/plant-seed.md';
const CONTEXT = 'CONTEXT.md';
const DOT = new Set(['.']);
const TAGS = ['[admit:', '[refute:', '[abstain:'];
const SPAWN_AGENT = 'Agent(';
const SPAWN_TYPE = 'subagent_type="gsd-phase-researcher"';
const MODEL_ATTRIBUTE = 'model="{RESEARCHER_MODEL}"';
const MODEL_REACH = 200;
const LEDGER_ANCHOR = 'put it in the **Unresolved ledger**, **never smoothed into the narrative**';
const LEDGER_TAIL = 'untagged — disposition not reported';
const LEDGER_EXCLUDED = new Set(['`', '|', '{', '}', '(', ')']);
const PREAMBLE = '_GSD_SHIM_NAME="gsd-tools.cjs"';
const TIER_PROBE = 'resolve-model gsd-phase-researcher --pick tier';
const TIER_WORDS = ['resolve-model', 'gsd-phase-researcher', '--pick', 'tier'];
const WINDOW = 60;

// The text from the first `from` to the first `to`, which must come after it, or the reason it cannot be had.
function regionOf(text, from, to) {
  const start = text.indexOf(from);
  const end = text.indexOf(to);
  if (start === -1) return { error: `${JSON.stringify(from)} not found` };
  if (end === -1) return { error: `${JSON.stringify(to)} not found` };
  if (start >= end) return { error: `${JSON.stringify(from)} must come before ${JSON.stringify(to)}` };
  return { text: text.slice(start, end) };
}

// The text from the first `from` to the first `to` found AFTER it (the guard list's slice), or the reason it cannot be had.
function regionAfter(text, from, to) {
  const start = text.indexOf(from);
  if (start === -1) return { error: `${JSON.stringify(from)} not found` };
  const end = text.indexOf(to, start);
  if (end === -1) return { error: `${JSON.stringify(to)} not found after ${JSON.stringify(from)}` };
  return { text: text.slice(start, end) };
}

// A predicate over one region: the region's own finding is made once, by `regionProblem`, so a bad region passes here.
const inRegion = (from, to, predicate, find = regionOf) => (text) => {
  const region = find(text, from, to);
  return region.text === undefined ? true : predicate(region.text);
};
const regionProblem = (from, to, find = regionOf) => (text) => find(text, from, to).error || true;

// The Step 3, Step 4 and Step 6 headings (first occurrence of each) in that order, or what is wrong.
function stepsProblem(text) {
  const [s3, s4, s6] = ['## Step 3', '## Step 4', '## Step 6'].map((heading) => text.indexOf(heading));
  if (s3 === -1 || s4 === -1 || s6 === -1) return `not found: ${['## Step 3', '## Step 4', '## Step 6'].filter((heading, i) => [s3, s4, s6][i] === -1).join(', ')}`;
  return (s3 < s4 && s4 < s6) || 'the headings are out of order';
}

// The researcher spawn: from the first `Agent(` to the first researcher subagent_type, in that order.
function spawnOf(text) {
  const agent = text.indexOf(SPAWN_AGENT);
  const type = text.indexOf(SPAWN_TYPE);
  if (agent === -1) return { error: `"${SPAWN_AGENT}" not found` };
  if (type === -1) return { error: `${SPAWN_TYPE} not found` };
  if (type < agent) return { error: `${SPAWN_TYPE} comes before "${SPAWN_AGENT}"` };
  return { prompt: text.slice(agent, type), reach: text.slice(agent, type + MODEL_REACH) };
}
const inSpawn = (pick, predicate) => (text) => {
  const spawn = spawnOf(text);
  return spawn.error === undefined ? predicate(spawn[pick]) : true;
};

// The 5-value ledger-reason enum copies of a text, the walk of
// /`?unverifiable`?(?: \| `?[^`|{}()]+`?){3} \| `?untagged — disposition not reported`?/g over its whitespace-collapsed text,
// each as the five trimmed values.
function ledgerEnums(text) {
  const t = collapseWhitespace(text);
  const copies = [];
  let from = 0;
  for (let at = t.indexOf('unverifiable', from); at !== -1; at = t.indexOf('unverifiable', from)) {
    const match = enumAt(t, at + 'unverifiable'.length);
    if (match) {
      copies.push(['unverifiable', ...match.values, LEDGER_TAIL]);
      from = match.end;
    } else {
      from = at + 1;
    }
  }
  return copies;
}

function enumAt(t, start) {
  let pos = start;
  if (t[pos] === '`') pos += 1;
  const values = [];
  for (let group = 0; group < 3; group += 1) {
    if (!t.startsWith(' | ', pos)) return null;
    pos += 3;
    if (t[pos] === '`') pos += 1;
    let run = pos;
    while (run < t.length && !LEDGER_EXCLUDED.has(t[run])) run += 1;
    if (run === pos) return null;
    if (t[run] === '`' && t.startsWith(' | ', run + 1)) {
      values.push(t.slice(pos, run).trim());
      pos = run + 1;
    } else if (run - 1 > pos && t[run - 1] === ' ' && t[run] === '|' && t[run + 1] === ' ') {
      values.push(t.slice(pos, run - 1).trim());
      pos = run - 1;
    } else {
      return null;
    }
  }
  if (!t.startsWith(' | ', pos)) return null;
  pos += 3;
  if (t[pos] === '`') pos += 1;
  if (!t.startsWith(LEDGER_TAIL, pos)) return null;
  pos += LEDGER_TAIL.length;
  if (t[pos] === '`') pos += 1;
  return { end: pos, values };
}

// The Tier-floor bullet: from the bullet marker to the next top-level bullet (or the end of the file), whitespace-collapsed;
// null when the marker is absent.
function tierFloorClause(text) {
  const start = text.indexOf('- **Tier floor**');
  if (start === -1) return null;
  const end = text.indexOf('\n- **', start + 1);
  return collapseWhitespace(text.slice(start + 1, end === -1 ? text.length : end));
}
const onClause = (predicate) => (text) => {
  const clause = tierFloorClause(text);
  return clause === null ? true : predicate(clause);
};

// /\[refute:[^\]]*\]\s*\([^)]*authoritative[^)]*\)/i over a spawn prompt: a refute tag whose parenthesised qualifier names authority.
function hasAuthoritativeRefute(prompt) {
  const lower = asciiLower(prompt);
  for (let at = lower.indexOf('[refute:'); at !== -1; at = lower.indexOf('[refute:', at + 1)) {
    const close = lower.indexOf(']', at + '[refute:'.length);
    if (close === -1) return false;
    let pos = close + 1;
    while (pos < lower.length && /\s/.test(lower[pos])) pos += 1;
    if (lower[pos] !== '(') continue;
    const end = lower.indexOf(')', pos + 1);
    if (end === -1) return false;
    if (lower.slice(pos + 1, end).includes('authoritative')) return true;
  }
  return false;
}

// The conflict-abstention phrasing: conflict and the word ledger in one sentence, in either order (`[^.]*`).
const conflictLedger = (lower) => precedesBounded(lower, 'conflict', 'ledger', DOT, { second: true })
  || precedesBounded(lower, 'ledger', 'conflict', DOT, { first: true });

// The number of lines of a text that start with `- **` (the top-level guard bullets).
function topLevelBullets(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if ((i === 0 || LINE_ENDS.has(text[i - 1])) && text.startsWith('- **', i)) count += 1;
  }
  return count;
}

function check(ctx) {
  const command = ctx.doc(COMMAND);
  command
    .frontmatter()
    .has('name: gsd:explore', 'the command must have name frontmatter')
    .has('description:', 'the command must have description frontmatter')
    .has('allowed-tools:', 'the command must have allowed-tools frontmatter');
  command.has('workflows/explore.md', 'the command must reference workflows/explore.md in execution_context');

  const workflow = ctx.doc(WORKFLOW);
  workflow
    .has('questioning.md', 'the workflow must reference questioning.md')
    .has('domain-probes.md', 'the workflow must reference domain-probes.md')
    .has('Note', 'the workflow must document the Note output type')
    .has('Todo', 'the workflow must document the Todo output type')
    .has('Seed', 'the workflow must document the Seed output type')
    .has('Research question', 'the workflow must document the Research question output type')
    .has('Requirement', 'the workflow must document the Requirement output type')
    .has('New phase', 'the workflow must document the New phase output type')
    .has('one question at a time', 'the workflow must mention the "one question at a time" principle')
    .satisfies((text) => text.includes('explicit user selection') || text.includes('Never write artifacts without') || 'neither phrase is present',
      'the workflow must require user confirmation before writing artifacts')
    .has('commit_docs', 'the workflow must respect the commit_docs configuration')
    .satisfies(stepsProblem, 'the Step 3, Step 4 and Step 6 headings must exist in that order')
    .satisfies(inRegion('## Step 3', '## Step 4', (region) => region.includes(LEDGER_ANCHOR) || 'the anchor sentence is missing'),
      'the Step-3 region must state that an abstained claim is routed to the Unresolved ledger and never smoothed into prose')
    .satisfies((text) => {
      const spawn = spawnOf(text);
      return spawn.error || true;
    }, 'the researcher spawn must be found')
    .satisfies(inSpawn('prompt', (prompt) => {
      const missing = TAGS.filter((tag) => !prompt.includes(tag));
      return missing.length === 0 || `missing: ${missing.join(', ')}`;
    }), 'the spawn prompt must ask the researcher for the [admit:/[refute:/[abstain: tags')
    .satisfies(inSpawn('prompt', (prompt) => hasAuthoritativeRefute(prompt) || 'no [refute: ...] (...authoritative...) qualifier'),
      "the spawn prompt's refute arm must require the contradicting source be AUTHORITATIVE for the claim")
    .satisfies((text) => hasSequence(text, TIER_WORDS) || 'not found',
      'the tier floor needs the resolved tier as its trigger: a `resolve-model gsd-phase-researcher --pick tier` binding')
    .satisfies((text) => hasSequence(text, ['resolve-model', 'gsd-phase-researcher', '--pick', 'model']) || 'not found',
      'the spawn must bind the researcher model per model-profile-resolution.md')
    .satisfies(inSpawn('reach', (reach) => reach.includes(MODEL_ATTRIBUTE) || `no ${MODEL_ATTRIBUTE}`),
      'the Agent() spawn must pass the bound model: omitting model= makes the agent inherit the orchestrator model')
    .satisfies((text) => asciiLower(text).includes('omit `model=` entirely when `researcher_model` is `inherit` or empty') || 'not found',
      '#2517 requires the omit-on-inherit/empty rule to ride with any model= binding')
    .satisfies((text) => (text.includes('- **Tier floor**') ? true : 'not found'), 'the Tier floor bullet must exist')
    .satisfies(onClause((clause) => includesBounded(clause, 'RESEARCHER_TIER') || 'not found'),
      'the floor must reference RESEARCHER_TIER, the single signal')
    .satisfies(onClause((clause) => !includesBounded(clause, 'RESEARCHER_TIER') || precedesBounded(clause, 'RESEARCHER_TIER', 'haiku', DOT, { second: true }) || 'not found'),
      'the floor must name `haiku` as the budget tier for gsd-phase-researcher')
    .satisfies(onClause((clause) => {
      const lower = asciiLower(clause);
      const missing = ['unknown', 'inherit', 'empty'].filter((word) => !includesBounded(lower, word));
      return missing.length === 0 || `missing: ${missing.join(', ')}`;
    }), 'the floor must cover an unreadable tier: unknown, inherit and empty')
    .satisfies(onClause((clause) => clause.includes('would-be **admit** as an **abstain**') || 'not found'),
      'the floor must state that a would-be admit is presented as an abstain')
    .satisfies(onClause((clause) => {
      const lower = asciiLower(clause);
      return !(includesBounded(lower, 'do not suppress') || lower.includes('as an **admit**, unchanged')) || 'an inverted floor is present';
    }), 'an inverted floor must fail')
    .satisfies(onClause((clause) => {
      const missing = ['model_overrides', 'model_profile_overrides'].filter((word) => !includesBounded(clause, word));
      return missing.length === 0 || `missing: ${missing.join(', ')}`;
    }), 'the disclosed residual must name both the model_overrides and the model_profile_overrides cases')
    .satisfies(onClause((clause) => asciiLower(clause).includes('two cases') || 'not found'),
      'the residual must be counted as "two cases"')
    .satisfies(onClause((clause) => !asciiLower(clause).includes('one case remains') || 'the stale heading is present'),
      'the stale "one case remains" heading must not survive alongside the second disclosed case')
    .has('`refute` and `abstain` are unaffected', 'the floor suppresses unearned confidence only: it must not also suppress corrections')
    .satisfies((text) => asciiLower(collapseWhitespace(text)).includes('authoritative') || 'not found',
      'refute versus abstain needs a discriminator: source authority for the claim')
    .satisfies((text) => {
      const lower = asciiLower(collapseWhitespace(text));
      return precedesWithin(lower, 'strong prior', 'never authoritative', DOT) || precedesWithin(lower, 'never authoritative', 'prior', DOT) || 'not found';
    }, 'a "strong prior" must be stated as never authoritative alone, or it can be read as grounds for a refute')
    .satisfies((text) => {
      const preamble = text.indexOf(PREAMBLE);
      const probe = text.indexOf(TIER_PROBE);
      if (preamble === -1) return 'the gsd_run bootstrap preamble must exist in the file';
      // A probe that is absent altogether is the finding of the `--pick tier` binding assertion above.
      if (probe === -1) return hasSequence(text, TIER_WORDS) ? 'the tier probe must be spelled with single blanks: resolve-model gsd-phase-researcher --pick tier' : true;
      return preamble < probe || 'the preamble comes after the tier-floor probe';
    }, 'gsd_run must be bootstrapped before the tier-floor probe runs')
    .satisfies(inRegion('## Step 4', '## Step 6', (region) => {
      const lower = asciiLower(region);
      return windowChain(lower, ['unresolved', 'never', 'crystalliz'], WINDOW, DOT) || 'not found';
    }), 'Steps 4-5 must forbid crystallizing an unresolved-ledger claim as a flat assertion')
    .satisfies(inRegion('## Step 4', '## Step 6', (region) => windowChain(asciiLower(region), ['carry', 'disposition'], WINDOW, DOT) || 'not found'),
      'Steps 4-5 must carry the research disposition into the durable artifact')
    .satisfies(inRegion('## Step 4', '## Step 6', (region) => region.includes('untrusted-input-boundary') || 'not found'),
      'Step 4 must reference @gsd-core/references/untrusted-input-boundary.md when quoting research text into a durable file')
    .satisfies(inRegion('## Step 4', '## Step 6', (region) => asciiLower(region).includes('fresh random') || asciiLower(region).includes('data_') || 'neither phrase is present'),
      'Step 4 must require a fresh/random per-wrap delimiter when fencing quoted research text')
    .lacks('Three guards', '"Three guards" must not appear: the untagged-findings rule moved out of the guard list into its own paragraph')
    .satisfies(regionProblem('Two guards ride with it:', '**Untagged findings.**', regionAfter), 'the guard-list intro must read "Two guards ride with it:" and the untagged-findings paragraph must follow it')
    .satisfies(inRegion('Two guards ride with it:', '**Untagged findings.**', (region) => {
      const bullets = topLevelBullets(region);
      return bullets === 2 || `found ${bullets} top-level guard bullets`;
    }, regionAfter), 'exactly 2 top-level guard bullets are expected')
    .satisfies((text) => {
      const first = text.indexOf(PREAMBLE);
      const last = text.lastIndexOf(PREAMBLE);
      if (first === -1) return true;
      return first === last || 'the preamble is inlined more than once';
    }, 'the launcher preamble must be inlined exactly once')
    .satisfies((text) => {
      const first = text.indexOf(PREAMBLE);
      const use = text.indexOf('gsd_run');
      if (first === -1) return true;
      if (use === -1) return 'gsd_run must be used somewhere in the file';
      return first < use || 'gsd_run is used before the preamble that defines it';
    }, 'the preamble that DEFINES gsd_run must appear before the first USE of gsd_run anywhere in the file')
    .satisfies((text) => {
      const first = text.indexOf(PREAMBLE);
      const step3 = text.indexOf('## Step 3');
      if (first === -1 || step3 === -1) return true;
      return first < step3 || 'the preamble comes after the Step 3 heading';
    }, 'the launcher preamble must be bootstrapped before Step 3, not gated behind the optional research offer')
    .has('/gsd:capture --seed', 'explore step 5 must delegate seeds via /gsd:capture --seed, the only command surface routing to the plant-seed workflow')
    .lacks('trigger_condition', 'the divergent trigger_condition field name must be gone: readers read trigger_when')
    .lacks('planted_date', 'the divergent planted_date field name must be gone: plant-seed writes planted/planted_during')
    .lacks('Create `.planning/seeds/{slug}.md`', 'the hand-written seeds/{slug}.md shape must be gone: no reader selects files without the SEED- prefix')
    .has('list-seeds', 'the seed instruction must name list-seeds')
    .has('audit-open', 'the seed instruction must name audit-open')
    .has('new-milestone', 'the seed instruction must name new-milestone');

  const researcher = ctx.doc(RESEARCHER);
  researcher
    .satisfies((text) => asciiLower(text).includes('claim-disposition mode') || 'not found',
      'gsd-phase-researcher.md must document the claim-disposition mode; without it the shared agent never emits the admit tag')
    .satisfies((text) => {
      const missing = TAGS.filter((tag) => !text.includes(tag));
      return missing.length === 0 || `missing: ${missing.join(', ')}`;
    }, 'the researcher agent must define the [admit:/[refute:/[abstain: disposition tags');

  const plantSeed = ctx.doc(PLANT_SEED);
  plantSeed
    .has('SEED-', 'plant-seed must mint SEED- ids')
    .has('status: dormant', 'plant-seed must write status: dormant')
    .has('trigger_when', 'plant-seed must write trigger_when');

  // The ledger-reason enum is one list: the copies within explore.md are identical, and the first copy of CONTEXT.md and of the
  // researcher agent equals the first of explore.md.
  let reference = null;
  workflow.satisfies((text) => {
    const found = ledgerEnums(text);
    if (found.length === 0) return 'explore.md must carry at least one copy of the 5-value ledger-reason enum';
    if (found.length < 2) return `explore.md must carry at least 2 copies of the 5-value ledger-reason enum; found ${found.length}`;
    const first = JSON.stringify(found[0]);
    if (!found.every((copy) => JSON.stringify(copy) === first)) return 'the copies within explore.md are not byte-identical';
    reference = first;
    return true;
  }, 'every ledger-enum copy within explore.md must be byte-identical to every other');
  const outside = (label) => (text) => {
    const found = ledgerEnums(text);
    if (found.length === 0) return `${label} must carry at least one copy of the 5-value ledger-reason enum`;
    if (reference === null) return true;
    return JSON.stringify(found[0]) === reference || `${label} has drifted from explore.md; keep all copies identical (#2543 M4)`;
  };
  ctx.doc(CONTEXT).satisfies(outside('CONTEXT.md'), 'the Unresolved-Ledger abstention reasons in CONTEXT.md must match explore.md');
  researcher.satisfies(outside('agents/gsd-phase-researcher.md'), 'the ledger-reason enum in the researcher agent must match explore.md');

  workflow.satisfies((text) => {
    const lower = asciiLower(text);
    return lower.includes('conflict-abstention') || conflictLedger(lower) || 'neither phrasing is present';
  }, 'the abstain arm must cover a source-vs-prior conflict (conflict-abstention), routing to the ledger');
}

module.exports = {
  walkers: { regionOf, spawnOf, ledgerEnums, tierFloorClause, hasAuthoritativeRefute, conflictLedger, topLevelBullets, regionAfter },
  id: 'explore-command',
  issue: '#2229',
  check,
};
