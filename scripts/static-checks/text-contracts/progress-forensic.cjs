'use strict';

// /gsd-progress: the --forensic flag (#2189: the command's argument-hint, the forensic-audit section marker in the workflow,
// the forensic_audit step gated on --forensic with its six checks, the CLEAN and INTEGRITY ISSUE verdicts, the unchanged
// default behaviour, the COMMANDS.md entry), the routing that consults verification.status before reporting a phase
// complete (#1107, #5118: the verification_status value, the gaps_found, human_needed and non-passed rows before the
// generic complete row, Route V.gaps to plan-phase --gaps, Route V.human to verify-work, Route V presenting the owner's
// next_command and naming no command of its own), the flag-routing prompt contract (#3418: the raw arguments on a line of
// their own before <process>, never interpolated into the parse instruction), and the report step's context-authority
// blockquote (#2912: PROJECT.md, STATE.md and ROADMAP.md authoritative, CLAUDE.md `## Project` never a source).
// Was tests/progress-forensic.test.cjs, with the two folded tests (bug-3418 and bug-2912). A route section whose closing
// marker is missing is a finding, where the old slice silently ran to the end of the file.
// Every pattern is a linear walk over a file read once.

const { LINE_ENDS } = require('./lib/line-ends.cjs');
const { asciiLower } = require('./lib/ascii-lower.cjs');

const COMMAND = 'commands/gsd/progress.md';
const WORKFLOW = 'gsd-core/workflows/progress.md';
const FORENSIC_STEP = 'gsd-core/workflows/progress/steps/forensic-audit.md';
const COMMANDS_DOC = 'docs/COMMANDS.md';

const ROUTE_GAPS = '**Route V.gaps:';
const ROUTE_HUMAN = '**Route V.human:';
const ROUTE_V = '**Route V:';
const COMPLETE_ROW = 'Phase complete (verification passed)';
// The not-equal sign of the non-passed routing row.
const NOT_PASSED_ROW = `verification_status ${String.fromCharCode(0x2260)} passed`;

const isSpace = (char) => char !== undefined && /\s/.test(char);
const skipSpaces = (text, from) => {
  let at = from;
  while (at < text.length && isSpace(text[at])) at += 1;
  return at;
};
const anyOf = (text, words) => words.some((word) => text.includes(word));

// /first\s+second/ over lower-cased text: `first`, then one or more blanks, then `second`.
function wordsSpaced(low, first, second) {
  let at = low.indexOf(first);
  while (at !== -1) {
    const after = at + first.length;
    const next = skipSpaces(low, after);
    if (next > after && low.startsWith(second, next)) return true;
    at = low.indexOf(first, at + 1);
  }
  return false;
}

// The blockquote blocks of a chunk of markdown: runs of consecutive lines that are `^\s*>\s?(.*)$`, joined without the
// markers. A line holding a lone CR, U+2028 or U+2029 after the marker is not a blockquote line (the dot stops there and
// `$` is the end of the line), and the optional blank after `>` is any one whitespace character: a line terminator
// after `>` is taken as that blank and the quote goes on with the text after it, a second terminator ends it.
function blockquoteLine(line) {
  const open = skipSpaces(line, 0);
  if (line[open] !== '>') return null;
  let rest = open + 1;
  if (isSpace(line[rest])) rest += 1;
  const body = line.slice(rest);
  for (const char of body) if (LINE_ENDS.has(char)) return null;
  return body;
}

function extractBlockquotes(markdown) {
  const blocks = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    const body = blockquoteLine(line);
    if (body !== null) {
      if (current === null) current = [];
      current.push(body);
    } else if (current !== null) {
      blocks.push(current.join('\n'));
      current = null;
    }
  }
  if (current !== null) blocks.push(current.join('\n'));
  return blocks;
}

// /context\s+authority/i
const namesContextAuthority = (block) => wordsSpaced(asciiLower(block), 'context', 'authority');
// /(do\s+NOT|do\s+not|must\s+NOT|must\s+not|never)/i
function hasProhibition(block) {
  const low = asciiLower(block);
  return wordsSpaced(low, 'do', 'not') || wordsSpaced(low, 'must', 'not') || low.includes('never');
}

// The routing rows in the order the table lists them: the specific verification rows, then the non-passed row, then the
// generic complete row (first match wins). A row that is missing is reported by its own assertion.
function routeOrder(text) {
  const gaps = text.indexOf('verification_status = gaps_found');
  const human = text.indexOf('verification_status = human_needed');
  const notPassed = text.indexOf(NOT_PASSED_ROW);
  const complete = text.indexOf(COMPLETE_ROW);
  if (gaps === -1 || human === -1 || notPassed === -1 || complete === -1) return true;
  return (gaps < notPassed && human < notPassed && notPassed < complete) || 'the specific rows must precede the non-passed row, which must precede the generic complete row (first match wins)';
}

// The text from one route heading to the next marker. A heading the contract asserts on its own (`asserted`: the opening
// heading and, for the routes, the closing one) is reported there, so a section that cannot be read because one is missing
// is skipped here; a closing heading that sits before the opening one reads as an empty section, as the old slice did.
// A closing marker nothing else asserts is a finding here.
function routeSection(text, open, close, closeAsserted = true) {
  const start = text.indexOf(open);
  if (start === -1) return { skip: true };
  const end = text.indexOf(close, start + open.length);
  if (end !== -1) return { text: text.slice(start, end) };
  if (!closeAsserted) return { error: `the closing marker ${JSON.stringify(close)} is not found after ${JSON.stringify(open)}` };
  return text.includes(close) ? { text: '' } : { skip: true };
}

module.exports = {
  id: 'progress-forensic',
  issue: '#2189',
  walkers: { wordsSpaced, blockquoteLine, extractBlockquotes, namesContextAuthority, hasProhibition, routeOrder, routeSection },
  check(ctx) {
    ctx.doc(COMMAND)
      .has('--forensic', 'the progress command argument-hint must include --forensic')
      .satisfies((text) => {
        const lines = text.split('\n');
        const block = lines.indexOf('<arguments>$ARGUMENTS</arguments>');
        const process = lines.indexOf('<process>');
        return (block !== -1 && process !== -1 && block < process) || 'progress.md must surface $ARGUMENTS on a dedicated <arguments> line before <process>, for stable flag parsing';
      }, 'the raw arguments must sit on a line of their own before the routing parse')
      .has('Arguments provided: see the `<arguments>` block above.', 'the routing parse must point at the labeled block instead of interpolating the text')
      .lacks('Parse the first token of $ARGUMENTS:', 'progress.md must keep the parse instructions independent from argument interpolation');

    const step = ctx.doc(FORENSIC_STEP);
    step
      .has('<step name="forensic_audit">', 'progress/steps/forensic-audit.md must have a forensic_audit step')
      .has('--forensic', 'the forensic_audit step must be gated on the --forensic flag')
      .satisfies((text) => anyOf(text, ['Skip', 'skip', 'exit']), 'the forensic_audit step must skip when --forensic is not present')
      .satisfies((text) => text.includes('STATE') && (text.includes('artifact') || text.includes('consistent')), 'the forensic step must check STATE against the artifacts (check 1)')
      .satisfies((text) => anyOf(text, ['HANDOFF', 'handoff']), 'the forensic step must check for orphaned handoff files (check 2)')
      .satisfies((text) => text.includes('defer'), 'the forensic step must check for deferred scope drift (check 3)')
      .satisfies((text) => anyOf(text, ['MEMORY', 'memory', 'pending']), 'the forensic step must check memory-flagged pending work (check 4)')
      .satisfies((text) => anyOf(text, ['todo', 'Todo', 'TODO']), 'the forensic step must check blocking operational todos (check 5)')
      .satisfies((text) => anyOf(text, ['uncommitted', 'git status']), 'the forensic step must check for uncommitted code (check 6)')
      .has('CLEAN', 'the forensic step must produce a CLEAN verdict when all checks pass')
      .satisfies((text) => anyOf(text, ['INTEGRITY ISSUE', 'integrity issue']), 'the forensic step must surface INTEGRITY ISSUE when checks fail')
      .satisfies((text) => anyOf(text, ['unchanged', 'standard report']), 'the forensic step must clarify that the default behaviour is unchanged');

    ctx.doc(COMMANDS_DOC).has('--forensic', 'COMMANDS.md must document the --forensic flag for gsd-progress');

    const workflow = ctx.doc(WORKFLOW)
      .has('id="forensic-audit"', 'progress.md must wire up the forensic-audit section marker')
      .has('verification.status', 'the progress workflow must query verification.status (the #651 seam)')
      .has('verification_status', 'the progress workflow must track a verification_status value for routing')
      .has('stale verification', 'the progress workflow must document that verification.status projects stale verification')
      .has('verification_status = gaps_found', 'the routing table must have a gaps_found row')
      .has('verification_status = human_needed', 'the routing table must have a human_needed row')
      .has(NOT_PASSED_ROW, 'the routing table must have one non-passed verification row (Route V)')
      .has(COMPLETE_ROW, 'the routing table must keep a generic complete row, only for passed verification')
      .satisfies(routeOrder, 'the routing rows must be in first-match-wins order')
      .lacks('verification_status = unknown', 'unknown is no longer a status (#5118)')
      .lacks('verification_status = stale', 'stale is routed by the owner, not a row of its own (#5118)')
      .has(ROUTE_GAPS, 'the workflow must define a Route V.gaps section')
      .has(ROUTE_HUMAN, 'the workflow must define a Route V.human section')
      .has(ROUTE_V, 'the workflow must define the single non-passed Route V')
      .lacks('**Route V.stale:', 'Route V.stale is deleted (#5118)')
      .lacks('verification passed, missing, or n/a', 'missing or unknown verification must not be documented as complete')
      .satisfies((text) => {
        const section = routeSection(text, ROUTE_GAPS, ROUTE_HUMAN);
        if (section.skip) return true;
        return (section.text.includes('--gaps') && section.text.includes('plan-phase')) || 'Route V.gaps must route to plan-phase {phase} --gaps';
      }, 'gaps_found must route to plan-phase --gaps')
      .satisfies((text) => {
        const section = routeSection(text, ROUTE_HUMAN, '**Step 3', false);
        if (section.skip) return true;
        if (section.error) return section.error;
        return section.text.includes('verify-work') || 'Route V.human must route to verify-work {phase}';
      }, 'human_needed must route to verify-work')
      .satisfies((text) => {
        const section = routeSection(text, ROUTE_V, ROUTE_GAPS);
        if (section.skip) return true;
        if (!section.text.includes('VERIFICATION_NEXT_COMMAND')) return 'Route V must present the owner\'s next_command';
        const named = ['/gsd:verify-work', '/gsd-verify-work', '/gsd:execute-phase', '/gsd-execute-phase'].filter((command) => section.text.includes(command));
        return named.length === 0 || `Route V names ${named.join(', ')}`;
      }, 'a non-passed verification must present the owner\'s next_command, never a hand-named command');

    // #2912: the report step's context-authority blockquote.
    workflow.step('report').satisfies((text) => extractBlockquotes(text).length > 0 || 'no blockquote', 'the report step must contain at least one blockquote (the context-authority directive)')
      .satisfies((text) => {
        const blocks = extractBlockquotes(text);
        if (blocks.length === 0) return true;
        return blocks.some(namesContextAuthority);
      }, 'the report step must contain a blockquote whose text includes "Context authority"')
      .satisfies((text) => authority(text, (block) => block.includes('PROJECT.md')), 'the context-authority directive must name PROJECT.md as authoritative')
      .satisfies((text) => authority(text, (block) => block.includes('STATE.md')), 'the context-authority directive must name STATE.md as authoritative')
      .satisfies((text) => authority(text, (block) => block.includes('ROADMAP.md')), 'the context-authority directive must name ROADMAP.md as authoritative')
      .satisfies((text) => authority(text, (block) => asciiLower(block).includes('authoritative')), 'the context-authority directive must describe these files as authoritative')
      .satisfies((text) => authority(text, (block) => block.includes('CLAUDE.md')), 'the context-authority directive must explicitly mention CLAUDE.md')
      .satisfies((text) => authority(text, hasProhibition), 'the context-authority directive must contain an explicit prohibition (do NOT, must not, never)')
      .satisfies((text) => authority(text, (block) => block.includes('## Project')), 'the context-authority directive must call out the CLAUDE.md "## Project" block specifically');
  },
};

// A check on the first blockquote that names the context authority; no such blockquote is reported by its own assertion.
function authority(stepText, predicate) {
  const block = extractBlockquotes(stepText).find(namesContextAuthority);
  return block === undefined ? true : predicate(block);
}
