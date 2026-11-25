'use strict';

// spec-phase.md Step 5.5, the deployed edge-probe wiring (RR-11, #2733, #2773, #3102, #3132, #3717, #4656): scoped to the Step 5.5
// block (from its heading to the next `## ` heading, or to the next `Step <digit>` line when only the bare marker is present) the
// workflow resolves edge-probe.cjs and invokes it through node, writes $REQS_JSON before that call and guards an empty file,
// has a not-found branch, pins every `npm build:lib` to the GSD dir with --prefix behind a tsconfig.build.json check, exit-checks the
// engine capture and validates it as JSON, reads coverage.applicable, renders $COVERAGE bare to stdout, binds the engine rows as a
// floor, never leaks the $REQS_JSON temp file on an exit before the unconditional cleanup, tells a response_language project to
// translate into English through text_en (text keeps the original language, ids are stable, the SPEC is not translated, the authored
// `shapes` override is the zero-cue fallback and the translation instruction comes before the write); the widened zero-applicable
// guard is in spec-phase and ui-phase; the retired covered/backstop status vocabulary is gone from spec-phase, plan-phase, ui-phase and
// specless-probe-fallback, which use resolved plus a verification tier; the edge-probe reference documents English cues, response_language
// and text_en. The three cases of the engine's classifyShape and applicableCategories stay in tests/edge-probe-spec-phase-contract.test.cjs
// (they execute the library, not read prose). Dropped: the repeated response_language and "block extractable" assertions (one finding
// each, once) and the `edge-probe.*not found` alternative of the not-found assertion (implied by `not found`). Was the text half of
// tests/edge-probe-spec-phase-contract.test.cjs.

const path = require('node:path');
const { asciiLower } = require('./lib/ascii-lower.cjs');
const { loadLib } = require('./lib/load-lib.cjs');
const { LINE_ENDS } = require('./lib/line-ends.cjs');
const { hasSequence } = require('./lib/has-sequence.cjs');
const { isWordChar, includesBounded, precedesBounded, windowChain, libCaller } = require('./lib/bounded-walks.cjs');

const SPEC_PHASE = 'gsd-core/workflows/spec-phase.md';
const EDGE_PROBE_REF = 'gsd-core/references/edge-probe.md';
const PLAN_PHASE = 'gsd-core/workflows/plan-phase.md';
const UI_PHASE = 'gsd-core/workflows/ui-phase.md';
const FALLBACK = 'gsd-core/references/specless-probe-fallback.md';
const TEXT_LINES = 'gsd-core/bin/lib/text-lines.cjs';
const REAL_ROOT = path.join(__dirname, '..', '..', '..');
const WS = /\s/;
const NEWLINE = new Set(['\n']);
const NO_STOPS = new Set();
const HEADING = '## Step 5.5';
const BARE = 'Step 5.5';
const JSON_REACH = 500;
const PINNED_PREFIX = ['--prefix'];

// The Step 5.5 block of a workflow, or null when the marker is absent: from `## Step 5.5` to the next `\n## `; failing that from the
// bare `Step 5.5` to the next `\n## ` or `\nStep <digit>`; the end of the file when no later heading follows.
function nextBreak(rest, withStep) {
  for (let at = rest.indexOf('\n'); at !== -1; at = rest.indexOf('\n', at + 1)) {
    if (rest.startsWith('## ', at + 1)) return at;
    if (withStep && rest.startsWith('Step ', at + 1) && rest[at + 6] >= '0' && rest[at + 6] <= '9') return at;
  }
  return -1;
}
function step55Block(text) {
  const heading = text.indexOf(HEADING);
  const start = heading === -1 ? text.indexOf(BARE) : heading;
  if (start === -1) return null;
  const marker = heading === -1 ? BARE : HEADING;
  const rest = text.slice(start + marker.length);
  const stop = nextBreak(rest, heading === -1);
  return stop === -1 ? text.slice(start) : text.slice(start, start + marker.length + stop);
}

// The index of the first `node`, whitespace, `"` or `$`, then `edge-probe` or `edge_probe` in any case on the rest of that line, or -1.
function nodeInvocationIndex(block) {
  for (let at = block.indexOf('node'); at !== -1; at = block.indexOf('node', at + 1)) {
    let pos = at + 4;
    const gap = pos;
    while (pos < block.length && WS.test(block[pos])) pos += 1;
    if (pos === gap || (block[pos] !== '"' && block[pos] !== '$')) continue;
    let end = pos + 1;
    while (end < block.length && !LINE_ENDS.has(block[end])) end += 1;
    const line = asciiLower(block.slice(pos + 1, end));
    if (line.includes('edge-probe') || line.includes('edge_probe')) return at;
  }
  return -1;
}

// The index of the first `>`, optional whitespace, then `target`, or -1: the redirect that writes the file.
function redirectIndex(block, target) {
  for (let at = block.indexOf('>'); at !== -1; at = block.indexOf('>', at + 1)) {
    let pos = at + 1;
    while (pos < block.length && WS.test(block[pos])) pos += 1;
    if (block.startsWith(target, pos)) return at;
  }
  return -1;
}

// `npm`, whitespace, `--prefix`, whitespace, an optional quote, `$`, `{` and `_`, then `GSD_RT`: the pinned build line.
function pinsPrefix(line) {
  for (let at = line.indexOf('npm'); at !== -1; at = line.indexOf('npm', at + 1)) {
    let pos = at + 3;
    let gap = pos;
    while (pos < line.length && WS.test(line[pos])) pos += 1;
    if (pos === gap || !line.startsWith(PINNED_PREFIX[0], pos)) continue;
    pos += PINNED_PREFIX[0].length;
    gap = pos;
    while (pos < line.length && WS.test(line[pos])) pos += 1;
    if (pos === gap) continue;
    for (const optional of ['"', '$', '{', '_']) if (line[pos] === optional) pos += 1;
    if (line.startsWith('GSD_RT', pos)) return true;
  }
  return false;
}

// Every `npm build:lib` line of a block: a line whose trimmed start is `npm` and which mentions build:lib.
const buildInvocations = (lines) => lines.filter((line) => line.trim().startsWith('npm') && line.includes('build:lib'));

// `$COVERAGE` followed by anything but a word character.
function refsCoverage(line) {
  for (let at = line.indexOf('$COVERAGE'); at !== -1; at = line.indexOf('$COVERAGE', at + 1)) {
    if (!isWordChar(line[at + '$COVERAGE'.length])) return true;
  }
  return false;
}
const startsWithCommand = (line) => ['printf', 'echo', 'cat'].some((word) => line.startsWith(word) && !isWordChar(line[word.length]));
function followedByAfterWs(line, mark, tail, wordEnd) {
  for (let at = line.indexOf(mark); at !== -1; at = line.indexOf(mark, at + 1)) {
    let pos = at + mark.length;
    while (pos < line.length && WS.test(line[pos])) pos += 1;
    if (line.startsWith(tail, pos) && (!wordEnd || !isWordChar(line[pos + tail.length]))) return true;
  }
  return false;
}

// Whether some line of the block emits $COVERAGE bare: it references the report, is no comment, leads with printf, echo or cat,
// is no `= $(` capture and no `| node` pipe.
function rendersReport(lines) {
  return lines.some((raw) => {
    const line = raw.trim();
    if (!refsCoverage(line)) return false;
    if (line.startsWith('#')) return false;
    if (!startsWithCommand(line)) return false;
    if (followedByAfterWs(line, '=', '$(', false)) return false;
    if (followedByAfterWs(line, '|', 'node', true)) return false;
    return true;
  });
}

// `mark `backstop`` followed by any character but `;`.
function marksBackstop(text) {
  const mark = 'mark `backstop`';
  for (let at = text.indexOf(mark); at !== -1; at = text.indexOf(mark, at + 1)) {
    const next = at + mark.length;
    if (next < text.length && text[next] !== ';') return true;
  }
  return false;
}

const leadingBlank = (line) => {
  let pos = 0;
  while (pos < line.length && WS.test(line[pos])) pos += 1;
  return pos;
};
const isBranchStart = (line) => {
  if (includesBounded(line, 'then')) return true;
  const pos = leadingBlank(line);
  return ['else', 'elif'].some((word) => line.startsWith(word, pos) && !isWordChar(line[pos + word.length]));
};
function isExit(line) {
  let pos = leadingBlank(line);
  if (!line.startsWith('exit', pos)) return false;
  pos += 4;
  const gap = pos;
  while (pos < line.length && WS.test(line[pos])) pos += 1;
  return pos > gap && line[pos] >= '0' && line[pos] <= '9';
}

// The trimmed `exit <n>` lines between the temp file's creation and its unconditional cleanup that run before an `rm -f` in their
// guard branch, or the reason the region cannot be had.
function exitLeaks(lines) {
  const create = lines.findIndex((line) => line.includes('REQS_JSON=$(mktemp'));
  if (create === -1) return { error: 'Step 5.5 must create $REQS_JSON via mktemp' };
  const after = lines.slice(create + 1);
  const end = after.findIndex((line) => line.startsWith('rm -f "$REQS_JSON"'));
  if (end === -1) return { error: 'Step 5.5 must unconditionally rm -f "$REQS_JSON" after the engine run' };
  let cleaned = false;
  const leaks = [];
  for (const line of after.slice(0, end)) {
    if (isBranchStart(line)) cleaned = false;
    if (line.includes('rm -f "$REQS_JSON"')) cleaned = true;
    if (isExit(line) && !cleaned) leaks.push(line.trim());
  }
  return { leaks };
}

const hasAny = (lower, needles) => needles.some((needle) => lower.includes(needle));
const ADD_CATEGORIES = ['add', 'adding'].flatMap((verb) => ['any', 'the missed', 'categor'].map((tail) => `${verb} ${tail}`));
const SPEC_LANGUAGE = ['original language', 'stays in', 'keeps'];
const ID_STABLE = ['unchanged', 'not translated', 'never translated', 'stable'];
const TEXT_ORIGINAL = ['original language', "spec's own", "requirement's own", 'unchanged'];

// An assertion over the Step 5.5 block: an absent block is the one finding of the block assertion, so the rest pass.
const inBlock = (predicate) => (text) => {
  const block = step55Block(text);
  return block === null ? true : predicate(block);
};

function buildCheck({ loadTextLines }) {
  return function check(ctx) {
    const textLines = loadLib(loadTextLines, TEXT_LINES);
    if (textLines.error) ctx.fail(TEXT_LINES, textLines.error);
    const withLines = libCaller(ctx, textLines, TEXT_LINES);
    const inLines = (predicate) => inBlock((block) => {
      const blockLines = withLines((lib) => lib.splitLines(block), null);
      return blockLines === null ? true : predicate(blockLines, block);
    });

    ctx.doc(SPEC_PHASE)
      .satisfies((text) => step55Block(text) !== null || 'neither "## Step 5.5" nor "Step 5.5" is present', 'the Step 5.5 block must be extractable from spec-phase.md')
      .satisfies(inBlock((block) => block.includes('edge-probe.cjs') || 'not found'), 'Step 5.5 must reference edge-probe.cjs as the artifact being resolved')
      .satisfies(inBlock((block) => nodeInvocationIndex(block) !== -1 || 'not found'), 'Step 5.5 must invoke edge-probe.cjs via node (e.g. node "$EDGE_PROBE_JS" ...)')
      .satisfies(inBlock((block) => redirectIndex(block, '"$REQS_JSON"') !== -1 || 'not found'),
        'Step 5.5 must WRITE requirements into $REQS_JSON (a redirect like `cat > "$REQS_JSON"`), not just mktemp it: an empty file makes the probe a silent no-op')
      .satisfies(inBlock((block) => {
        const write = redirectIndex(block, '"$REQS_JSON"');
        const invoke = nodeInvocationIndex(block);
        return write === -1 || invoke === -1 || write < invoke || `the write is at ${write}, the node call at ${invoke}`;
      }), 'Step 5.5 must populate $REQS_JSON BEFORE invoking edge-probe.cjs (write precedes the node call)')
      .satisfies(inBlock((block) => {
        const lower = asciiLower(block);
        return hasAny(lower, ['array.isarray', 'empty/invalid', 'empty or invalid']) || precedesBounded(lower, 'reqs_json', 'empty', NEWLINE) || 'none of the guard phrasings is present';
      }), 'Step 5.5 must guard against an empty/invalid $REQS_JSON before invoking (fail loud, not silent no-op)')
      .satisfies(inBlock((block) => {
        const lower = asciiLower(block);
        return hasAny(lower, ['build:lib', 'not found']) || precedesBounded(lower, 'error', 'edge-probe', LINE_ENDS) || 'none of the phrasings is present';
      }), 'Step 5.5 must have an explicit not-found branch (build:lib attempt or clear blocking error)')
      .satisfies(inLines((blockLines) => buildInvocations(blockLines).length > 0 || 'no npm build:lib line'),
        'Step 5.5 must contain at least one npm build:lib invocation (the dev-checkout fallback)')
      .satisfies(inLines((blockLines) => {
        const offenders = buildInvocations(blockLines).filter((line) => !pinsPrefix(line)).map((line) => line.trim());
        return offenders.length === 0 || offenders.join('\n');
      }), 'build:lib must be pinned with `npm --prefix "$_GSD_RT"` so it never runs the consuming project\'s scripts')
      .satisfies(inBlock((block) => block.includes('tsconfig.build.json') || 'not found'),
        'Step 5.5 must gate the build behind a GSD source checkout (e.g. test -f "$_GSD_RT/tsconfig.build.json")')
      .satisfies(inBlock((block) => hasSequence(block, ['if', '!', 'COVERAGE=$(node', '"$EDGE_PROBE_JS"']) || 'not found'),
        'Step 5.5 must exit-check the engine invocation (e.g. `if ! COVERAGE=$(node "$EDGE_PROBE_JS" …)`): a bare command substitution swallows the engine exit code and fails open')
      .satisfies(inBlock((block) => windowChain(block, ['COVERAGE', 'JSON.parse'], JSON_REACH, NO_STOPS) || windowChain(block, ['JSON.parse', '$COVERAGE'], JSON_REACH, NO_STOPS) || 'not found'),
        'Step 5.5 must validate $COVERAGE parses as JSON before use (guard against exit-0-but-malformed output)')
      .satisfies(inBlock((block) => block.includes('coverage.applicable') || 'not found'),
        'Step 5.5 must read coverage.applicable and guard the zero-applicable case (warn/confirm, not silently proceed)')
      .satisfies(inLines((blockLines) => rendersReport(blockLines) || 'no bare printf/echo/cat of $COVERAGE'),
        'Step 5.5 must RENDER $COVERAGE to the model context: a bare printf/echo/cat that is not captured (`=$(`) and not piped into node')
      .satisfies(inBlock((block) => asciiLower(block).includes('floor') || 'not found'),
        'Step 5.5 resolution loop must describe the rendered engine rows as a FLOOR the model unions with its own classification (ADR-550 D7b)')
      .satisfies(inBlock((block) => hasAny(asciiLower(block), ['recall gap', 'never a ceiling', 'not a ceiling', ...ADD_CATEGORIES]) || 'none of the phrasings is present'),
        'the floor must NOT be a ceiling: the loop must instruct the model to add categories the classifier missed (ADR-857 §98 recall gap)')
      .lacks('mark the edge `covered`', 'spec-phase.md must not instruct agents to mark edges as "covered" (retired status)')
      .satisfies((text) => !marksBackstop(text) || 'found', 'spec-phase.md must not instruct agents to mark edges as "backstop" (backstop is a verification tier only)')
      .satisfies((text) => precedesBounded(text, 'resolved', 'verification: explicit', LINE_ENDS) || 'not found',
        'spec-phase.md must use "resolved" with "verification: explicit" for specified edges')
      .satisfies((text) => precedesBounded(text, 'resolved', 'verification: backstop', LINE_ENDS) || 'not found',
        'spec-phase.md must use "resolved" with "verification: backstop" for backstopped edges')
      .satisfies(inBlock((block) => block.includes('response_language') || 'not found'), 'Step 5.5 must name `response_language`: the setting that makes the requirement prose non-English')
      .satisfies(inBlock((block) => asciiLower(block).includes('translat') || 'not found'), 'Step 5.5 must instruct that the probe input carries a translation, not the original-language prose')
      .satisfies(inBlock((block) => block.includes('English') || 'not found'), 'Step 5.5 must say the translation target is English (the cue set the classifier speaks)')
      .satisfies(inBlock((block) => {
        const lower = asciiLower(block);
        return SPEC_LANGUAGE.some((tail) => precedesBounded(lower, 'spec', tail, NEWLINE)) || precedesBounded(lower, 'original language', 'spec', NEWLINE) || 'not found';
      }), 'Step 5.5 must state the SPEC keeps the original language: only the probe input is translated')
      .satisfies(inBlock((block) => {
        const lower = asciiLower(block);
        return ID_STABLE.some((tail) => precedesBounded(lower, 'id', tail, NEWLINE)) || 'not found';
      }), 'Step 5.5 must state requirement ids are NOT translated or renumbered (coverage rows join on id)')
      .satisfies(inBlock((block) => block.includes('`shapes`') || 'not found'),
        'Step 5.5 must name the authored `shapes` override as the fallback for prose that still classifies to zero')
      .satisfies(inBlock((block) => {
        const language = block.indexOf('response_language');
        const write = redirectIndex(block, '"$REQS_JSON"');
        return language === -1 || write === -1 || language < write || `response_language is at ${language}, the write at ${write}`;
      }), 'the translation instruction must come BEFORE the $REQS_JSON write')
      .satisfies(inLines((blockLines) => exitLeaks(blockLines).error || true), 'the Step 5.5 temp file must be created and unconditionally cleaned up')
      .satisfies(inLines((blockLines) => {
        const found = exitLeaks(blockLines);
        return found.leaks === undefined || found.leaks.length === 0 || `leaking exits: ${JSON.stringify(found.leaks)}`;
      }), 'every exit between the mktemp and the unconditional cleanup must rm -f "$REQS_JSON" first')
      .satisfies(inBlock((block) => block.includes('text_en') || 'not found'), 'Step 5.5 must name the text_en field: the durable #3717 fix for non-English requirement classification')
      .satisfies(inBlock((block) => {
        const lower = asciiLower(block);
        return TEXT_ORIGINAL.some((tail) => precedesBounded(lower, 'text', tail, NEWLINE)) || precedesBounded(lower, 'original language', 'text', NEWLINE) || 'not found';
      }), 'Step 5.5 must state that text carries the SPEC requirement in its own (original) language, not the translation')
      .has('coverage.unclassified', 'step 5.5 must extract the unclassified sibling count the #4656 rollup exposes')
      .has('[ "$UNCLASSIFIED" = "$APPLICABLE" ]', 'the guard must fire when every requirement is unclassified (#4656), not only at applicable:0')
      .has('If the guard above fired', 'the mandatory AskUserQuestion confirmation must key on the widened guard, not only on applicable:0 (#4656)');

    ctx.doc(EDGE_PROBE_REF)
      .has('English', 'the edge-probe reference `## Inputs` contract must state that the heuristic classifier is English-cue based')
      .has('response_language', 'the edge-probe reference must point non-English projects at the translated-input requirement')
      .has('text_en', 'the edge-probe reference `## Inputs` contract must document the optional text_en field and its text_en ?? text fallback');

    ctx.doc(PLAN_PHASE)
      .lacks('`covered` edge', 'plan-phase.md must not reference "covered" edges as a status')
      .lacks('`backstop` edge', 'plan-phase.md must not reference "backstop" edges as a status')
      .has('resolved (verification: explicit)', 'plan-phase.md lift rule must use "resolved (verification: explicit)"');

    ctx.doc(UI_PHASE)
      .lacks('→ `covered`', 'ui-phase.md must not use "covered" as a resolution status')
      .satisfies((text) => precedesBounded(text, '→ `resolved`', 'verification: explicit', LINE_ENDS) || 'not found',
        'ui-phase.md resolution must use "resolved" with "verification: explicit"')
      .has('coverage.unclassified', 'ui-phase.md guard must be widened identically (#4656): the unclassified count')
      .has('[ "$UNCLASSIFIED" = "$APPLICABLE" ]', 'ui-phase.md guard must be widened identically (#4656): the all-unclassified comparison')
      .has('If the guard above fired', 'ui-phase confirmation prose must key on the widened guard too (#4656)');

    ctx.doc(FALLBACK)
      .lacks('auto-`covered`', 'specless-probe-fallback.md must not use auto-"covered" (retired status)')
      .lacks('auto-`backstop`', 'specless-probe-fallback.md must not use auto-"backstop" as a status (backstop is a verification tier only)')
      .lacks('`covered` edge', 'specless-probe-fallback.md must not reference "covered" edges as a status')
      .has('auto-`resolved`', 'specless-probe-fallback.md must use auto-"resolved" (not auto-"covered"/"backstop")')
      .has('verification: explicit', 'specless-probe-fallback.md must reference "verification: explicit"');
  };
}

const realTextLines = () => require(path.join(REAL_ROOT, TEXT_LINES));

module.exports = {
  // The linear walkers and the loader seam, exported for the differential properties and the loader cases of
  // tests/text-contracts.batch12.test.cjs.
  walkers: {
    step55Block, nodeInvocationIndex, redirectIndex, pinsPrefix, buildInvocations, refsCoverage, rendersReport, marksBackstop,
    exitLeaks, buildCheck,
  },
  id: 'edge-probe-spec-phase-contract',
  issue: '#3102',
  check: buildCheck({ loadTextLines: realTextLines }),
};
