'use strict';

// #3990, #4268, #4302, #5274: the RED/GREEN/REFACTOR cycle is stated ONCE, in references/tdd.md (with its commit-scope
// contract); gsd-executor.md and execute-plan.md carry a pointer, not a restatement (neither the literal commit-scope lines
// nor a structural re-derivation of the three phases that never defers to tdd.md); execute-mvp-tdd.md's check 3 names both
// GREEN commit types and its halt reason `impl_before_test`; and both embed lists load tdd.md only when TDD_APPLICABLE.
// The restatement detector is the test's own, moved here: linear scans on disjoint anchors (the #4228 postmortem), with the
// old regexes that carried a `\s*` or `\d+` written as walks. Its fixture cases and property are in
// tests/text-contracts.batch12.test.cjs. Was tests/tdd-single-statement.test.cjs.

const TDD = 'gsd-core/references/tdd.md';
const EXECUTOR = 'agents/gsd-executor.md';
const EXECUTE_PLAN = 'gsd-core/workflows/execute-plan.md';
const MVP = 'gsd-core/references/execute-mvp-tdd.md';
const EMBED_LISTS = [
  ['execute-phase.md', 'gsd-core/workflows/execute-phase.md'],
  ['executor-isolation-dispatch.md', 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md'],
];
const RESTATEMENT_SPAN_THRESHOLD = 200;
const DEFERRAL_WINDOW_TRAILING = 500;
const DEFERRAL_MARKERS = ['tdd.md', 'references/tdd', 'canonical'];
const HALT_REASON = 'impl_before_test';

const isBlank = (ch) => ch !== undefined && /\s/.test(ch);
const isDigit = (ch) => ch !== undefined && ch >= '0' && ch <= '9';
const isWord = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

// A RED commit-scope line followed by a GREEN one (feat or fix) outside the canonical reference.
function restatesCycle(text) {
  const red = text.indexOf('commit: `test({phase}-{plan})');
  if (red === -1) return false;
  const feat = text.indexOf('commit: `feat({phase}-{plan})', red);
  const fix = text.indexOf('commit: `fix({phase}-{plan})', red);
  return feat !== -1 || fix !== -1;
}

// A list item line: the walk of /^\s*(?:[-*]|\d+[.)])\s/.
function isListMarkerLine(line) {
  let at = 0;
  while (isBlank(line[at])) at += 1;
  if (line[at] === '-' || line[at] === '*') {
    at += 1;
  } else if (isDigit(line[at])) {
    while (isDigit(line[at])) at += 1;
    if (line[at] !== '.' && line[at] !== ')') return false;
    at += 1;
  } else {
    return false;
  }
  return isBlank(line[at]);
}

// `word` with no word character on either side: the walk of /\bword\b/.
function hasWord(line, word) {
  for (let at = line.indexOf(word); at !== -1; at = line.indexOf(word, at + 1)) {
    if (!isWord(line[at - 1]) && !isWord(line[at + word.length])) return true;
  }
  return false;
}

const findOwnListLineIndex = (lines, word) => lines.findIndex((line) => isListMarkerLine(line) && hasWord(line, word));

// The first RED, the first GREEN after it, the first REFACTOR after that (three sequential linear scans), or null.
function measureCycleSpan(text) {
  const redIdx = text.search(/\bRED\b/);
  if (redIdx === -1) return null;
  const greenRel = text.slice(redIdx).search(/\bGREEN\b/);
  if (greenRel === -1) return null;
  const greenIdx = redIdx + greenRel;
  const refactorRel = text.slice(greenIdx).search(/\bREFACTOR\b/);
  if (refactorRel === -1) return null;
  const refactorIdx = greenIdx + refactorRel;
  return { redIdx, greenIdx, refactorIdx, refactorEndIdx: refactorIdx + 'REFACTOR'.length, span: refactorIdx - redIdx };
}

// The first blank line in [fromIdx, capIdx) (a LF, spaces or tabs, a LF) whose following line is not a list continuation:
// the walk of the global /\n[ \t]*\n/ loop. A blank line followed by a list item is the same block; a match consumes its
// second LF. Returns the absolute index of that blank line's first LF, or -1.
function findListAwareBlankBoundary(text, fromIdx, capIdx) {
  const region = text.slice(fromIdx, capIdx);
  let from = 0;
  for (let at = region.indexOf('\n', from); at !== -1; at = region.indexOf('\n', from)) {
    let end = at + 1;
    while (region[end] === ' ' || region[end] === '\t') end += 1;
    if (region[end] !== '\n') {
      from = at + 1;
      continue;
    }
    const nextEnd = region.indexOf('\n', end + 1);
    if (!isListMarkerLine(region.slice(end + 1, nextEnd === -1 ? undefined : nextEnd))) return fromIdx + at;
    from = end + 1;
  }
  return -1;
}

// A citation of tdd.md in the window from RED to the earliest of: 500 characters past REFACTOR, the next heading line, the
// next blank line that is not followed by a list item (#4302).
function hasNearbyDeferralMarker(text, cycle) {
  const cappedEnd = Math.min(text.length, cycle.refactorEndIdx + DEFERRAL_WINDOW_TRAILING);
  const headingAt = text.slice(cycle.refactorEndIdx, cappedEnd).indexOf('\n#');
  const headingEnd = headingAt === -1 ? cappedEnd : cycle.refactorEndIdx + headingAt;
  const blankBoundary = findListAwareBlankBoundary(text, cycle.refactorEndIdx, cappedEnd);
  const windowEnd = Math.min(headingEnd, blankBoundary === -1 ? cappedEnd : blankBoundary);
  const window = text.slice(cycle.redIdx, windowEnd);
  return DEFERRAL_MARKERS.some((marker) => window.includes(marker));
}

// A structural restatement: RED..GREEN..REFACTOR without a nearby citation (the primary signal), a span past the threshold,
// or three distinct list items each carrying one of the three words.
function restatesCycleStructurally(text) {
  const cycle = measureCycleSpan(text);
  if (!cycle) return false;
  if (!hasNearbyDeferralMarker(text, cycle)) return true;
  if (cycle.span > RESTATEMENT_SPAN_THRESHOLD) return true;
  const lines = text.slice(cycle.redIdx, cycle.refactorEndIdx).split('\n');
  const redLine = findOwnListLineIndex(lines, 'RED');
  const greenLine = findOwnListLineIndex(lines, 'GREEN');
  const refactorLine = findOwnListLineIndex(lines, 'REFACTOR');
  if (redLine === -1 || greenLine === -1 || refactorLine === -1) return false;
  return redLine !== greenLine && greenLine !== refactorLine && redLine !== refactorLine;
}

// `Reason: {` ... the halt reason name as a whole word before the closing brace or the line end: the walk of
// /Reason: \{[^}\n]*\bimpl_before_test\b/.
function namesHaltReason(text) {
  const opener = 'Reason: {';
  let end = 0;
  // Each span is scanned once: an opener inside a scanned span has a segment that is a tail of it, so the walk resumes at its end.
  for (let at = text.indexOf(opener); at !== -1; at = text.indexOf(opener, end)) {
    const start = at + opener.length;
    end = start;
    while (end < text.length && text[end] !== '}' && text[end] !== '\n') end += 1;
    const segment = text.slice(start, end);
    for (let hit = segment.indexOf(HALT_REASON); hit !== -1; hit = segment.indexOf(HALT_REASON, hit + 1)) {
      if (!isWord(text[start + hit - 1]) && !isWord(text[start + hit + HALT_REASON.length])) return true;
    }
  }
  return false;
}

// The embed-list line naming tdd.md and TDD_APPLICABLE must be conditional.
function embedEntryProblem(text) {
  const line = text.split('\n').find((candidate) => candidate.includes('tdd.md') && candidate.includes('TDD_APPLICABLE'));
  if (line === undefined) return 'no embed entry names tdd.md with TDD_APPLICABLE';
  return line.includes('TDD_APPLICABLE ?') || `the entry is not conditional: ${line.trim()}`;
}

module.exports = {
  // The linear walks, exported for the fixture cases and the differential properties of tests/text-contracts.batch12.test.cjs.
  walkers: {
    restatesCycle, restatesCycleStructurally, measureCycleSpan, findListAwareBlankBoundary, isListMarkerLine, hasWord,
    namesHaltReason, embedEntryProblem, RESTATEMENT_SPAN_THRESHOLD,
  },
  id: 'tdd-single-statement',
  issue: '#3990',
  check(ctx) {
    ctx.doc(TDD)
      .has('## Red-Green-Refactor Cycle', 'tdd.md carries the canonical Red-Green-Refactor Cycle section')
      .has(/Commit: `test\(\{phase\}-\{plan\}\)/, 'the canonical section carries the RED commit-scope contract')
      .has(/Commit: `feat\(\{phase\}-\{plan\}\)[^\n]{0,200}or `fix\(\{phase\}-\{plan\}\)/, 'the canonical section carries the GREEN commit-scope contract (feat or fix)');

    for (const [rel, label] of [[EXECUTOR, '<tdd_execution>'], [EXECUTE_PLAN, '<tdd_plan_execution>']]) {
      const doc = ctx.doc(rel)
        .satisfies((text) => !restatesCycle(text) || 'a RED commit-scope line is followed by a GREEN one',
          `${label} must not restate the numbered RED/GREEN commit protocol: point at tdd.md`)
        .satisfies((text) => !restatesCycleStructurally(text) || 'a structural restatement',
          `${rel}'s compact citation of RED/GREEN/REFACTOR must not be flagged as a restatement`);
      if (rel === EXECUTOR) {
        doc.has('references/tdd.md', 'the executor points at the canonical reference');
      } else {
        doc.satisfies((text) => {
          const at = text.indexOf('tdd_plan_execution');
          if (at === -1) return 'no tdd_plan_execution section';
          return text.includes('references/tdd.md', at) || 'the section does not point at it';
        }, 'the plan-execution section points at the canonical reference');
      }
    }

    ctx.doc(MVP)
      .has(/No `feat\(\{phase\}-\{plan\}\)` or `fix\(\{phase\}-\{plan\}\)` commit may exist/, 'check 3 names both GREEN commit types')
      .satisfies((text) => namesHaltReason(text) || `no Reason: {...} line names ${HALT_REASON}`, `the check-3 halt reason must name ${HALT_REASON}, neither GREEN type alone (#5274)`)
      .lacks('feat_before_test', 'the check-3 halt reason must not name a GREEN type alone');

    for (const [name, rel] of EMBED_LISTS) {
      ctx.doc(rel).satisfies(embedEntryProblem, `${name} must list tdd.md as an embed entry conditional on TDD_APPLICABLE (#3990)`);
    }
  },
};
