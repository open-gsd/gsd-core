'use strict';

// /clear comes before the command in Next Up blocks (#1623, #3083, #3297): no `<sub>/clear</sub>` footnote in ui-brand.md,
// continuation-format.md, any workflow or any reference, and ui-brand.md's Next Up Block template shows /clear before
// {copy-paste command}; resume-project.md's route_to_workflow step omits the `/clear` then: template and explains the
// resume exception; plan-phase.md captures --gaps into GAPS_MODE, derives the execute-side GAPS_EXEC_FLAG="--gaps-only"
// from GAPS_MODE alone (never from reviews), and its <offer_next> block substitutes ${GAPS_EXEC_FLAG} before ${GSD_WS}
// and names --gaps-only. The old regexes are linear scans here with the same windows (80, 40, 60 and 200 characters).
// The template section ends at `## Error Panel`: the old test ended it at `## Error Box`, a heading renamed long ago,
// so it read to the end of the file. Was tests/next-up-clear-order.test.cjs (its bug-3083 block was folded in).

const { asciiLower } = require('./lib/ascii-lower.cjs');
const { hasSequence } = require('./lib/has-sequence.cjs');

const UI_BRAND = 'gsd-core/references/ui-brand.md';
const PLAN_PHASE = 'gsd-core/workflows/plan-phase.md';
const RESUME = 'gsd-core/workflows/resume-project.md';
const CONTINUATION = 'gsd-core/references/continuation-format.md';
const NO_FOOTNOTE = 'must not contain a <sub>/clear</sub> pattern: /clear should appear before the command';
const EXEC_FLAG = 'GAPS_EXEC_FLAG=""';
const EXEC_FLAG_SET = 'GAPS_EXEC_FLAG="--gaps-only"';

// `<sub>`, a run with no `<` that holds `/clear`, then `</sub>`, in any letter case.
function hasSubClear(text) {
  const lower = asciiLower(text);
  let at = lower.indexOf('<sub>');
  while (at !== -1) {
    const from = at + '<sub>'.length;
    const next = lower.indexOf('<', from);
    if (next === -1) return false;
    if (lower.startsWith('</sub>', next) && lower.slice(from, next).includes('/clear')) return true;
    at = lower.indexOf('<sub>', next);
  }
  return false;
}

// The `needle` occurs in the `limit` characters after `from` (the gap before it is at most `limit`).
const within = (text, from, limit, needle) => {
  const at = text.slice(from, from + limit + needle.length).indexOf(needle);
  return at !== -1 && at <= limit;
};

// GAPS_MODE=false, later $GSD_ARGS, then --gaps within 80 characters, then GAPS_MODE=true within 40 more.
function capturesGapsMode(text) {
  const start = text.indexOf('GAPS_MODE=false');
  if (start === -1) return false;
  let args = text.indexOf('$GSD_ARGS', start + 'GAPS_MODE=false'.length);
  while (args !== -1) {
    const after = args + '$GSD_ARGS'.length;
    const window = text.slice(after, after + 80 + '--gaps'.length);
    for (let flag = window.indexOf('--gaps'); flag !== -1 && flag <= 80; flag = window.indexOf('--gaps', flag + 1)) {
      if (within(text, after + flag + '--gaps'.length, 40, 'GAPS_MODE=true')) return true;
    }
    args = text.indexOf('$GSD_ARGS', args + 1);
  }
  return false;
}

// GAPS_EXEC_FLAG="", later GAPS_MODE, then GAPS_EXEC_FLAG="--gaps-only" within 60 characters.
function derivesExecFlag(text) {
  const start = text.indexOf(EXEC_FLAG);
  if (start === -1) return false;
  let mode = text.indexOf('GAPS_MODE', start + EXEC_FLAG.length);
  while (mode !== -1) {
    if (within(text, mode + 'GAPS_MODE'.length, 60, EXEC_FLAG_SET)) return true;
    mode = text.indexOf('GAPS_MODE', mode + 1);
  }
  return false;
}

// The first derivation block: GAPS_EXEC_FLAG="" then GAPS_EXEC_FLAG="--gaps-only" within 200 characters, or null.
function derivationBlock(text) {
  let start = text.indexOf(EXEC_FLAG);
  while (start !== -1) {
    const from = start + EXEC_FLAG.length;
    const at = text.slice(from, from + 200 + EXEC_FLAG_SET.length).indexOf(EXEC_FLAG_SET);
    if (at !== -1 && at <= 200) return text.slice(start, from + at + EXEC_FLAG_SET.length);
    start = text.indexOf(EXEC_FLAG, start + 1);
  }
  return null;
}

// The <offer_next> block (opening and closing tags at a line start), or the reason it is missing.
function offerNextOf(text) {
  const start = text.indexOf('\n<offer_next>');
  if (start === -1) return { error: 'plan-phase.md must have an <offer_next> block at line start' };
  const end = text.indexOf('\n</offer_next>', start);
  if (end === -1) return { error: 'plan-phase.md <offer_next> must close at line start' };
  return { block: text.slice(start, end) };
}

// A line of the route block (a line ends at LF, CR, U+2028 or U+2029) that names `resume` and `exception`, one after the other
// without overlapping (`resumexception` shares its `e`: the old /resume.*exception/ could not match it), in either order.
function explainsResumeException(text) {
  return text.split(/[\n\r\u2028\u2029]/).some((line) => {
    const lower = asciiLower(line);
    const resume = lower.indexOf('resume');
    const exception = lower.indexOf('exception');
    return (resume !== -1 && lower.includes('exception', resume + 'resume'.length))
      || (exception !== -1 && lower.includes('resume', exception + 'exception'.length));
  });
}

module.exports = {
  // The linear walkers, exported for the differential properties of tests/text-contracts.batch10.test.cjs.
  hasSubClear, hasSequence, capturesGapsMode, derivesExecFlag, derivationBlock, explainsResumeException,
  id: 'next-up-clear-order',
  issue: '#1623',
  check(ctx) {
    // One document handle per path: every assertion on a file runs on it, so a removed or empty file is one finding and a
    // footnote in ui-brand.md or continuation-format.md is reported once, not once per scan.
    const scanned = [];
    for (const dir of ['gsd-core/workflows', 'gsd-core/references']) scanned.push(...ctx.list(dir, '.md', `${dir} must hold markdown files to scan`));
    const paths = [...new Set([...scanned, UI_BRAND, CONTINUATION, RESUME, PLAN_PHASE])];
    const docs = new Map(paths.map((rel) => [rel, ctx.doc(rel)]));
    for (const [rel, doc] of docs) doc.satisfies((text) => !hasSubClear(text), `${rel} ${NO_FOOTNOTE}`);

    docs.get(UI_BRAND)
      .slice('## Next Up Block', '## Error Panel')
      .before('/clear', '{copy-paste command}', 'the Next Up block template must show /clear before {copy-paste command}');

    // #3083: resume routing is the exception to the /clear-then template.
    const route = docs.get(RESUME).step('route_to_workflow');
    route.lacks('/clear` then:', 'resume route templates must not include `/clear` then:');
    route.satisfies(explainsResumeException, 'the route_to_workflow block must include an exception note explaining resume behavior');

    // #3297: --gaps planning mode projects --gaps-only onto the Next Up execute command.
    const onBlock = (check) => (text) => {
      const found = offerNextOf(text);
      return found.error ? true : check(found.block);
    };
    docs.get(PLAN_PHASE)
      .satisfies(capturesGapsMode, 'the plan-phase.md preamble must set GAPS_MODE from the captured arguments ($GSD_ARGS) --gaps, so the mode reaches <offer_next>')
      .satisfies(derivesExecFlag, 'the plan-phase.md preamble must derive GAPS_EXEC_FLAG="--gaps-only" from GAPS_MODE')
      .satisfies((text) => {
        if (!derivesExecFlag(text)) return true;
        const block = derivationBlock(text);
        if (block === null) return 'expected a GAPS_EXEC_FLAG derivation block';
        if (!block.includes('GAPS_MODE')) return 'the derivation does not mention GAPS_MODE';
        return !asciiLower(block).includes('reviews') || 'the derivation references reviews';
      }, 'the --gaps-only derivation must be gated on GAPS_MODE alone: reviews-mode Next Up stays unchanged')
      .satisfies((text) => offerNextOf(text).error || true, 'plan-phase.md must have a closed <offer_next> block')
      .satisfies(onBlock((block) => hasSequence(block, ['/gsd:execute-phase', '{X}', '${GAPS_EXEC_FLAG}'])),
        '<offer_next> execute-phase command must substitute ${GAPS_EXEC_FLAG} after {X}')
      .satisfies(onBlock((block) => hasSequence(block, ['/gsd:execute-phase', '{X}', '${GAPS_EXEC_FLAG}', '${GSD_WS}'])),
        '<offer_next> command must keep the bare /gsd:execute-phase {X} form with ${GSD_WS}')
      .satisfies(onBlock((block) => block.includes('--gaps-only')),
        '<offer_next> must reference the --gaps-only execute-phase scope (the literal must reach the handoff)');
  },
};
