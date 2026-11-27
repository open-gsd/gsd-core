'use strict';

// The coincidental-reliance advisory of the verifier (#1955): for a truth that already reached VERIFIED the verifier
// classifies whether it holds for a guaranteed or an incidental reason. The rule and its invariants live in
// agents/gsd-verifier.md (applies only to VERIFIED truths, does not double-report routed truths, no re-flag of an accepted
// override, a do-not-flag list, evidence not self-rated confidence; changes neither score nor status, never emits a
// human-verification item, PRESENT_BEHAVIOR_UNVERIFIED stays the only excluded state, the per-truth token stays out of the
// status unions and the status enum, the qualifier suffixes VERIFIED); the report surface (items key, shape, survival);
// and parity with the standalone template, the verifier gate reference and docs/reference/agents.md. Was
// tests/verifier-coincidental-reliance.test.cjs. The old windows around the first mention (1400 characters either side,
// 500 around the frontmatter key) keep their size; the status-union lines and table cells are read by linear walks. The
// shipped libraries it uses are loaded through one helper, so a missing build is a finding and not a throw.

const path = require('node:path');

const { LINE_ENDS } = require('./lib/line-ends.cjs');
const { loadLib } = require('./lib/load-lib.cjs');

const VERIFIER = 'agents/gsd-verifier.md';
const TEMPLATE = 'gsd-core/templates/verification-report.md';
const AGENTS_DOC = 'docs/reference/agents.md';
const GATES = 'gsd-core/references/verifier-phase-gates.md';
const VERIFICATION_LIB = 'gsd-core/bin/lib/verification.cjs';
const QUALIFIER = '✓ VERIFIED (coincidental-reliance)';
const REASONS = ['undeclared-precondition', 'incidental-ordering', 'fixture-only'];
const RULE_RADIUS = 1400;
const ITEMS_RADIUS = 500;
const ITEMS_ANCHOR = 'coincidental_reliance_items: #';
const STATUSES = ['passed', 'gaps_found', 'human_needed'];

const shippedLib = (name) => loadLib(() => require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', name)), `gsd-core/bin/lib/${name}`);

// The source around the first occurrence of `needle`, `radius` characters either side, or null when it is absent.
function windowAround(text, needle, radius) {
  const at = text.indexOf(needle);
  return at === -1 ? null : text.slice(Math.max(0, at - radius), at + needle.length + radius);
}

const isWhitespace = (ch) => ch !== undefined && /\s/.test(ch);
const isStatusWord = (ch) => ch !== undefined && ((ch >= 'a' && ch <= 'z') || ch === '_');

// The lines of the form `status: a | b | c` (the old `^status:\s+[a-z_]+(?:\s*\|\s*[a-z_]+)+\s*$` with the m flag), each
// match from `status:` to the end of its line, read by one walk.
function statusUnionLines(text) {
  const lines = [];
  for (let i = 0; i < text.length; i += 1) {
    if (!((i === 0 || LINE_ENDS.has(text[i - 1])) && text.startsWith('status:', i))) continue;
    let at = i + 'status:'.length;
    const blankStart = at;
    while (isWhitespace(text[at])) at += 1;
    if (at === blankStart) continue;
    const firstStart = at;
    while (isStatusWord(text[at])) at += 1;
    if (at === firstStart) continue;
    // The end of the first word and of each `| word` alternative, in order: the pattern backtracks to fewer
    // alternatives when the line does not end after the last one.
    const ends = [at];
    for (;;) {
      let probe = ends[ends.length - 1];
      while (isWhitespace(text[probe])) probe += 1;
      if (text[probe] !== '|') break;
      probe += 1;
      while (isWhitespace(text[probe])) probe += 1;
      const wordStart = probe;
      while (isStatusWord(text[probe])) probe += 1;
      if (probe === wordStart) break;
      ends.push(probe);
    }
    for (let k = ends.length - 1; k >= 1; k -= 1) {
      const wordEnd = ends[k];
      let blankEnd = wordEnd;
      while (isWhitespace(text[blankEnd])) blankEnd += 1;
      let stop = -1;
      for (let q = blankEnd; q >= wordEnd; q -= 1) {
        if (q === text.length || LINE_ENDS.has(text[q])) {
          stop = q;
          break;
        }
      }
      if (stop !== -1) {
        lines.push(text.slice(i, stop));
        i = stop - 1;
        break;
      }
    }
  }
  return lines;
}

// The table cells that mention the advisory must render the suffixed verdict "✓ VERIFIED (coincidental-reliance)".
function qualifierSuffixes(text, splitTableRow) {
  const cells = text.split('\n').filter((line) => line.includes('|') && line.includes('coincidental-reliance'))
    .flatMap((line) => splitTableRow(line).filter((cell) => cell.includes('coincidental-reliance')));
  const bad = cells.find((cell) => !cell.includes(QUALIFIER));
  return bad === undefined || `a verdict cell must render as "${QUALIFIER}": ${bad.trim()}`;
}

// What the contract asks of the overall-status enum (the shipped module's frozen writer set): the problems found.
function statusEnumProblems(verification) {
  const statuses = verification === null || typeof verification !== 'object' ? undefined : verification.VERIFIER_STATUSES;
  if (!(statuses instanceof Set)) return ['the VERIFIER_STATUSES set must be present'];
  const found = [...statuses].map(String).sort();
  if (found.join(',') !== STATUSES.slice().sort().join(',')) {
    return [`the overall-status enum must stay ${STATUSES.slice().sort().join(', ')} (found: ${found.join(', ')})`];
  }
  return [];
}

module.exports = {
  id: 'verifier-coincidental-reliance',
  issue: '#1955',
  statusEnumProblems,
  loadLib,
  statusUnionLines,
  check(ctx) {
    // The table splitter is loaded once: when the library cannot be loaded that is one finding for the library and the
    // verdict-cell checks (which need it) are skipped.
    const table = shippedLib('markdown-table.cjs');
    if (table.error) ctx.fail('gsd-core/bin/lib/markdown-table.cjs', table.error);
    const qualifierCheck = (text) => table.error !== undefined || qualifierSuffixes(text, table.lib.splitTableRow);
    const verifier = ctx.doc(VERIFIER);
    verifier.has(/coincidental-reliance/, 'the verifier must define the coincidental-reliance advisory');
    for (const reason of REASONS) verifier.has(reason, `the verifier must name the '${reason}' trigger`);

    // Clauses that must sit with the rule, not anywhere in the file: a window around the first mention.
    const inRule = (pattern, why) => verifier.satisfies((text) => {
      const window = windowAround(text, 'coincidental-reliance', RULE_RADIUS);
      return window === null || pattern.test(window) || `no match for ${pattern} within ${RULE_RADIUS} characters of the first coincidental-reliance`;
    }, why);
    inRule(/✓ VERIFIED truth/, 'the advisory must apply only to truths that reached VERIFIED');
    inRule(/PRESENT_BEHAVIOR_UNVERIFIED/, 'the advisory must not double-report truths already routed to human verification (PRESENT_BEHAVIOR_UNVERIFIED)');
    inRule(/insufficient_spec/, 'the advisory must not double-report truths already routed to human verification (insufficient_spec)');
    inRule(/override/i, 'an accepted override must not be re-flagged');
    inRule(/(do not flag|don't flag|never flag)/i, 'the rule must carry a do-not-flag list bounding the false-positive surface');
    inRule(/(enforce|await|explicit sequenc)/i, 'the do-not-flag list must name code-established preconditions and enforced ordering');
    inRule(/default/i, 'the do-not-flag list must name defaults');
    inRule(/honest-verifier/, 'the rule must route on recorded evidence, citing honest-verifier');
    inRule(/confiden/i, 'the rule must say it does not route on self-rated confidence');
    inRule(/score/i, 'the rule must speak to the score');
    inRule(/(not the score|never the score|does not (change|affect) the score|no score)/i, 'the advisory must not change the verified score');
    inRule(/(not the status|never the status|does not (change|affect) the status|status is unchanged)/i, 'the advisory must not change the overall status');
    inRule(/never[^.]{0,80}human-verification item/i, 'the advisory must never emit a human-verification item');
    verifier
      .has('PRESENT_BEHAVIOR_UNVERIFIED truths are the *only* ones excluded from `verified_truths`', 'PRESENT_BEHAVIOR_UNVERIFIED must remain the only score-excluded truth state')
      .satisfies((text) => {
        const unions = statusUnionLines(text);
        if (unions.length === 0) return 'expected at least one status union line';
        for (const line of unions) {
          if (/coincidental/i.test(line)) return `the per-truth advisory leaked into the status vocabulary: ${line}`;
          for (const status of STATUSES) if (!line.includes(status)) return `the status union must still contain ${status}: ${line}`;
        }
        return true;
      }, 'the per-truth advisory must never leak into the status vocabulary')
      .satisfies(qualifierCheck, 'the qualifier must suffix VERIFIED, never replace it')
      .has(QUALIFIER, 'the agent must show the suffixed verdict form at least once')
      .has(/coincidental_reliance_items/, 'the report frontmatter must carry coincidental_reliance_items')
      .satisfies((text) => text.split('\n').some((line) => {
        const key = line.indexOf('coincidental_reliance_items:');
        if (key === -1) return false;
        const rest = key + 'coincidental_reliance_items:'.length;
        return line.indexOf('only if', rest) !== -1 || line.indexOf('Only if', rest) !== -1;
      }), 'the items list must be omitted when nothing is flagged (the only-if convention)')
      .has(ITEMS_ANCHOR, `the frontmatter must carry the \`${ITEMS_ANCHOR}\` key line`);
    const inItems = (pattern, why) => verifier.satisfies((text) => {
      const window = windowAround(text, ITEMS_ANCHOR, ITEMS_RADIUS);
      return window === null || pattern.test(window) || `no match for ${pattern} within ${ITEMS_RADIUS} characters of the frontmatter key`;
    }, why);
    inItems(/truth:/, 'an item must name the truth');
    inItems(/reason:/, 'an item must name the reason');
    inItems(/(harden|fix|precondition)/i, 'an item must name the hardening');
    inItems(/(regardless of (overall )?status|survive|never lost)/i, 'the items must survive a gaps_found phase');

    const template = ctx.doc(TEMPLATE);
    template
      .satisfies(qualifierCheck, 'the template qualifier must suffix VERIFIED, never replace it')
      .has('coincidental_reliance_items', 'the standalone template must carry the frontmatter items list');
    for (const token of ['coincidental-reliance', ...REASONS]) {
      template.has(token, `the standalone template must carry '${token}'`);
    }
    template.slice('**Per-truth states')
      .has(/coincidental-reliance/, 'the template guidelines must document the advisory per-truth state')
      .has(/apply the reliance check to every `✓ VERIFIED` truth/i, 'the template Guidelines must carry the imperative check, not just the row shape');

    ctx.doc(GATES)
      .satisfies((text) => text.split('\n').some((line) => {
        const at = line.indexOf('@');
        return at !== -1 && line.indexOf('gsd-core/templates/verification-report.md', at + 1) !== -1;
      }), 'verifier-phase-gates.md must point at the verification-report template')
      .lacks('coincidental-reliance', 'verifier-phase-gates.md must not grow a second copy of the rule without a deliberate decision');
    ctx.doc(AGENTS_DOC).has(/coincidental-reliance/, 'docs/reference/agents.md must document the coincidental-reliance advisory');

    // The overall-status enum the advisory must not enter (the shipped module's frozen writer set).
    const loaded = shippedLib('verification.cjs');
    if (loaded.error) {
      ctx.fail(VERIFICATION_LIB, loaded.error);
    } else {
      for (const problem of statusEnumProblems(loaded.lib)) ctx.fail(VERIFICATION_LIB, problem);
    }
  },
};
