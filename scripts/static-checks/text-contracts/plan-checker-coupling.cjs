'use strict';

// Dimension 3b of gsd-plan-checker, undeclared or temporal coupling between same-wave plans (#1954), and the advisory contract
// that rides with it (#3724). The agent doc carries a coupling-named `## Dimension 3b:` heading between Dimensions 3 and 4, a
// plan-pair scope, exactly three AND-ed trigger conditions, the exempt severity tier derived from revision-loop.md on every yaml
// example (never a blocker), the dependency_correctness key, an enumerated "Do NOT flag" list, the Dimension 9 deferral, the
// coupling_justified exemption (surfaced as an info advisory) and a coupling line in `<success_criteria>`; Dimension 3 keeps its
// blocker example; the numbered dimensions (fences stripped) are unique, at least twelve, include 3b and are all rows of the
// docs/reference/agents.md plan-checker table, which names coupling; plan-phase (both arms), verify-work, quick mode and import
// accept an explicitly-INFO-only issues block and carry the fail-closed clause verbatim, agent-contracts lists import.md, the
// planner points at planner-coupling.md and the reference teaches the rule. Dropped: the self-test of the condition counter (a
// helper defined in the old test; the real step is the row of the contract) and the `existsSync` of the reference (the engine's
// missing-file finding). Was tests/plan-checker-coupling.test.cjs.

const path = require('node:path');
const { asciiLower } = require('./lib/ascii-lower.cjs');
const { loadLib } = require('./lib/load-lib.cjs');
const { LINE_ENDS } = require('./lib/line-ends.cjs');
const { precedesBounded, libCaller } = require('./lib/bounded-walks.cjs');

const AGENT = 'agents/gsd-plan-checker.md';
const DOCS_AGENTS = 'docs/reference/agents.md';
const REVISION_LOOP = 'gsd-core/references/revision-loop.md';
const PLAN_PHASE = 'gsd-core/workflows/plan-phase.md';
const PLANNER = 'agents/gsd-planner.md';
const COUPLING_REF = 'gsd-core/references/planner-coupling.md';
const VERIFY_WORK = 'gsd-core/workflows/verify-work.md';
const QUICK_LOOP = 'gsd-core/workflows/quick/steps/plan-checker-loop.md';
const IMPORT = 'gsd-core/workflows/import.md';
const AGENT_CONTRACTS = 'gsd-core/references/agent-contracts.md';
const SECTIONIZER = 'gsd-core/bin/lib/markdown-sectionizer.cjs';
const TEXT_LINES = 'gsd-core/bin/lib/text-lines.cjs';
const REAL_ROOT = path.join(__dirname, '..', '..', '..');
const WS = /\s/;
const NEWLINE = new Set(['\n']);

const D3 = '## Dimension 3: ';
const D3B = '## Dimension 3b: ';
const D4 = '## Dimension 4: ';
const PARSE_LINE = 'Parse issue count from checker return:';
const ARM_LINE = '**If iteration_count >= 3:**';
const ARM_WINDOW = 5;
const VERIFY_LINE = '- **ISSUES FOUND:**';
const QUICK_LINE = '- **`## ISSUES FOUND`:**';
const IMPORT_LINE = 'Handle the checker return by severity';
const CONTRACTS_ROW = '| gsd-plan-checker |';
const CLAUSE = 'an entry whose severity is missing or unrecognized counts as a BLOCKER (fail closed)';
const MIN_DIMENSIONS = 12;
const ITEM_COUNT = 3;

// Visits the offset of every line start (the start of the text, and after each of LF, CR, U+2028 and U+2029): the `^` of /m.
function eachLineStart(text, visit) {
  for (let i = 0; i <= text.length; i += 1) {
    if ((i === 0 || LINE_ENDS.has(text[i - 1])) && visit(i) === true) return true;
  }
  return false;
}

const lineEndFrom = (text, from) => {
  let end = from;
  while (end < text.length && !LINE_ENDS.has(text[end])) end += 1;
  return end;
};

// The first line that starts with `prefix`, at its offset, or -1: /^prefix/m.
function headingIndex(text, prefix) {
  let found = -1;
  eachLineStart(text, (i) => {
    if (!text.startsWith(prefix, i)) return false;
    found = i;
    return true;
  });
  return found;
}

// The first line that is exactly `line`, at its offset, or -1: /^line$/m.
function exactLineIndex(text, line) {
  let found = -1;
  eachLineStart(text, (i) => {
    if (!text.startsWith(line, i) || lineEndFrom(text, i) !== i + line.length) return false;
    found = i;
    return true;
  });
  return found;
}

// The text between two located starts, or the reason there is none.
function between(text, start, end, fromLabel, toLabel) {
  if (start === -1) return { error: `start heading not found: ${fromLabel}` };
  if (end === -1) return { error: `end heading not found: ${toLabel}` };
  if (end <= start) return { error: `end heading precedes start heading: ${fromLabel} .. ${toLabel}` };
  return { text: text.slice(start, end) };
}
const headingSpan = (text, from, to) => between(text, headingIndex(text, from), headingIndex(text, to), from, to);
const inSpan = (from, to, predicate) => (text) => {
  const span = headingSpan(text, from, to);
  return span.text === undefined ? true : predicate(span.text);
};

// The title of the first `## Dimension 3b: ` line with at least one character after the prefix, or null: /^## Dimension 3b: (.+)$/m.
function coupledTitle(text) {
  let title = null;
  eachLineStart(text, (i) => {
    if (!text.startsWith(D3B, i)) return false;
    const from = i + D3B.length;
    const end = lineEndFrom(text, from);
    if (end === from) return false;
    title = text.slice(from, end);
    return true;
  });
  return title;
}

// `lead`, then at least `minGap` whitespace characters, then `tail`: /lead\s{minGap,}tail/ (the tail starts with no whitespace).
function leadGapTail(text, lead, tail, minGap) {
  for (let at = text.indexOf(lead); at !== -1; at = text.indexOf(lead, at + 1)) {
    let pos = at + lead.length;
    while (pos < text.length && WS.test(text[pos])) pos += 1;
    if (pos - at - lead.length >= minGap && text.startsWith(tail, pos)) return true;
  }
  return false;
}

// /never\s+(a\s+)?blocker/ over the ASCII-lower-cased text.
function neverBlocker(lower) {
  for (let at = lower.indexOf('never'); at !== -1; at = lower.indexOf('never', at + 1)) {
    let pos = at + 'never'.length;
    const gap = pos;
    while (pos < lower.length && WS.test(lower[pos])) pos += 1;
    if (pos === gap) continue;
    if (lower.startsWith('blocker', pos)) return true;
    if (lower[pos] === 'a') {
      let next = pos + 1;
      while (next < lower.length && WS.test(lower[next])) next += 1;
      if (next > pos + 1 && lower.startsWith('blocker', next)) return true;
    }
  }
  return false;
}

// The number of lines that start with digits and `. `: the top-level ordered-list items, /^\d+\. /gm.
function countOrderedItems(span) {
  let count = 0;
  eachLineStart(span, (i) => {
    let pos = i;
    while (pos < span.length && span[pos] >= '0' && span[pos] <= '9') pos += 1;
    if (pos > i && span.startsWith('. ', pos)) count += 1;
    return false;
  });
  return count;
}

// Whether a line that starts `- [ ] ` mentions coupling in any case: /^- \[ \] .*coupling.*$/im.
function hasCouplingChecklist(span) {
  return eachLineStart(span, (i) => {
    if (!span.startsWith('- [ ] ', i)) return false;
    return asciiLower(span.slice(i + 6, lineEndFrom(span, i))).includes('coupling');
  });
}

// The word after `severity:` and optional whitespace on a line (the first occurrence with one), lower-cased, or null.
function severityOf(line) {
  for (let at = line.indexOf('severity:'); at !== -1; at = line.indexOf('severity:', at + 1)) {
    let pos = at + 'severity:'.length;
    while (pos < line.length && WS.test(line[pos])) pos += 1;
    let end = pos;
    while (end < line.length && ((line[end] >= 'a' && line[end] <= 'z') || (line[end] >= 'A' && line[end] <= 'Z') || (line[end] >= '0' && line[end] <= '9') || line[end] === '_')) end += 1;
    if (end > pos) return asciiLower(line.slice(pos, end));
  }
  return null;
}

// The severity tokens inside the span's fenced yaml blocks, in order (a block never closed runs to the end of the span).
// Fences are found on the lines with their leading blanks trimmed, as the old loop trimmed every line (a fence under a list item counts).
function yamlSeverityTiers(span, { splitLines, scanFencedBlocks }) {
  const lines = splitLines(span);
  const tiers = [];
  for (const block of scanFencedBlocks(lines.map((line) => line.trimStart()))) {
    if ((block.infoString || '').trim() !== 'yaml') continue;
    const end = block.closeLineIdx === -1 ? lines.length : block.closeLineIdx;
    for (const line of lines.slice(block.openLineIdx + 1, end)) {
      const tier = severityOf(line);
      if (tier !== null) tiers.push(tier);
    }
  }
  return tiers;
}

// The tier a revision loop exempts: the word of the first `If PASSED or only <word>-level issues`, lower-cased, or null.
function exemptTier(text) {
  const lead = 'If PASSED or only ';
  for (let at = text.indexOf(lead); at !== -1; at = text.indexOf(lead, at + 1)) {
    const from = at + lead.length;
    let end = from;
    while (end < text.length && ((text[end] >= 'a' && text[end] <= 'z') || (text[end] >= 'A' && text[end] <= 'Z') || (text[end] >= '0' && text[end] <= '9') || text[end] === '_')) end += 1;
    if (end > from && text.startsWith('-level issues', end)) return asciiLower(text.slice(from, end));
  }
  return null;
}

// The labels of every numbered dimension heading, `## Dimension 3b: ` style, in order.
function dimensionLabels(text) {
  const labels = [];
  const lead = '## Dimension ';
  eachLineStart(text, (i) => {
    if (!text.startsWith(lead, i)) return false;
    let pos = i + lead.length;
    const from = pos;
    while (pos < text.length && text[pos] >= '0' && text[pos] <= '9') pos += 1;
    if (pos === from) return false;
    if (text[pos] >= 'a' && text[pos] <= 'z' && text.startsWith(': ', pos + 1)) pos += 1;
    if (text.startsWith(': ', pos)) labels.push(text.slice(from, pos));
    return false;
  });
  return labels;
}

// The labels of every table row that starts `| <digits><letter?> | `.
function tableLabels(section) {
  const labels = [];
  eachLineStart(section, (i) => {
    if (!section.startsWith('| ', i)) return false;
    let pos = i + 2;
    const from = pos;
    while (pos < section.length && section[pos] >= '0' && section[pos] <= '9') pos += 1;
    if (pos === from) return false;
    if (section[pos] >= 'a' && section[pos] <= 'z' && section.startsWith(' | ', pos + 1)) pos += 1;
    if (section.startsWith(' | ', pos)) labels.push(section.slice(from, pos));
    return false;
  });
  return labels;
}

// The first line that starts with `prefix`, or null; and the next `size` lines from it joined with a space.
const findLine = (lines, prefix) => lines.find((line) => line.startsWith(prefix)) || null;
function armWindow(lines, prefix, size) {
  const at = lines.findIndex((line) => line.startsWith(prefix));
  return at === -1 ? null : lines.slice(at, at + size).join(' ');
}

function buildCheck({ loadSectionizer, loadTextLines }) {
  return function check(ctx) {
    const sectionizer = loadLib(loadSectionizer, SECTIONIZER);
    if (sectionizer.error) ctx.fail(SECTIONIZER, sectionizer.error);
    const textLines = loadLib(loadTextLines, TEXT_LINES);
    if (textLines.error) ctx.fail(TEXT_LINES, textLines.error);
    const withSectionizer = libCaller(ctx, sectionizer, SECTIONIZER);
    const withLines = libCaller(ctx, textLines, TEXT_LINES);
    const linesOf = (text) => withLines((lib) => lib.splitLines(text), null);
    // The tiers of a span's yaml examples, or null when a library failed (already one finding).
    const tiersOf = (span) => {
      if (sectionizer.error || textLines.error) return null;
      const found = yamlSeverityTiers(span, {
        splitLines: (text) => withLines((lib) => lib.splitLines(text), []),
        scanFencedBlocks: (lines) => withSectionizer((lib) => lib.scanFencedBlocks(lines), []),
      });
      return sectionizer.error || textLines.error ? null : found;
    };

    // The tier the revision loop exempts is derived from its flow, never hardcoded.
    let tier = null;
    ctx.doc(REVISION_LOOP).satisfies((text) => {
      tier = exemptTier(text);
      return tier !== null || 'no "If PASSED or only <tier>-level issues" flow line';
    }, 'revision-loop.md must state its exempt severity tier in the flow');

    const agent = ctx.doc(AGENT);
    let agentLabels = null;
    agent
      .satisfies((text) => {
        const title = coupledTitle(text);
        if (title === null) return 'no "## Dimension 3b:" heading with a title';
        return asciiLower(title).includes('coupling') || `the title is ${title}`;
      }, 'agents/gsd-plan-checker.md must define a "## Dimension 3b:" heading naming coupling as its subject')
      .satisfies((text) => {
        const [d3, d3b, d4] = [D3, D3B, D4].map((heading) => headingIndex(text, heading));
        if (d3b === -1) return true;
        if (d3 === -1 || d4 === -1) return `Dimensions 3, 3b and 4 must all be present (at ${d3}, ${d3b}, ${d4})`;
        if (d3 >= d3b) return 'Dimension 3b must follow Dimension 3';
        return d3b < d4 || 'Dimension 3b must precede Dimension 4: it extends Dimension 3';
      }, 'the sub-check sits inside Dimension 3, not after it')
      .satisfies(inSpan(D3B, D4, (span) => leadGapTail(span, 'Scope:', 'PLAN pairs, not tasks', 0) || 'not found'),
        'Dimension 3b must state that the comparison is plan-pair scoped')
      .satisfies(inSpan(D3B, D4, (span) => {
        const count = countOrderedItems(span);
        return count === ITEM_COUNT || `found ${count} ordered items`;
      }), 'Dimension 3b must gate on exactly three AND-ed conditions: dropping one widens the heuristic into noise, adding one narrows what it can catch')
      .satisfies(inSpan(D3B, D4, (span) => {
        if (tier === null) return true;
        return leadGapTail(span, 'severity:', tier, 0) || `no severity: ${tier}`;
      }), "Dimension 3b's example issue must carry the tier revision-loop.md exempts")
      .satisfies(inSpan(D3B, D4, (span) => {
        if (tier === null || !leadGapTail(span, 'severity:', tier, 0)) return true;
        const found = tiersOf(span);
        if (found === null) return true;
        if (found.length === 0) return 'no severity-tagged yaml example';
        const wrong = found.filter((one) => one !== tier);
        return wrong.length === 0 || `carries severity: ${wrong[0]}, the exempt tier is ${tier}: a non-exempt tier re-arms the revision loop`;
      }), 'every severity token in the Dimension 3b yaml examples must be the exempt tier')
      .satisfies(inSpan(D3B, D4, (span) => neverBlocker(asciiLower(span)) || 'not found'),
        'Dimension 3b must state that the finding is never a blocker')
      .satisfies(inSpan(D3B, D4, (span) => {
        const found = tiersOf(span);
        return found === null || !found.includes('blocker') || 'a blocker-severity example is present';
      }), 'Dimension 3b must not contain a blocker-severity example: it is advisory only')
      .satisfies(inSpan(D3, D3B, (body) => leadGapTail(body, 'severity:', 'blocker', 0) || 'not found'),
        "Dimension 3's own example issue must still be severity: blocker")
      .satisfies(inSpan(D3, D3B, (body) => body.includes('Circular dependency') || 'not found'),
        'Dimension 3 must still carry its circular-dependency example')
      .satisfies(inSpan(D3B, D4, (span) => leadGapTail(span, 'dimension:', 'dependency_correctness', 0) || 'not found'),
        "Dimension 3b's example issue must reuse the dependency_correctness dimension key")
      .satisfies(inSpan(D3B, D4, (span) => span.includes('Do NOT flag') || 'not found'),
        'Dimension 3b must carry an explicit non-triggering list')
      .satisfies(inSpan(D3B, D4, (span) => {
        const lower = asciiLower(span);
        const missing = [
          ['files_modified', span.includes('files_modified')],
          ['depends_on', span.includes('depends_on')],
          ['different wave', lower.includes('different wave')],
          ['READ', span.includes('READ')],
        ].filter(([, present]) => !present).map(([name]) => name);
        return missing.length === 0 || `missing: ${missing.join(', ')}`;
      }), 'the Dimension 3b non-triggering list must cover the file-overlap axis, a declared edge, a different wave and two readers')
      .satisfies(inSpan(D3B, D4, (span) => span.includes('Dimension 9') || 'not found'),
        'Dimension 3b must defer incompatible-transform findings to Dimension 9')
      .satisfies(inSpan(D3B, D4, (span) => span.includes("declared `coupling_justified` in either plan's frontmatter") || 'not found'),
        'Dimension 3b must exempt a coupling_justified pair so intentional coupling can converge (#3724 criterion 4)')
      .satisfies(inSpan(D3B, D4, (span) => precedesBounded(span, 'fix_hint:', 'coupling_justified', NEWLINE) || 'not found'),
        'the 3b fix_hint must name coupling_justified so the planner learns the escape hatch')
      .satisfies(inSpan(D3B, D4, (span) => leadGapTail(span, 'note the applied', 'exemption as its own `info` advisory', 1) || 'not found'),
        'Dimension 3b must surface an applied coupling_justified exemption as an info advisory')
      .has('An INFO-only result is NOT `passed`', 'step 10 must exclude an INFO-only result from `passed`')
      .has('Return `## ISSUES FOUND` even when every issue is INFO', 'step 10 must route an INFO-only result to ## ISSUES FOUND so the block reaches the orchestrator')
      .has('### Advisories (info)', 'the ISSUES FOUND template must carry an advisories section so INFO entries render')
      .has('Advisory only — no revision required', 'the recommendation must not claim a planner return for an INFO-only result')
      .satisfies((text) => {
        const stripped = withSectionizer((lib) => lib.stripFencedCode(text).text, null);
        if (stripped === null) return true;
        agentLabels = dimensionLabels(stripped);
        const problems = [];
        if (agentLabels.length < MIN_DIMENSIONS) problems.push(`expected at least ${MIN_DIMENSIONS} numbered dimensions, found ${agentLabels.length}`);
        if (!agentLabels.includes('3b') && headingIndex(text, D3B) !== -1) problems.push('the Dimension 3b heading is inside a code fence');
        if (new Set(agentLabels).size !== agentLabels.length) problems.push(`duplicate dimension labels: ${agentLabels.join(', ')}`);
        return problems.length === 0 || problems.join('; ');
      }, 'the agent must define a discoverable set of unique numbered dimensions, fences stripped');
    agent.slice('<success_criteria>', '</success_criteria>')
      .satisfies((text) => hasCouplingChecklist(text) || 'not found',
        'the <success_criteria> checklist must carry a line for the coupling check: a rubric the agent is never told to run is not a check');

    const docs = ctx.doc(DOCS_AGENTS);
    const section = (text) => between(text, exactLineIndex(text, '### gsd-plan-checker'), exactLineIndex(text, '### gsd-integration-checker'),
      '### gsd-plan-checker', '### gsd-integration-checker');
    docs
      .satisfies((text) => section(text).error || true, 'the plan-checker and integration-checker sections must exist in order')
      .satisfies((text) => {
        const found = section(text);
        if (found.text === undefined || agentLabels === null) return true;
        const documented = new Set(tableLabels(found.text));
        const missing = agentLabels.filter((label) => !documented.has(label));
        return missing.length === 0 || `omits dimension(s): ${missing.join(', ')}`;
      }, 'docs/reference/agents.md must enumerate every dimension the agent defines')
      .satisfies((text) => {
        const found = section(text);
        return found.text === undefined || asciiLower(found.text).includes('coupling') || 'not found';
      }, "docs/reference/agents.md's gsd-plan-checker section must document the coupling check");

    // The orchestrators' handlers of the checker return, each one line of its workflow (or the window after one).
    const onLines = (prefix, label, checks, size) => (text) => {
      const lines = linesOf(text);
      if (lines === null) return true;
      const target = size === undefined ? findLine(lines, prefix) : armWindow(lines, prefix, size);
      if (target === null) return true;
      const missing = checks.filter(([needle]) => !target.includes(needle)).map(([needle]) => needle);
      return missing.length === 0 || `${label} lacks: ${missing.join(' | ')}`;
    };
    const hasLine = (prefix) => (text) => {
      const lines = linesOf(text);
      return lines === null || findLine(lines, prefix) !== null || `no line starts with ${JSON.stringify(prefix)}`;
    };
    const hasArm = (text) => {
      const lines = linesOf(text);
      return lines === null || armWindow(lines, ARM_LINE, ARM_WINDOW) !== null || `no line starts with ${JSON.stringify(ARM_LINE)}`;
    };

    ctx.doc(PLAN_PHASE)
      .satisfies(hasLine(PARSE_LINE), 'plan-phase.md step 12 must carry the parse-issue-count paragraph')
      .satisfies(onLines(PARSE_LINE, 'the parse-issue-count paragraph', [['likewise when every entry in the block is explicitly INFO (display them as advisories)']]),
        'step 12 must accept only an explicitly-INFO issues block, surfacing the advisories (#3724 criterion 1)')
      .satisfies((text) => text.includes('count BLOCKER + WARNING entries in the YAML issues block') || 'not found',
        'step 12 must keep gating the revision loop on BLOCKER + WARNING counts')
      .satisfies(hasArm, 'plan-phase.md must carry the iteration_count >= 3 arm')
      .satisfies(onLines(ARM_LINE, 'the iteration cap arm', [['Recount BLOCKER + WARNING'], ['explicitly INFO — display any advisories and proceed to step 13']], ARM_WINDOW),
        'the >= 3 arm must recount BLOCKER + WARNING and accept an INFO-only result instead of halting on the user gate')
      .satisfies(onLines(PARSE_LINE, 'the iteration_count < 3 arm', [[CLAUSE]]), 'the plan-phase iteration_count < 3 arm must carry the fail-closed clause verbatim')
      .satisfies(onLines(ARM_LINE, 'the iteration_count >= 3 arm', [[CLAUSE]], ARM_WINDOW), 'the plan-phase iteration_count >= 3 arm must carry the fail-closed clause verbatim');

    ctx.doc(VERIFY_WORK)
      .satisfies(hasLine(VERIFY_LINE), 'verify-work.md must carry the ISSUES FOUND handler line')
      .satisfies(onLines(VERIFY_LINE, 'the verify_gap_plans handler', [['Count BLOCKER + WARNING'], ['every entry is explicitly INFO'], [CLAUSE]]),
        'the verify_gap_plans handler must gate its revision loop on BLOCKER + WARNING counts, accept only an explicitly-INFO issues block and carry the fail-closed clause');
    ctx.doc(QUICK_LOOP)
      .satisfies(hasLine(QUICK_LINE), 'plan-checker-loop.md must carry the ISSUES FOUND handler line')
      .satisfies(onLines(QUICK_LINE, 'the quick-mode handler', [['every entry is explicitly INFO'], ['proceed to step 6'], [CLAUSE]]),
        'quick mode must accept only an explicitly-INFO issues block, proceed on it and carry the fail-closed clause');
    ctx.doc(IMPORT)
      .satisfies(hasLine(IMPORT_LINE), 'import.md plan_validate must carry the severity-aware handler paragraph')
      .satisfies(onLines(IMPORT_LINE, 'the import handler', [['never blocks an import'], [CLAUSE]]),
        'an INFO-only checker return must not block an import and the handler must carry the fail-closed clause');
    ctx.doc(AGENT_CONTRACTS)
      .satisfies(hasLine(CONTRACTS_ROW), 'agent-contracts.md must carry the gsd-plan-checker row')
      .satisfies(onLines(CONTRACTS_ROW, 'the gsd-plan-checker row', [['gsd-core/workflows/import.md']]),
        'agent-contracts.md must list import.md as a gsd-plan-checker sentinel consumer');

    ctx.doc(PLANNER).has('@~/.claude/gsd-core/references/planner-coupling.md', 'gsd-planner.md must point at the planner-coupling reference (#3724 criterion 3)');
    ctx.doc(COUPLING_REF)
      .satisfies((text) => leadGapTail(asciiLower(text), 'mutable', 'resource', 1) || 'not found', 'planner-coupling.md must state the shared-mutable-resource rule')
      .has('coupling_justified', 'planner-coupling.md must document the coupling_justified declaration')
      .has('Dimension 3b', 'planner-coupling.md must name the verifying side (Dimension 3b)');
  };
}

const realSectionizer = () => require(path.join(REAL_ROOT, SECTIONIZER));
const realTextLines = () => require(path.join(REAL_ROOT, TEXT_LINES));

module.exports = {
  // The linear walkers and the loader seam, exported for the differential properties and the loader cases of
  // tests/text-contracts.batch12.test.cjs.
  walkers: {
    eachLineStart, headingIndex, exactLineIndex, headingSpan, coupledTitle, leadGapTail, neverBlocker, countOrderedItems,
    hasCouplingChecklist, severityOf, yamlSeverityTiers, exemptTier, dimensionLabels, tableLabels, armWindow, buildCheck,
  },
  id: 'plan-checker-coupling',
  issue: '#1954',
  check: buildCheck({ loadSectionizer: realSectionizer, loadTextLines: realTextLines }),
};
