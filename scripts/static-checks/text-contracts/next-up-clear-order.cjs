'use strict';

// /clear comes before the command in Next Up blocks (#1623, #3083, #3297): no `<sub>/clear</sub>` footnote in ui-brand.md,
// continuation-format.md, any workflow or any reference, and ui-brand.md's Next Up Block template shows /clear before
// {copy-paste command}; resume-project.md's route_to_workflow step omits the `/clear` then: template and explains the
// resume exception; plan-phase.md captures --gaps into GAPS_MODE, derives the execute-side GAPS_EXEC_FLAG="--gaps-only"
// from GAPS_MODE alone (never from reviews), and its <offer_next> block substitutes ${GAPS_EXEC_FLAG} before ${GSD_WS}
// and names --gaps-only. The old regexes are linear scans here with the same windows (80, 40, 60 and 200 characters).
// The template section ends at `## Error Panel`: the old test ended it at `## Error Box`, a heading renamed long ago,
// so it read to the end of the file. Was tests/next-up-clear-order.test.cjs (its bug-3083 block was folded in).

const UI_BRAND = 'gsd-core/references/ui-brand.md';
const PLAN_PHASE = 'gsd-core/workflows/plan-phase.md';
const NO_FOOTNOTE = 'must not contain a <sub>/clear</sub> pattern: /clear should appear before the command';
const EXEC_FLAG = 'GAPS_EXEC_FLAG=""';
const EXEC_FLAG_SET = 'GAPS_EXEC_FLAG="--gaps-only"';

// `<sub>`, a run with no `<` that holds `/clear`, then `</sub>`, in any letter case.
function hasSubClear(text) {
  const lower = text.toLowerCase();
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

// The words appear in order, each pair separated by at least one whitespace character (no word boundaries).
function hasSequence(text, words) {
  let at = text.indexOf(words[0]);
  while (at !== -1) {
    let cursor = at + words[0].length;
    let matched = true;
    for (const word of words.slice(1)) {
      const start = cursor;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (cursor === start || !text.startsWith(word, cursor)) {
        matched = false;
        break;
      }
      cursor += word.length;
    }
    if (matched) return true;
    at = text.indexOf(words[0], at + 1);
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

// The route block's lines (a line ends at LF, CR, U+2028 or U+2029) that name both `resume` and `exception`.
function explainsResumeException(text) {
  return text.split(/[\n\r\u2028\u2029]/).some((line) => {
    const lower = line.toLowerCase();
    return lower.includes('resume') && lower.includes('exception');
  });
}

module.exports = {
  id: 'next-up-clear-order',
  issue: '#1623',
  check(ctx) {
    ctx.doc(UI_BRAND)
      .satisfies((text) => !hasSubClear(text), `ui-brand.md ${NO_FOOTNOTE}`)
      .slice('## Next Up Block', '## Error Panel')
      .before('/clear', '{copy-paste command}', 'the Next Up block template must show /clear before {copy-paste command}');
    ctx.doc('gsd-core/references/continuation-format.md').satisfies((text) => !hasSubClear(text), `continuation-format.md ${NO_FOOTNOTE}`);
    for (const dir of ['gsd-core/workflows', 'gsd-core/references']) {
      for (const rel of ctx.list(dir, '.md', `${dir} must hold markdown files to scan`)) {
        ctx.doc(rel).satisfies((text) => !hasSubClear(text), `${rel} ${NO_FOOTNOTE}`);
      }
    }

    // #3083: resume routing is the exception to the /clear-then template.
    const route = ctx.doc('gsd-core/workflows/resume-project.md').step('route_to_workflow');
    route.lacks('/clear` then:', 'resume route templates must not include `/clear` then:');
    route.satisfies(explainsResumeException, 'the route_to_workflow block must include an exception note explaining resume behavior');

    // #3297: --gaps planning mode projects --gaps-only onto the Next Up execute command.
    const plan = ctx.doc(PLAN_PHASE)
      .satisfies(capturesGapsMode, 'the plan-phase.md preamble must set GAPS_MODE from the captured arguments ($GSD_ARGS) --gaps, so the mode reaches <offer_next>')
      .satisfies(derivesExecFlag, 'the plan-phase.md preamble must derive GAPS_EXEC_FLAG="--gaps-only" from GAPS_MODE')
      .satisfies((text) => {
        const block = derivationBlock(text);
        if (block === null) return 'expected a GAPS_EXEC_FLAG derivation block';
        if (!block.includes('GAPS_MODE')) return 'the derivation does not mention GAPS_MODE';
        return !block.toLowerCase().includes('reviews') || 'the derivation references reviews';
      }, 'the --gaps-only derivation must be gated on GAPS_MODE alone: reviews-mode Next Up stays unchanged')
      .satisfies((text) => offerNextOf(text).error || true, 'plan-phase.md must have a closed <offer_next> block');
    const onBlock = (check) => (text) => {
      const found = offerNextOf(text);
      return found.error ? true : check(found.block);
    };
    plan
      .satisfies(onBlock((block) => hasSequence(block, ['/gsd:execute-phase', '{X}', '${GAPS_EXEC_FLAG}'])),
        '<offer_next> execute-phase command must substitute ${GAPS_EXEC_FLAG} after {X}')
      .satisfies(onBlock((block) => hasSequence(block, ['/gsd:execute-phase', '{X}', '${GAPS_EXEC_FLAG}', '${GSD_WS}'])),
        '<offer_next> command must keep the bare /gsd:execute-phase {X} form with ${GSD_WS}')
      .satisfies(onBlock((block) => block.includes('--gaps-only')),
        '<offer_next> must reference the --gaps-only execute-phase scope (the literal must reach the handoff)');
  },
};
