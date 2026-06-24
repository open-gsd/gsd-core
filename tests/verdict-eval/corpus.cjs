'use strict';
/**
 * tests/verdict-eval/corpus.cjs
 *
 * Labeled corpus for the B1 critic self-disconfirmation eval.
 * Source: corpus-items.json (43 vetted items).
 *
 * Realistic blind-safe artifacts: claim/code do NOT reveal the defect via comments
 * or obvious variable names. class/groundTruth/injectedDefect are ground truth
 * NEVER shown to the critic.
 *
 * Classes:
 *   inferable        (12) — claim↔code contradiction visible in the artifact alone
 *   domain-knowledge (10) — defect requires domain expertise beyond the visible artifact
 *   spec-silent      (14) — defect is on a boundary the spec never pinned down
 *   clean             (7) — groundTruth PASS; used to measure over-blocking
 */

module.exports = require('./corpus-items.json').map((i) => ({
  id: i.id,
  class: i.class,
  groundTruth: i.groundTruth,
  artifact: { claim: i.claim, code: i.code },
  injectedDefect: i.injectedDefect || null,
  blindSpotHint: i.blindSpotHint || null,
}));
