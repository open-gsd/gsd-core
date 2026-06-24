'use strict';
/**
 * tests/verdict-eval.test.cjs
 *
 * TDD suite for the B1 critic self-disconfirmation eval harness.
 * 4 modes: baseline / disconfirmation / exogenous / abstention
 * disconfirmation + abstention are the two endogenous arms.
 *
 * IMPORTANT: these tests assert ONLY on structured values — typed numeric metrics,
 * GATE_REASON enum codes, boolean .pass, numeric .n/.recall/.truePassPrecision etc.
 * NEVER readFileSync a source file and NEVER assert.match on free-form strings.
 * This satisfies RULESET.TESTS.no-source-grep and the typed-IR rule.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  VERDICT,
  GATE_REASON,
  judge,
  scoreCritic,
  evalGate,
} = require('./verdict-eval/harness.cjs');

const corpus = require('./verdict-eval/corpus.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Synthetic critic functions used throughout structural + boundary tests. */
const blockEverything = () => ({ verdict: VERDICT.BLOCK, confidence: 'high' });
const passEverything  = () => ({ verdict: VERDICT.PASS,  confidence: 'high' });

/**
 * Build a minimal synthetic scoreCritic-like result for evalGate boundary tests.
 * We only populate the fields evalGate actually reads: inferable.recall and
 * clean.truePassPrecision. Other fields are set to safe nulls/zeros.
 * Includes all four class slices + nonInferable + overall.
 */
function syntheticResult({
  inferableRecall,
  cleanTpp,
  domainKnowledgeRecall = 0,
  specSilentRecall = 0,
}) {
  const makeMetrics = (recall, tpp) => ({
    n: 3,
    tp: 0, fn: 0, fp: 0, tn: 0,
    recall,
    precision: null,
    falsePassRate: null,
    confidentFalsePassRate: recall === 0 ? 1 : 0,
    truePassPrecision: tpp,
  });
  // nonInferable is the union of domainKnowledge + specSilent; use specSilentRecall as proxy
  const nonInferableRecall = specSilentRecall;
  return {
    rows: [],
    overall:         makeMetrics(null, null),
    inferable:       makeMetrics(inferableRecall, null),
    domainKnowledge: makeMetrics(domainKnowledgeRecall, null),
    specSilent:      makeMetrics(specSilentRecall, null),
    clean:           makeMetrics(null, cleanTpp),
    nonInferable:    makeMetrics(nonInferableRecall, null),
  };
}

// ---------------------------------------------------------------------------
// Transcript replay helpers
// ---------------------------------------------------------------------------

const { recorded, flagEverything: flagEverythingTranscripts, MODELS, MODES } = require('./verdict-eval/transcripts.cjs');
const expectedResults = require('./verdict-eval/expected-results.json');

/**
 * Build a criticFn that replays recorded transcripts for model×mode.
 */
function replayCriticFn(model, mode) {
  const block = recorded[model][mode];
  return (item) => judge(block[item.id]);
}

/**
 * Build a criticFn that replays the flagEverything synthetic transcripts.
 */
function replayFlagEverythingFn() {
  return (item) => judge(flagEverythingTranscripts[item.id]);
}

// ---------------------------------------------------------------------------
// 1. judge() — transcript extraction
// ---------------------------------------------------------------------------

describe('judge()', () => {
  test('extracts labeled VERDICT: BLOCK', () => {
    const { verdict, confidence } = judge('Some text.\nVERDICT: BLOCK\nconfidence: high');
    assert.equal(verdict, VERDICT.BLOCK);
    assert.equal(confidence, 'high');
  });

  test('extracts labeled VERDICT: FLAG', () => {
    const { verdict } = judge('Analysis here.\nVERDICT: FLAG\nconfidence: low');
    assert.equal(verdict, VERDICT.FLAG);
  });

  test('extracts labeled VERDICT: PASS', () => {
    const { verdict } = judge('Looks fine.\nVERDICT: PASS\nconfidence: high');
    assert.equal(verdict, VERDICT.PASS);
  });

  test('LAST-match-wins: preamble PASS, final VERDICT: BLOCK → BLOCK', () => {
    const transcript = [
      'The code looks like a PASS at first glance.',
      'But on closer inspection there is a clear contradiction.',
      'VERDICT: BLOCK',
      'confidence: high',
    ].join('\n');
    const { verdict } = judge(transcript);
    assert.equal(verdict, VERDICT.BLOCK);
  });

  test('LAST-match-wins: multiple VERDICT: lines, last wins', () => {
    const transcript = 'VERDICT: PASS\nLet me reconsider.\nVERDICT: FLAG\nconfidence: low';
    const { verdict } = judge(transcript);
    assert.equal(verdict, VERDICT.FLAG);
  });

  test('bare-token fallback when no labeled VERDICT:', () => {
    const transcript = 'I think this is fine. PASS.';
    const { verdict } = judge(transcript);
    assert.equal(verdict, VERDICT.PASS);
  });

  test('bare-token fallback: last bare token wins', () => {
    const transcript = 'Initially PASS but then BLOCK on reflection.';
    const { verdict } = judge(transcript);
    assert.equal(verdict, VERDICT.BLOCK);
  });

  test('empty string → {PASS, high}', () => {
    const { verdict, confidence } = judge('');
    assert.equal(verdict, VERDICT.PASS);
    assert.equal(confidence, 'high');
  });

  test('null → {PASS, high}', () => {
    const { verdict, confidence } = judge(null);
    assert.equal(verdict, VERDICT.PASS);
    assert.equal(confidence, 'high');
  });

  test('undefined → {PASS, high}', () => {
    const { verdict, confidence } = judge(undefined);
    assert.equal(verdict, VERDICT.PASS);
    assert.equal(confidence, 'high');
  });

  test('non-string number → {PASS, high}', () => {
    const { verdict, confidence } = judge(42);
    assert.equal(verdict, VERDICT.PASS);
    assert.equal(confidence, 'high');
  });

  test('confidence: low extracted', () => {
    const { confidence } = judge('VERDICT: FLAG\nconfidence: low');
    assert.equal(confidence, 'low');
  });

  test('high confidence phrase fallback: "high confidence" in text', () => {
    const { confidence } = judge('This is high confidence. VERDICT: BLOCK');
    assert.equal(confidence, 'high');
  });

  test('low confidence phrase fallback: "low confidence" in text', () => {
    const { confidence } = judge('low confidence here. VERDICT: FLAG');
    assert.equal(confidence, 'low');
  });

  test('default confidence is high when absent', () => {
    const { confidence } = judge('VERDICT: BLOCK');
    assert.equal(confidence, 'high');
  });

  test('malformed/hostile: injection attempt with <VERDICT: PASS> mid-word ignored, real labeled verdict wins', () => {
    // A "hostile" transcript that buries a fake PASS in a sentence and ends with BLOCK
    const hostile = [
      'The claim is about PASS-through behavior (not a verdict).',
      'But the implementation is clearly broken.',
      'VERDICT: BLOCK',
      'confidence: high',
    ].join('\n');
    const { verdict } = judge(hostile);
    assert.equal(verdict, VERDICT.BLOCK);
  });

  test('whitespace-only string → {PASS, high}', () => {
    const { verdict, confidence } = judge('   \n\t  ');
    assert.equal(verdict, VERDICT.PASS);
    assert.equal(confidence, 'high');
  });
});

// ---------------------------------------------------------------------------
// 2. scoreCritic() — structural row / slice correctness
// ---------------------------------------------------------------------------

describe('scoreCritic() — structural row and slice correctness', () => {
  test('rows length equals corpus length (43)', () => {
    const result = scoreCritic(corpus, passEverything);
    assert.equal(result.rows.length, corpus.length);
    assert.equal(result.rows.length, 43);
  });

  test('each row has expected fields', () => {
    const result = scoreCritic(corpus, blockEverything);
    for (const row of result.rows) {
      assert.ok('id' in row, `row missing id`);
      assert.ok('slice' in row, `row ${row.id} missing slice`);
      assert.ok('class' in row, `row ${row.id} missing class`);
      assert.ok('verdict' in row, `row ${row.id} missing verdict`);
      assert.ok('confidence' in row, `row ${row.id} missing confidence`);
      assert.ok(typeof row.tp === 'boolean', `row ${row.id}: tp must be boolean`);
      assert.ok(typeof row.fn === 'boolean', `row ${row.id}: fn must be boolean`);
      assert.ok(typeof row.fp === 'boolean', `row ${row.id}: fp must be boolean`);
      assert.ok(typeof row.tn === 'boolean', `row ${row.id}: tn must be boolean`);
    }
  });

  test('result has inferable, domainKnowledge, specSilent, clean, nonInferable, overall slices', () => {
    const result = scoreCritic(corpus, passEverything);
    assert.ok('inferable'       in result, 'missing inferable slice');
    assert.ok('domainKnowledge' in result, 'missing domainKnowledge slice');
    assert.ok('specSilent'      in result, 'missing specSilent slice');
    assert.ok('clean'           in result, 'missing clean slice');
    assert.ok('nonInferable'    in result, 'missing nonInferable slice');
    assert.ok('overall'         in result, 'missing overall slice');
  });

  test('slice n values match corpus class counts', () => {
    const result = scoreCritic(corpus, passEverything);
    assert.equal(result.inferable.n,       12, 'inferable.n should be 12');
    assert.equal(result.domainKnowledge.n, 10, 'domainKnowledge.n should be 10');
    assert.equal(result.specSilent.n,      14, 'specSilent.n should be 14');
    assert.equal(result.clean.n,            7, 'clean.n should be 7');
    assert.equal(result.nonInferable.n,    24, 'nonInferable.n should be 24 (10+14)');
    assert.equal(result.overall.n,         43, 'overall.n should be 43');
  });

  test('blockEverything: clean truePassPrecision is 0 (over-blocking)', () => {
    const result = scoreCritic(corpus, blockEverything);
    assert.equal(result.clean.truePassPrecision, 0,
      'blockEverything blocks all clean items → TN=0 → truePassPrecision=0');
  });

  test('passEverything: inferable recall is 0 and clean truePassPrecision is 1', () => {
    const result = scoreCritic(corpus, passEverything);
    assert.equal(result.inferable.recall, 0,
      'passEverything misses all inferable defects → recall=0');
    assert.equal(result.clean.truePassPrecision, 1,
      'passEverything passes all clean items → truePassPrecision=1');
  });

  test('each row.slice matches the item class', () => {
    const result = scoreCritic(corpus, passEverything);
    const expectedSlice = {
      'inferable': 'inferable',
      'domain-knowledge': 'domainKnowledge',
      'spec-silent': 'specSilent',
      'clean': 'clean',
    };
    for (const row of result.rows) {
      const item = corpus.find((i) => i.id === row.id);
      assert.equal(row.slice, expectedSlice[item.class],
        `row ${row.id}: slice '${row.slice}' does not match class '${item.class}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Golden fixture — 2-model × 4-mode replay against expected-results.json
// ---------------------------------------------------------------------------

describe('golden fixture — recorded transcript replay (2 models × 4 modes + flagEverything)', () => {
  // Helper: extract only the metrics fields deep-equal asserts over
  const metricsFields = (m) => ({
    n: m.n,
    tp: m.tp,
    fn: m.fn,
    fp: m.fp,
    tn: m.tn,
    recall: m.recall,
    precision: m.precision,
    falsePassRate: m.falsePassRate,
    confidentFalsePassRate: m.confidentFalsePassRate,
    truePassPrecision: m.truePassPrecision,
  });

  for (const model of MODELS) {
    for (const mode of MODES) {
      test(`${model}.${mode} — all slice metrics match golden`, () => {
        const criticFn = replayCriticFn(model, mode);
        const result = scoreCritic(corpus, criticFn);
        const exp = expectedResults[model][mode];
        for (const sliceKey of ['inferable', 'domainKnowledge', 'specSilent', 'clean', 'nonInferable', 'overall']) {
          assert.deepEqual(
            metricsFields(result[sliceKey]),
            metricsFields(exp[sliceKey]),
            `${model}.${mode}.${sliceKey} mismatch`
          );
        }
      });
    }
  }

  test('flagEverything — all slice metrics match golden', () => {
    const criticFn = replayFlagEverythingFn();
    const result = scoreCritic(corpus, criticFn);
    const exp = expectedResults.flagEverything;
    for (const sliceKey of ['inferable', 'domainKnowledge', 'specSilent', 'clean', 'nonInferable', 'overall']) {
      assert.deepEqual(
        metricsFields(result[sliceKey]),
        metricsFields(exp[sliceKey]),
        `flagEverything.${sliceKey} mismatch`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. evalGate() — typed outcomes
// ---------------------------------------------------------------------------

describe('evalGate() — typed pass/fail outcomes', () => {
  test('blockEverything → FAIL with TRUE_PASS_PRECISION_BELOW_FLOOR despite perfect recall', () => {
    const result = scoreCritic(corpus, blockEverything);
    const gate = evalGate(result, { inferableRecallFloor: 0.9, truePassPrecisionFloor: 0.5 });
    assert.equal(gate.pass, false, 'blockEverything must fail the gate (anti-gaming proof)');
    const codes = gate.failures.map((f) => f.code);
    assert.ok(
      codes.includes(GATE_REASON.TRUE_PASS_PRECISION_BELOW_FLOOR),
      `expected TRUE_PASS_PRECISION_BELOW_FLOOR, got: ${JSON.stringify(codes)}`
    );
  });

  test('failures carry {code, slice, observed, floor} shape', () => {
    const result = scoreCritic(corpus, blockEverything);
    const gate = evalGate(result, { inferableRecallFloor: 0.9, truePassPrecisionFloor: 0.5 });
    assert.ok(gate.failures.length > 0);
    for (const f of gate.failures) {
      assert.ok(typeof f.code === 'string', 'failure.code must be string');
      assert.ok(typeof f.slice === 'string', 'failure.slice must be string');
      assert.ok(typeof f.floor === 'number', 'failure.floor must be number');
      // observed may be null (when denominator=0) or a number
      assert.ok(f.observed === null || typeof f.observed === 'number');
    }
  });

  test('evalGate NEVER gates non-inferable: zero non-inferable recall still PASSes when inferable+clean floors met', () => {
    const r = syntheticResult({ inferableRecall: 1.0, cleanTpp: 1.0, domainKnowledgeRecall: 0, specSilentRecall: 0 });
    const gate = evalGate(r, { inferableRecallFloor: 0.9, truePassPrecisionFloor: 0.5 });
    assert.equal(gate.pass, true,
      'non-inferable recall=0 must not cause gate failure; failures: ' + JSON.stringify(gate.failures));
  });

  test('report is present with domainKnowledge, specSilent, nonInferable sub-objects', () => {
    const result = scoreCritic(corpus, passEverything);
    const gate = evalGate(result);
    assert.ok(gate.report !== undefined, 'gate.report must be present');
    assert.ok('domainKnowledge' in gate.report, 'gate.report.domainKnowledge must be present');
    assert.ok('specSilent'      in gate.report, 'gate.report.specSilent must be present');
    assert.ok('nonInferable'    in gate.report, 'gate.report.nonInferable must be present');
  });

  test('report sub-objects have {n, recall, confidentFalsePassRate} shape', () => {
    const result = scoreCritic(corpus, passEverything);
    const gate = evalGate(result);
    for (const key of ['domainKnowledge', 'specSilent', 'nonInferable']) {
      const sub = gate.report[key];
      assert.ok('n'                    in sub, `report.${key} missing n`);
      assert.ok('recall'               in sub, `report.${key} missing recall`);
      assert.ok('confidentFalsePassRate' in sub, `report.${key} missing confidentFalsePassRate`);
    }
  });

  test('nonInferableReport back-compat alias equals report.nonInferable', () => {
    const result = scoreCritic(corpus, passEverything);
    const gate = evalGate(result);
    assert.deepEqual(gate.nonInferableReport, gate.report.nonInferable,
      'nonInferableReport alias must equal report.nonInferable');
  });

  test('perSlice has inferable, domainKnowledge, specSilent, nonInferable, clean keys', () => {
    const result = scoreCritic(corpus, passEverything);
    const gate = evalGate(result);
    for (const key of ['inferable', 'domainKnowledge', 'specSilent', 'nonInferable', 'clean']) {
      assert.ok(key in gate.perSlice, `gate.perSlice missing '${key}'`);
    }
  });

  test('passEverything: gate fails inferable recall (0 < floor)', () => {
    const result = scoreCritic(corpus, passEverything);
    const gate = evalGate(result, { inferableRecallFloor: 0.9, truePassPrecisionFloor: 0.5 });
    assert.equal(gate.pass, false);
    const codes = gate.failures.map((f) => f.code);
    assert.ok(codes.includes(GATE_REASON.INFERABLE_RECALL_BELOW_FLOOR),
      `passEverything should fail inferable recall; codes: ${JSON.stringify(codes)}`);
  });

  test('passEverything: gate does NOT fail clean truePassPrecision (all clean correctly passed)', () => {
    const result = scoreCritic(corpus, passEverything);
    const gate = evalGate(result, { inferableRecallFloor: 0.9, truePassPrecisionFloor: 0.5 });
    const codes = gate.failures.map((f) => f.code);
    assert.ok(!codes.includes(GATE_REASON.TRUE_PASS_PRECISION_BELOW_FLOOR),
      'passEverything should NOT fail clean tpp (all clean are PASS)');
  });
});

// ---------------------------------------------------------------------------
// 5. Boundary coverage — floor-1/floor/floor+1 triples
// ---------------------------------------------------------------------------

describe('evalGate() — boundary coverage at floor thresholds', () => {
  const INF_FLOOR = 0.9;
  const TPP_FLOOR = 0.5;

  // Inferable recall triple
  test('inferable recall = floor - 0.01 → FAIL', () => {
    const r = syntheticResult({ inferableRecall: INF_FLOOR - 0.01, cleanTpp: 1.0 });
    const gate = evalGate(r, { inferableRecallFloor: INF_FLOOR, truePassPrecisionFloor: TPP_FLOOR });
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.map((f) => f.code).includes(GATE_REASON.INFERABLE_RECALL_BELOW_FLOOR));
  });

  test('inferable recall = floor exactly → PASS', () => {
    const r = syntheticResult({ inferableRecall: INF_FLOOR, cleanTpp: 1.0 });
    const gate = evalGate(r, { inferableRecallFloor: INF_FLOOR, truePassPrecisionFloor: TPP_FLOOR });
    assert.equal(gate.pass, true, `expected pass at floor exactly; failures: ${JSON.stringify(gate.failures)}`);
  });

  test('inferable recall = floor + 0.01 → PASS', () => {
    const r = syntheticResult({ inferableRecall: INF_FLOOR + 0.01, cleanTpp: 1.0 });
    const gate = evalGate(r, { inferableRecallFloor: INF_FLOOR, truePassPrecisionFloor: TPP_FLOOR });
    assert.equal(gate.pass, true);
  });

  // Clean truePassPrecision triple
  test('clean truePassPrecision = floor - 0.01 → FAIL', () => {
    const r = syntheticResult({ inferableRecall: 1.0, cleanTpp: TPP_FLOOR - 0.01 });
    const gate = evalGate(r, { inferableRecallFloor: INF_FLOOR, truePassPrecisionFloor: TPP_FLOOR });
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.map((f) => f.code).includes(GATE_REASON.TRUE_PASS_PRECISION_BELOW_FLOOR));
  });

  test('clean truePassPrecision = floor exactly → PASS', () => {
    const r = syntheticResult({ inferableRecall: 1.0, cleanTpp: TPP_FLOOR });
    const gate = evalGate(r, { inferableRecallFloor: INF_FLOOR, truePassPrecisionFloor: TPP_FLOOR });
    assert.equal(gate.pass, true, `expected pass at floor exactly; failures: ${JSON.stringify(gate.failures)}`);
  });

  test('clean truePassPrecision = floor + 0.01 → PASS', () => {
    const r = syntheticResult({ inferableRecall: 1.0, cleanTpp: TPP_FLOOR + 0.01 });
    const gate = evalGate(r, { inferableRecallFloor: INF_FLOOR, truePassPrecisionFloor: TPP_FLOOR });
    assert.equal(gate.pass, true);
  });
});

// ---------------------------------------------------------------------------
// 6. Gate does NOT gate non-inferable
// ---------------------------------------------------------------------------

describe('evalGate() — non-inferable is REPORTED, never gated', () => {
  test('inferable recall ≥ floor, clean tpp ≥ floor, non-inferable recall=0 → PASS', () => {
    const r = syntheticResult({ inferableRecall: 1.0, cleanTpp: 1.0, specSilentRecall: 0, domainKnowledgeRecall: 0 });
    const gate = evalGate(r, { inferableRecallFloor: 0.9, truePassPrecisionFloor: 0.5 });
    assert.equal(gate.pass, true,
      'non-inferable recall=0 must not cause failure; failures: ' + JSON.stringify(gate.failures));
  });

  test('report.nonInferable is always present in gate result', () => {
    const r = syntheticResult({ inferableRecall: 1.0, cleanTpp: 1.0, specSilentRecall: 0 });
    const gate = evalGate(r, { inferableRecallFloor: 0.9, truePassPrecisionFloor: 0.5 });
    assert.ok(gate.report.nonInferable !== undefined);
    assert.ok('n'                    in gate.report.nonInferable);
    assert.ok('recall'               in gate.report.nonInferable);
    assert.ok('confidentFalsePassRate' in gate.report.nonInferable);
  });

  test('report.nonInferable.recall equals 0 when non-inferable recall=0', () => {
    const r = syntheticResult({ inferableRecall: 1.0, cleanTpp: 1.0, specSilentRecall: 0 });
    const gate = evalGate(r, { inferableRecallFloor: 0.9, truePassPrecisionFloor: 0.5 });
    assert.equal(gate.report.nonInferable.recall, 0);
  });

  test('passEverything on real corpus: non-inferable recall=0 while gate.pass=false (fails inferable, not non-inferable)', () => {
    const result = scoreCritic(corpus, passEverything);
    const gate = evalGate(result, { inferableRecallFloor: 0.9, truePassPrecisionFloor: 0.5 });
    // Gate fails for inferable recall, not non-inferable
    const codes = gate.failures.map((f) => f.code);
    assert.ok(codes.includes(GATE_REASON.INFERABLE_RECALL_BELOW_FLOOR),
      'should fail inferable recall');
    assert.ok(!codes.includes('non_inferable_recall_below_floor'),
      'should NOT fail non-inferable (not a gated metric)');
    // non-inferable recall is 0 (passEverything misses all defects)
    assert.equal(result.nonInferable.recall, 0);
    // This slice miss does NOT appear in failures
    assert.equal(gate.report.nonInferable.recall, 0);
  });
});

// ---------------------------------------------------------------------------
// 7. Corpus integrity
// ---------------------------------------------------------------------------

describe('corpus integrity', () => {
  test('corpus has exactly 43 items', () => {
    assert.equal(corpus.length, 43);
  });

  test('class counts: inferable=12, domain-knowledge=10, spec-silent=14, clean=7', () => {
    const counts = { inferable: 0, 'domain-knowledge': 0, 'spec-silent': 0, clean: 0 };
    for (const item of corpus) {
      assert.ok(item.class in counts, `unexpected class '${item.class}' on item ${item.id}`);
      counts[item.class]++;
    }
    assert.equal(counts['inferable'],        12, 'inferable count');
    assert.equal(counts['domain-knowledge'], 10, 'domain-knowledge count');
    assert.equal(counts['spec-silent'],      14, 'spec-silent count');
    assert.equal(counts['clean'],             7, 'clean count');
  });

  test('every item has {id, class, groundTruth, artifact.claim (string), artifact.code (string)}', () => {
    for (const item of corpus) {
      assert.ok(typeof item.id === 'string',
        `item id must be string`);
      assert.ok(
        item.class === 'inferable' || item.class === 'domain-knowledge' ||
        item.class === 'spec-silent' || item.class === 'clean',
        `item ${item.id}: class must be inferable|domain-knowledge|spec-silent|clean, got '${item.class}'`
      );
      assert.ok(
        item.groundTruth === VERDICT.PASS ||
        item.groundTruth === VERDICT.BLOCK ||
        item.groundTruth === VERDICT.FLAG,
        `item ${item.id}: groundTruth must be VERDICT member, got '${item.groundTruth}'`
      );
      assert.ok(
        item.artifact && typeof item.artifact.claim === 'string' && item.artifact.claim.length > 0,
        `item ${item.id}: artifact.claim must be non-empty string`
      );
      assert.ok(
        item.artifact && typeof item.artifact.code === 'string' && item.artifact.code.length > 0,
        `item ${item.id}: artifact.code must be non-empty string`
      );
    }
  });

  test('clean items have injectedDefect=null', () => {
    for (const item of corpus.filter((i) => i.groundTruth === VERDICT.PASS)) {
      assert.equal(item.injectedDefect, null,
        `clean item ${item.id} should have injectedDefect=null`);
    }
  });

  test('non-inferable items (domain-knowledge + spec-silent) have a non-empty blindSpotHint', () => {
    const nonInferable = corpus.filter(
      (i) => i.class === 'domain-knowledge' || i.class === 'spec-silent'
    );
    for (const item of nonInferable) {
      assert.ok(
        typeof item.blindSpotHint === 'string' && item.blindSpotHint.length > 0,
        `non-inferable item ${item.id} must have a non-empty blindSpotHint`
      );
    }
  });

  test('all ids are unique', () => {
    const ids = corpus.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, 'all corpus item ids must be unique');
  });

  test('groundTruth is consistent with class: clean items have PASS, non-clean items have BLOCK or FLAG', () => {
    for (const item of corpus) {
      if (item.class === 'clean') {
        assert.equal(item.groundTruth, VERDICT.PASS,
          `clean item ${item.id} must have groundTruth=PASS`);
      } else {
        assert.ok(
          item.groundTruth === VERDICT.BLOCK || item.groundTruth === VERDICT.FLAG,
          `non-clean item ${item.id} must have groundTruth=BLOCK|FLAG, got '${item.groundTruth}'`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Property-based tests (fast-check, pinned seed=42, numRuns=200)
// ---------------------------------------------------------------------------

describe('property-based: scoreCritic and evalGate invariants', () => {
  const VERDICTS = [VERDICT.PASS, VERDICT.FLAG, VERDICT.BLOCK];
  const CONFIDENCES = ['high', 'low'];

  // Arbitrary per-item verdict/confidence generator
  const arbCriticOutputMap = fc.dictionary(
    fc.constantFrom(...corpus.map((i) => i.id)),
    fc.record({
      verdict: fc.constantFrom(...VERDICTS),
      confidence: fc.constantFrom(...CONFIDENCES),
    })
  );

  test('(a) per slice: tp+fn+fp+tn === slice.n', () => {
    fc.assert(
      fc.property(arbCriticOutputMap, (outputMap) => {
        const criticFn = (item) => outputMap[item.id] || { verdict: VERDICT.PASS, confidence: 'high' };
        const result = scoreCritic(corpus, criticFn);
        const sliceKeyToRowFilter = {
          overall:         () => true,
          inferable:       (r) => r.slice === 'inferable',
          domainKnowledge: (r) => r.slice === 'domainKnowledge',
          specSilent:      (r) => r.slice === 'specSilent',
          nonInferable:    (r) => r.slice === 'domainKnowledge' || r.slice === 'specSilent',
          clean:           (r) => r.slice === 'clean',
        };
        for (const sliceKey of ['overall', 'inferable', 'domainKnowledge', 'specSilent', 'nonInferable', 'clean']) {
          const m = result[sliceKey];
          const boolToInt = (b) => (b ? 1 : 0);
          const sumFromRows = result.rows
            .filter(sliceKeyToRowFilter[sliceKey])
            .reduce((acc, r) => acc + boolToInt(r.tp) + boolToInt(r.fn) + boolToInt(r.fp) + boolToInt(r.tn), 0);
          if (sumFromRows !== m.n) return false;
        }
        return true;
      }),
      { seed: 42, numRuns: 200 }
    );
  });

  test('(b) recall/precision/truePassPrecision are null or within [0,1]', () => {
    fc.assert(
      fc.property(arbCriticOutputMap, (outputMap) => {
        const criticFn = (item) => outputMap[item.id] || { verdict: VERDICT.PASS, confidence: 'high' };
        const result = scoreCritic(corpus, criticFn);
        const checkMetric = (v) => v === null || (typeof v === 'number' && v >= 0 && v <= 1);
        for (const sliceKey of ['overall', 'inferable', 'domainKnowledge', 'specSilent', 'nonInferable', 'clean']) {
          const m = result[sliceKey];
          if (!checkMetric(m.recall)) return false;
          if (!checkMetric(m.precision)) return false;
          if (!checkMetric(m.truePassPrecision)) return false;
        }
        return true;
      }),
      { seed: 42, numRuns: 200 }
    );
  });

  test('(c) PASS-everything critic: recall 0-or-null on defect slices, truePassPrecision 1 on clean', () => {
    const result = scoreCritic(corpus, passEverything);
    // All defect slices should have recall=0 (defects were missed)
    assert.ok(result.inferable.recall === 0       || result.inferable.recall === null,
      `inferable.recall should be 0 or null, got ${result.inferable.recall}`);
    assert.ok(result.domainKnowledge.recall === 0 || result.domainKnowledge.recall === null,
      `domainKnowledge.recall should be 0 or null, got ${result.domainKnowledge.recall}`);
    assert.ok(result.specSilent.recall === 0      || result.specSilent.recall === null,
      `specSilent.recall should be 0 or null, got ${result.specSilent.recall}`);
    assert.ok(result.nonInferable.recall === 0    || result.nonInferable.recall === null,
      `nonInferable.recall should be 0 or null, got ${result.nonInferable.recall}`);
    // Clean: all passed correctly → TN=n, FP=0, truePassPrecision=1
    assert.equal(result.clean.truePassPrecision, 1);
  });

  test('(d) evalGate.pass is boolean; failures only carry GATE_REASON values', () => {
    fc.assert(
      fc.property(arbCriticOutputMap, (outputMap) => {
        const criticFn = (item) => outputMap[item.id] || { verdict: VERDICT.PASS, confidence: 'high' };
        const result = scoreCritic(corpus, criticFn);
        const gate = evalGate(result, { inferableRecallFloor: 0.9, truePassPrecisionFloor: 0.5 });
        if (typeof gate.pass !== 'boolean') return false;
        const validCodes = Object.values(GATE_REASON);
        for (const f of gate.failures) {
          if (!validCodes.includes(f.code)) return false;
        }
        return true;
      }),
      { seed: 42, numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Anti-gaming: flagEverything fails the gate
// ---------------------------------------------------------------------------

describe('anti-gaming: flagEverything critic fails the gate', () => {
  test('flagEverything → evalGate.pass=false with TRUE_PASS_PRECISION_BELOW_FLOOR', () => {
    const criticFn = replayFlagEverythingFn();
    const result = scoreCritic(corpus, criticFn);
    const gate = evalGate(result, { inferableRecallFloor: 0.9, truePassPrecisionFloor: 0.5 });
    assert.equal(gate.pass, false,
      'flagEverything must fail the gate despite perfect recall');
    const codes = gate.failures.map((f) => f.code);
    assert.ok(
      codes.includes(GATE_REASON.TRUE_PASS_PRECISION_BELOW_FLOOR),
      `expected TRUE_PASS_PRECISION_BELOW_FLOOR in failures; got: ${JSON.stringify(codes)}`
    );
  });

  test('flagEverything clean.truePassPrecision is 0 (all clean BLOCKed → TN=0)', () => {
    const criticFn = replayFlagEverythingFn();
    const result = scoreCritic(corpus, criticFn);
    assert.equal(result.clean.truePassPrecision, 0);
  });
});

// ---------------------------------------------------------------------------
// 10. Reporting: evalGate report has numeric/null recall on non-inferable slices
//     for each model × each endogenous arm (disconfirmation + abstention)
// ---------------------------------------------------------------------------

describe('reporting: evalGate report has per-class numeric metrics for each model × endogenous arm', () => {
  const ENDOGENOUS_ARMS = ['disconfirmation', 'abstention'];

  for (const model of MODELS) {
    for (const arm of ENDOGENOUS_ARMS) {
      test(`${model}.${arm} — report.domainKnowledge and report.specSilent have numeric/null recall`, () => {
        const criticFn = replayCriticFn(model, arm);
        const result = scoreCritic(corpus, criticFn);
        const gate = evalGate(result);

        // domainKnowledge
        const dk = gate.report.domainKnowledge;
        assert.ok('recall' in dk, 'report.domainKnowledge must have recall');
        assert.ok(
          dk.recall === null || (typeof dk.recall === 'number' && dk.recall >= 0 && dk.recall <= 1),
          `report.domainKnowledge.recall must be null or [0,1], got: ${dk.recall}`
        );
        // Verify against golden
        assert.equal(dk.recall, expectedResults[model][arm].domainKnowledge.recall,
          `${model}.${arm} domainKnowledge.recall must match golden`);

        // specSilent
        const ss = gate.report.specSilent;
        assert.ok('recall' in ss, 'report.specSilent must have recall');
        assert.ok(
          ss.recall === null || (typeof ss.recall === 'number' && ss.recall >= 0 && ss.recall <= 1),
          `report.specSilent.recall must be null or [0,1], got: ${ss.recall}`
        );
        // Verify against golden
        assert.equal(ss.recall, expectedResults[model][arm].specSilent.recall,
          `${model}.${arm} specSilent.recall must match golden`);
      });
    }
  }
});
