'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  findNameValidityDrift,
  findBranchSlugFallbackDrift,
  findShellPhaseArithDrift,
  findSingleSegmentPhaseRegexDrift,
  scanMarkdownSingleSegmentPhaseRegex,
  findLetterlessPhaseMirrorDrift,
  scanMarkdownLetterlessPhaseMirror,
  findDotOnlyIntegerSplitDrift,
  findLooseDottedPhaseRegexDrift,
  findShellPhasePrintfPadDrift,
  scanMarkdownLetterAxisConsumers,
} = require('../scripts/lint-phase-id-drift.cjs');

const ROOT = path.join(__dirname, '..');

test('findNameValidityDrift flags a regex-literal re-derivation of the name-validity class', () => {
  const text = [
    'function isNameable(s) {',
    '  return /[\\p{L}\\p{N}]/u.test(s);',
    '}',
  ].join('\n');
  const found = findNameValidityDrift(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test('findNameValidityDrift flags the doubled-backslash template-string form', () => {
  const text = [
    'const re = new RegExp(\'[\\\\p{L}\\\\p{N}]\', "u");',
  ].join('\n');
  const found = findNameValidityDrift(text);
  assert.equal(found.length, 1);
});

test('findNameValidityDrift does NOT flag a line that calls hasNameableContent(', () => {
  const text = [
    'function wrapper(s) {',
    '  return hasNameableContent(s);',
    '}',
  ].join('\n');
  assert.deepEqual(findNameValidityDrift(text), []);
});

test('findNameValidityDrift does NOT flag a sanctioned site', () => {
  const text = [
    '// phase-id-owner: deliberate local copy for perf, tracked in #4634',
    'const re = /[\\p{L}\\p{N}]/u;',
  ].join('\n');
  assert.deepEqual(findNameValidityDrift(text), []);
});

test('findBranchSlugFallbackDrift flags the commands.cts/init.cts {slug}-fallback shape', () => {
  const text =
    "      .replace('{slug}', (phaseInfo['phase_slug'] as string) || 'phase');";
  const found = findBranchSlugFallbackDrift(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
});

test('findBranchSlugFallbackDrift does NOT flag the milestone-branch || \'milestone\' fallback', () => {
  const text =
    "      .replace('{slug}', generateSlugInternal(milestone.name) || 'milestone');";
  assert.deepEqual(findBranchSlugFallbackDrift(text), []);
});

test('findBranchSlugFallbackDrift does NOT flag a sanctioned site', () => {
  const text = [
    '// phase-id-owner: deliberate, tracked in #4634',
    "  .replace('{slug}', (phaseInfo['phase_slug'] as string) || 'phase');",
  ].join('\n');
  assert.deepEqual(findBranchSlugFallbackDrift(text), []);
});

test('findShellPhaseArithDrift flags $((10#...)) base-10-forced arithmetic', () => {
  const text = 'PHASE_N=$((10#$PHASE_NUM))';
  const found = findShellPhaseArithDrift(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
});

test('findShellPhaseArithDrift does NOT flag ordinary arithmetic', () => {
  const text = 'NEXT=$((i+1))';
  assert.deepEqual(findShellPhaseArithDrift(text), []);
});

test('findShellPhaseArithDrift does NOT flag a site sanctioned with an HTML comment', () => {
  const text = [
    '<!-- phase-id-owner: deliberate, tracked in #4634 -->',
    'PHASE_N=$((10#$PHASE_NUM))',
  ].join('\n');
  assert.deepEqual(findShellPhaseArithDrift(text), []);
});

test('findShellPhaseArithDrift still flags a raw un-reduced phase variable (#4619 regression)', () => {
  const text = 'PHASE_N=$((10#$PHASE_NUMBER))';
  const found = findShellPhaseArithDrift(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
});

test('findShellPhaseArithDrift does NOT flag arithmetic on an already-`_INT`-reduced phase variable', () => {
  const text = [
    'PHASE_INT=${PHASE_NUMBER%%.*}',
    'PHASE_N=$((10#$PHASE_INT))',
  ].join('\n');
  assert.deepEqual(findShellPhaseArithDrift(text), []);
});

test('findShellPhaseArithDrift does NOT flag arithmetic on a plan-id variable (never phase-carrying)', () => {
  const text = 'PLAN_N=$((10#${PLAN_ID}))';
  assert.deepEqual(findShellPhaseArithDrift(text), []);
});

test('findShellPhaseArithDrift skips a full-line comment merely mentioning the pattern as prose', () => {
  const text = '# Note: $((10#$PHASE_NUMBER)) is a hard shell syntax error on a decimal id.';
  assert.deepEqual(findShellPhaseArithDrift(text), []);
});

// #4568 (epic #4634): the single-optional-dotted-segment phase regex ban.
test('findSingleSegmentPhaseRegexDrift flags the bounded [0-9]+(\\.[0-9]+)? shape on a phase-carrying line', () => {
  const text = 'if ! [[ "$PADDED_PHASE" =~ ^[0-9]+(\\.[0-9]+)?$ ]]; then';
  const found = findSingleSegmentPhaseRegexDrift(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
});

test('findSingleSegmentPhaseRegexDrift flags the \\d near-variant on a phase-carrying line', () => {
  const text = 'if ! [[ "$padded_phase" =~ ^\\d+(\\.\\d+)?$ ]]; then';
  const found = findSingleSegmentPhaseRegexDrift(text);
  assert.equal(found.length, 1);
});

test('findSingleSegmentPhaseRegexDrift flags the doubled-backslash template-string form', () => {
  const text = "const re = new RegExp('^\\\\d+(\\\\.\\\\d+)?$'); // phase check";
  const found = findSingleSegmentPhaseRegexDrift(text);
  assert.equal(found.length, 1);
});

test('findSingleSegmentPhaseRegexDrift is SILENT on the fixed unbounded (*) form', () => {
  const text = 'if ! [[ "$PADDED_PHASE" =~ ^[0-9]+(\\.[0-9]+)*$ ]]; then';
  assert.deepEqual(findSingleSegmentPhaseRegexDrift(text), []);
});

test('findSingleSegmentPhaseRegexDrift does NOT flag a non-phase-carrying line (e.g. a version number)', () => {
  const text = 'if ! [[ "$VERSION" =~ ^[0-9]+(\\.[0-9]+)?$ ]]; then';
  assert.deepEqual(findSingleSegmentPhaseRegexDrift(text), []);
});

test('findSingleSegmentPhaseRegexDrift does NOT flag a site sanctioned with an HTML comment', () => {
  const text = [
    '<!-- phase-id-owner: deliberate, tracked in #4634 -->',
    'if ! [[ "$PADDED_PHASE" =~ ^[0-9]+(\\.[0-9]+)?$ ]]; then',
  ].join('\n');
  assert.deepEqual(findSingleSegmentPhaseRegexDrift(text), []);
});

test('scanMarkdownSingleSegmentPhaseRegex against the real repo tree reports zero violations (#4568 fixed)', () => {
  const violations = scanMarkdownSingleSegmentPhaseRegex(ROOT);
  assert.deepEqual(violations, []);
});

// #4660 (epic #4634): the letter-less phase-mirror ban — the letter-axis twin
// of the single-segment rule above.
test('findLetterlessPhaseMirrorDrift flags the digit-only [0-9]+(\\.[0-9]+)* shape on a phase-carrying line', () => {
  const text = 'if ! [[ "$PADDED_PHASE" =~ ^[0-9]+(\\.[0-9]+)*$ ]]; then';
  const found = findLetterlessPhaseMirrorDrift(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
});

test('findLetterlessPhaseMirrorDrift flags the extracting grep -oE form', () => {
  const text = "PHASE=$(echo \"$PLAN_PATH\" | grep -oE '[0-9]+(\\.[0-9]+)*-[0-9]+')";
  assert.equal(findLetterlessPhaseMirrorDrift(text).length, 1);
});

test('findLetterlessPhaseMirrorDrift flags the \\d near-variant on a phase-carrying line', () => {
  const text = 'if ! [[ "$padded_phase" =~ ^\\d+(\\.\\d+)*$ ]]; then';
  assert.equal(findLetterlessPhaseMirrorDrift(text).length, 1);
});

test('findLetterlessPhaseMirrorDrift is SILENT on the fixed [A-Z]? form', () => {
  const text = 'if ! [[ "$PADDED_PHASE" =~ ^[0-9]+[A-Z]?(\\.[0-9]+)*$ ]]; then';
  assert.deepEqual(findLetterlessPhaseMirrorDrift(text), []);
});

test('findLetterlessPhaseMirrorDrift tolerates the case-flexible [A-Za-z]? directory-scanning variant', () => {
  const text = 'if [[ "$phase_dir" =~ ^[0-9]+[A-Za-z]?(\\.[0-9]+)*- ]]; then';
  assert.deepEqual(findLetterlessPhaseMirrorDrift(text), []);
});

test('findLetterlessPhaseMirrorDrift does NOT flag the bounded single-segment shape (that is the other rule)', () => {
  const text = 'if ! [[ "$PADDED_PHASE" =~ ^[0-9]+(\\.[0-9]+)?$ ]]; then';
  assert.deepEqual(findLetterlessPhaseMirrorDrift(text), []);
});

test('findLetterlessPhaseMirrorDrift does NOT flag a non-phase-carrying line (e.g. a version number)', () => {
  const text = 'if ! [[ "$VERSION" =~ ^[0-9]+(\\.[0-9]+)*$ ]]; then';
  assert.deepEqual(findLetterlessPhaseMirrorDrift(text), []);
});

test('findLetterlessPhaseMirrorDrift does NOT flag a site sanctioned with an HTML comment', () => {
  const text = [
    '<!-- phase-id-owner: deliberate, tracked in #4660 -->',
    'if ! [[ "$PADDED_PHASE" =~ ^[0-9]+(\\.[0-9]+)*$ ]]; then',
  ].join('\n');
  assert.deepEqual(findLetterlessPhaseMirrorDrift(text), []);
});

test('scanMarkdownLetterlessPhaseMirror against the real repo tree reports zero violations (#4660 fixed)', () => {
  assert.deepEqual(scanMarkdownLetterlessPhaseMirror(ROOT), []);
});

// #4748 (epic #4634): the three letter-hostile CONSUMER shapes — a dot-only
// integer split, a `[0-9]+\.?[0-9]*` extraction, a `printf "%02d"` re-pad.

// a. dot-only integer split
test('findDotOnlyIntegerSplitDrift flags the post-#4619 `PHASE_INT=${PHASE_NUMBER%%.*}` split', () => {
  const text = 'PHASE_INT=${PHASE_NUMBER%%.*}; PHASE_FRAC=${PHASE_NUMBER#"$PHASE_INT"}';
  const found = findDotOnlyIntegerSplitDrift(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
  assert.equal(found[0].found, 'PHASE_INT=${PHASE_NUMBER%%.*}');
});

test('findDotOnlyIntegerSplitDrift flags the prefixed SPOT_ variant and the bare $PHASE source', () => {
  assert.equal(findDotOnlyIntegerSplitDrift('SPOT_PHASE_INT=${SPOT_PHASE_NUMBER%%.*}').length, 1);
  assert.equal(findDotOnlyIntegerSplitDrift('PHASE_INT=${PHASE%%.*}; PHASE_FRAC=${PHASE#"$PHASE_INT"}').length, 1);
});

test('findDotOnlyIntegerSplitDrift flags the quoted spelling of an _INT split', () => {
  assert.equal(findDotOnlyIntegerSplitDrift('PHASE_INT="${PHASE_NUMBER%%.*}"').length, 1);
});

test('findDotOnlyIntegerSplitDrift is SILENT on a dot split into a non-_INT name (a parent-phase derivation is correct as-is)', () => {
  // gap-closure-artifacts.md: the parent of `03A.1` is `03A` — everything before
  // the first dot, letter included. Not an integer, not fed to $((10#…)).
  assert.deepEqual(findDotOnlyIntegerSplitDrift('PARENT_PHASE="${PHASE_NUMBER%%.*}"'), []);
  assert.deepEqual(findDotOnlyIntegerSplitDrift('PHASE_PREFIX=${PHASE_NUMBER%%.*}'), []);
});

test('findDotOnlyIntegerSplitDrift is SILENT on the fixed first-non-digit split', () => {
  const text = 'PHASE_INT=${PHASE_NUMBER%%[!0-9]*}; PHASE_REST=${PHASE_NUMBER#"$PHASE_INT"}';
  assert.deepEqual(findDotOnlyIntegerSplitDrift(text), []);
});

test('findDotOnlyIntegerSplitDrift does NOT flag a split of a non-phase variable (a version, a plan)', () => {
  assert.deepEqual(findDotOnlyIntegerSplitDrift('MAJOR_INT=${VERSION%%.*}'), []);
  assert.deepEqual(findDotOnlyIntegerSplitDrift('PLAN_INT=${PLAN_ID%%.*}'), []);
});

test('findDotOnlyIntegerSplitDrift skips a full-line comment and honours the HTML sanction', () => {
  assert.deepEqual(findDotOnlyIntegerSplitDrift('# was: PHASE_INT=${PHASE_NUMBER%%.*}'), []);
  const text = [
    '<!-- phase-id-owner: deliberate, this site never sees a letter id -->',
    'PHASE_INT=${PHASE_NUMBER%%.*}',
  ].join('\n');
  assert.deepEqual(findDotOnlyIntegerSplitDrift(text), []);
});

// b. loose dotted extraction
test('findLooseDottedPhaseRegexDrift flags the `[0-9]+\\.?[0-9]*` grep -oE extraction on a phase-carrying line', () => {
  const text = "FROM_PHASE=$(echo \"$ARGUMENTS\" | grep -oE '\\-\\-from\\s+[0-9]+\\.?[0-9]*' | awk '{print $2}')";
  const found = findLooseDottedPhaseRegexDrift(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].found, '[0-9]+\\.?[0-9]*');
});

test('findLooseDottedPhaseRegexDrift flags the \\d near-variant', () => {
  assert.equal(findLooseDottedPhaseRegexDrift("PHASE=$(echo \"$ARGUMENTS\" | grep -oE '\\d+\\.?\\d*')").length, 1);
});

test('findLooseDottedPhaseRegexDrift is SILENT on the canonical `[0-9]+[A-Z]?(\\.[0-9]+)*` form', () => {
  const text = "PHASE=$(echo \"$ARGUMENTS\" | grep -oE '[0-9]+[A-Z]?(\\.[0-9]+)*' | head -1)";
  assert.deepEqual(findLooseDottedPhaseRegexDrift(text), []);
});

test('findLooseDottedPhaseRegexDrift does NOT overlap the single-segment or letterless rules', () => {
  const bounded = 'if ! [[ "$PADDED_PHASE" =~ ^[0-9]+(\\.[0-9]+)?$ ]]; then';
  const letterless = 'if ! [[ "$PADDED_PHASE" =~ ^[0-9]+(\\.[0-9]+)*$ ]]; then';
  assert.deepEqual(findLooseDottedPhaseRegexDrift(bounded), []);
  assert.deepEqual(findLooseDottedPhaseRegexDrift(letterless), []);
});

test('findLooseDottedPhaseRegexDrift does NOT flag a non-phase-carrying line (a version) and honours the sanction', () => {
  assert.deepEqual(findLooseDottedPhaseRegexDrift("MAJOR=$(echo \"$VERSION\" | grep -oE '[0-9]+\\.?[0-9]*')"), []);
  const text = [
    '<!-- phase-id-owner: deliberate, tracked in #4748 -->',
    "PHASE=$(echo \"$ARGUMENTS\" | grep -oE '[0-9]+\\.?[0-9]*' | head -1)",
  ].join('\n');
  assert.deepEqual(findLooseDottedPhaseRegexDrift(text), []);
});

// c. printf re-pad
test('findShellPhasePrintfPadDrift flags `printf "%02d"` of a phase variable, braced or bare', () => {
  const found = findShellPhasePrintfPadDrift('PADDED=$(printf "%02d" "${PHASE_NUMBER}")');
  assert.equal(found.length, 1);
  assert.equal(found[0].found, 'printf "%0…d" …$PHASE_NUMBER');
  assert.equal(findShellPhasePrintfPadDrift('PHASE=$(printf "%02d" "$PHASE")').length, 1);
  assert.equal(findShellPhasePrintfPadDrift('PHASE=$(printf "%02d.%s" "${PHASE_MAJOR}" "${PHASE_MINOR}")').length, 1);
});

test('findShellPhasePrintfPadDrift flags the single-quoted format and a width without the zero flag', () => {
  assert.equal(findShellPhasePrintfPadDrift("PADDED=$(printf '%02d' \"$PHASE_NUMBER\")").length, 1);
  assert.equal(findShellPhasePrintfPadDrift('PADDED=$(printf "%2d" "$PHASE_NUMBER")').length, 1);
});

test('findShellPhasePrintfPadDrift is SILENT on a pad of an _INT via $((10#…)) and on init\'s padded_phase binding', () => {
  assert.deepEqual(findShellPhasePrintfPadDrift('PHASE=$(printf "%02d" "$((10#$PHASE_INT))")${BASH_REMATCH[2]}'), []);
  assert.deepEqual(findShellPhasePrintfPadDrift('PADDED="{padded_phase}"'), []);
});

test('findShellPhasePrintfPadDrift does NOT flag a pad of a non-phase variable (a plan number)', () => {
  assert.deepEqual(findShellPhasePrintfPadDrift('PLAN_PADDED=$(printf "%02d" "$PLAN_ID")'), []);
});

test('findShellPhasePrintfPadDrift skips a full-line comment and honours the HTML sanction', () => {
  assert.deepEqual(findShellPhasePrintfPadDrift('# PADDED=$(printf "%02d" "${PHASE_NUMBER}")'), []);
  const text = [
    '<!-- phase-id-owner: integer-only surface, tracked in #4748 -->',
    'PADDED=$(printf "%02d" "${PHASE_NUMBER}")',
  ].join('\n');
  assert.deepEqual(findShellPhasePrintfPadDrift(text), []);
});

test('scanMarkdownLetterAxisConsumers against the real repo tree reports zero violations (#4748 fixed)', () => {
  assert.deepEqual(scanMarkdownLetterAxisConsumers(ROOT), []);
});
