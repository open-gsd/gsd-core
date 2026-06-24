'use strict';
/**
 * tests/verdict-eval/harness.cjs
 *
 * Pure eval harness for B1 critic self-disconfirmation.
 * No I/O. No console. No side-effects.
 *
 * Design invariants:
 *   - evalGate enforces ONLY two per-slice floors: inferable recall and clean
 *     truePassPrecision. It NEVER gates the non-inferable slice (blind by
 *     construction — that's #1154's exogenous job).
 *   - A blended aggregate recall verdict is NEVER returned. Per-slice is
 *     mandatory to keep the non-inferable blind spot visible.
 *   - The non-inferable (domain-knowledge + spec-silent) slices are always
 *     REPORTED in result.report so callers can surface them, but they are
 *     never a gate failure.
 *   - truePassPrecision = TN/(TN+FP) on the clean slice. A flag-everything
 *     critic gets TN=0 → truePassPrecision=0, which FAILS the gate despite
 *     perfect recall. This prevents the precision/recall gaming loophole.
 */

/** Canonical verdict values. */
const VERDICT = Object.freeze({ PASS: 'PASS', FLAG: 'FLAG', BLOCK: 'BLOCK' });

/** Typed gate-failure reason codes. Mirrors REASON-enum pattern. */
const GATE_REASON = Object.freeze({
  INFERABLE_RECALL_BELOW_FLOOR: 'inferable_recall_below_floor',
  TRUE_PASS_PRECISION_BELOW_FLOOR: 'true_pass_precision_below_floor',
});

/**
 * caught(verdict) → true when the critic declined to PASS.
 */
const caught = (verdict) => verdict !== VERDICT.PASS;

/**
 * judge(transcript) → {verdict, confidence}
 *
 * Extracts a structured verdict from a recorded transcript string.
 * Token-regex rules (case-insensitive; LAST match wins so preamble is ignored):
 *   verdict:    labeled "VERDICT: BLOCK|FLAG|PASS" preferred;
 *               fallback: bare "BLOCK|FLAG|PASS" token.
 *   confidence: labeled "confidence: high|low" preferred;
 *               fallback: "high confidence" | "low confidence" phrase.
 *               default 'high' when absent (omitting hedging implies confidence).
 *   non-string / empty / whitespace-only → {PASS, 'high'}
 */
function judge(transcript) {
  if (typeof transcript !== 'string' || transcript.trim() === '') {
    return { verdict: VERDICT.PASS, confidence: 'high' };
  }

  // --- verdict extraction ---
  let verdict = VERDICT.PASS;
  const labeledVerdictRe = /\bverdict\s*:\s*(block|flag|pass)\b/gi;
  const bareVerdictRe = /\b(block|flag|pass)\b/gi;

  let m;
  let lastLabeled = null;
  while ((m = labeledVerdictRe.exec(transcript)) !== null) {
    lastLabeled = m[1].toUpperCase();
  }
  if (lastLabeled !== null) {
    verdict = lastLabeled;
  } else {
    let lastBare = null;
    while ((m = bareVerdictRe.exec(transcript)) !== null) {
      lastBare = m[1].toUpperCase();
    }
    if (lastBare !== null) verdict = lastBare;
  }

  // --- confidence extraction ---
  let confidence = 'high'; // default: absent confidence = confident
  const labeledConfRe = /\bconfidence\s*:\s*(high|low)\b/gi;
  const phraseConfRe = /\b(high|low)\s+confidence\b/gi;
  let lastConf = null;
  while ((m = labeledConfRe.exec(transcript)) !== null) {
    lastConf = m[1].toLowerCase();
  }
  if (lastConf === null) {
    while ((m = phraseConfRe.exec(transcript)) !== null) {
      lastConf = m[1].toLowerCase();
    }
  }
  if (lastConf !== null) confidence = lastConf;

  return { verdict, confidence };
}

/**
 * scoreCritic(corpus, criticFn) → {
 *   rows,
 *   overall, inferable, domainKnowledge, specSilent, clean, nonInferable
 * }
 *
 * Scores an injected criticFn over a labeled corpus.
 *
 * @param corpus   Array of items: {
 *   id, class, groundTruth, artifact, injectedDefect, blindSpotHint?
 * }
 * @param criticFn (item) → { verdict, confidence:'high'|'low' }  — INJECTED seam
 *
 * Each metrics block contains:
 *   { n, tp, fn, fp, tn, recall, precision, falsePassRate,
 *     confidentFalsePassRate, truePassPrecision }
 * where null is returned whenever the denominator is zero.
 *
 * Slices (keyed by item.class):
 *   class === 'inferable'         → inferable
 *   class === 'domain-knowledge'  → domainKnowledge
 *   class === 'spec-silent'       → specSilent
 *   class === 'clean' (PASS)      → clean
 *
 * Derived:
 *   nonInferable = domain-knowledge ∪ spec-silent (continuity alias)
 *   overall = all rows
 */
function scoreCritic(corpus, criticFn) {
  const rows = corpus.map((item) => {
    const out = criticFn(item);
    const isDefect = item.groundTruth !== VERDICT.PASS;
    const didCatch = caught(out.verdict);

    // Map item.class to an internal slice key
    let slice;
    switch (item.class) {
      case 'inferable':         slice = 'inferable'; break;
      case 'domain-knowledge':  slice = 'domainKnowledge'; break;
      case 'spec-silent':       slice = 'specSilent'; break;
      case 'clean':
      default:
        slice = 'clean'; break;
    }
    // Fallback for items with no explicit class but PASS groundTruth
    if (!item.class && !isDefect) slice = 'clean';

    return {
      id: item.id,
      class: item.class,
      slice,
      isDefect,
      groundTruth: item.groundTruth,
      verdict: out.verdict,
      confidence: out.confidence,
      falsePass: isDefect && !didCatch,
      confidentFalsePass: isDefect && !didCatch && out.confidence === 'high',
      overBlock: !isDefect && didCatch,
      // Confusion matrix — positive class = "critic flagged a defect"
      tp: isDefect && didCatch,
      fn: isDefect && !didCatch,
      fp: !isDefect && didCatch,
      tn: !isDefect && !didCatch,
    };
  });

  /**
   * Compute metrics for a subset of rows.
   * truePassPrecision = TN / (TN + FP)
   * "of items the critic PASSed, what fraction were actually clean?"
   * A flag-everything critic has TN=0 → truePassPrecision=0.
   */
  const metricsFor = (subset) => {
    const tp = subset.filter((r) => r.tp).length;
    const fn = subset.filter((r) => r.fn).length;
    const fp = subset.filter((r) => r.fp).length;
    const tn = subset.filter((r) => r.tn).length;
    const defects = tp + fn;
    const flagged = tp + fp;
    const passed = tn + fp;
    const confFP = subset.filter((r) => r.confidentFalsePass).length;
    return {
      n: subset.length,
      tp,
      fn,
      fp,
      tn,
      recall: defects > 0 ? tp / defects : null,
      precision: flagged > 0 ? tp / flagged : null,
      falsePassRate: defects > 0 ? fn / defects : null,
      confidentFalsePassRate: defects > 0 ? confFP / defects : null,
      truePassPrecision: passed > 0 ? tn / passed : null,
    };
  };

  const inferableRows      = rows.filter((r) => r.slice === 'inferable');
  const domainKnowledgeRows = rows.filter((r) => r.slice === 'domainKnowledge');
  const specSilentRows     = rows.filter((r) => r.slice === 'specSilent');
  const cleanRows          = rows.filter((r) => r.slice === 'clean');
  // nonInferable = domain-knowledge ∪ spec-silent (derived, for continuity)
  const nonInferableRows   = rows.filter(
    (r) => r.slice === 'domainKnowledge' || r.slice === 'specSilent'
  );

  return {
    rows,
    overall:         metricsFor(rows),
    inferable:       metricsFor(inferableRows),
    domainKnowledge: metricsFor(domainKnowledgeRows),
    specSilent:      metricsFor(specSilentRows),
    clean:           metricsFor(cleanRows),
    nonInferable:    metricsFor(nonInferableRows),
  };
}

/**
 * evalGate(result, opts) → {
 *   pass, failures, perSlice, report
 * }
 *
 * Two-floor non-gameable gate. Enforces:
 *   (1) inferable recall ≥ inferableRecallFloor
 *   (2) clean truePassPrecision ≥ truePassPrecisionFloor
 *
 * DESIGN INVARIANT: non-inferable slices (domain-knowledge, spec-silent) are
 * NEVER gated. They are REPORTED in report so callers can surface them.
 * Gating them is wrong by construction (#1154 is the exogenous arm).
 *
 * DESIGN INVARIANT: no blended aggregate verdict. Callers always see perSlice
 * breakdown and typed failure codes in failures[].
 *
 * @param result output of scoreCritic(...)
 * @param opts   { inferableRecallFloor?: number, truePassPrecisionFloor?: number }
 * @returns {
 *   pass: boolean,
 *   failures: Array<{code, slice, observed, floor}>,
 *   perSlice: { inferable, domainKnowledge, specSilent, clean, nonInferable },
 *   report: { domainKnowledge, specSilent, nonInferable }
 * }
 */
function evalGate(result, { inferableRecallFloor = 0.9, truePassPrecisionFloor = 0.5 } = {}) {
  const failures = [];

  // --- Gate 1: inferable recall ---
  const infRec = result.inferable.recall;
  const infPass = infRec !== null && infRec >= inferableRecallFloor;
  if (!infPass) {
    failures.push({
      code: GATE_REASON.INFERABLE_RECALL_BELOW_FLOOR,
      slice: 'inferable',
      observed: infRec,
      floor: inferableRecallFloor,
    });
  }

  // --- Gate 2: clean-slice truePassPrecision ---
  const cleanTpp = result.clean.truePassPrecision;
  const tppPass = cleanTpp !== null && cleanTpp >= truePassPrecisionFloor;
  if (!tppPass) {
    failures.push({
      code: GATE_REASON.TRUE_PASS_PRECISION_BELOW_FLOOR,
      slice: 'clean',
      observed: cleanTpp,
      floor: truePassPrecisionFloor,
    });
  }

  return {
    pass: failures.length === 0,
    failures,
    perSlice: {
      inferable: {
        n: result.inferable.n,
        recall: result.inferable.recall,
        precision: result.inferable.precision,
        confidentFalsePassRate: result.inferable.confidentFalsePassRate,
      },
      domainKnowledge: {
        n: result.domainKnowledge.n,
        recall: result.domainKnowledge.recall,
        precision: result.domainKnowledge.precision,
        confidentFalsePassRate: result.domainKnowledge.confidentFalsePassRate,
      },
      specSilent: {
        n: result.specSilent.n,
        recall: result.specSilent.recall,
        precision: result.specSilent.precision,
        confidentFalsePassRate: result.specSilent.confidentFalsePassRate,
      },
      nonInferable: {
        n: result.nonInferable.n,
        recall: result.nonInferable.recall,
        precision: result.nonInferable.precision,
        confidentFalsePassRate: result.nonInferable.confidentFalsePassRate,
      },
      clean: {
        n: result.clean.n,
        truePassPrecision: result.clean.truePassPrecision,
        falsePositives: result.clean.fp,
      },
    },
    // Always surfaced, never gated: non-inferable slices are blind by construction.
    // (#1154's exogenous arm is responsible for improving these slices.)
    report: {
      domainKnowledge: {
        n: result.domainKnowledge.n,
        recall: result.domainKnowledge.recall,
        confidentFalsePassRate: result.domainKnowledge.confidentFalsePassRate,
      },
      specSilent: {
        n: result.specSilent.n,
        recall: result.specSilent.recall,
        confidentFalsePassRate: result.specSilent.confidentFalsePassRate,
      },
      nonInferable: {
        n: result.nonInferable.n,
        recall: result.nonInferable.recall,
        confidentFalsePassRate: result.nonInferable.confidentFalsePassRate,
      },
    },
    // Back-compat alias: nonInferableReport = report.nonInferable
    get nonInferableReport() {
      return this.report.nonInferable;
    },
  };
}

module.exports = {
  VERDICT,
  GATE_REASON,
  caught,
  judge,
  scoreCritic,
  evalGate,
};
