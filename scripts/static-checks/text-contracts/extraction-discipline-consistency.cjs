'use strict';

// The two extraction agents (gsd-doc-classifier, gsd-doc-synthesizer) instruct rule-application, not generation
// (#8): an <extraction_discipline> block, "mark absent" no-fabrication guidance, no anti-JSON-reasoning overclaim,
// at least two few-shot Input -> Output exemplars, and a terminal schema restatement before the write step. Was
// tests/extraction-discipline-consistency.test.cjs.

const EXTRACTORS = ['gsd-doc-classifier', 'gsd-doc-synthesizer'];

module.exports = {
  id: 'extraction-discipline-consistency',
  issue: '#8',
  check(ctx) {
    for (const name of EXTRACTORS) {
      ctx.doc(`agents/${name}.md`)
        .has(/<extraction_discipline>/, `${name} missing <extraction_discipline>`)
        .has(/rule-application, not generation/i, `${name} missing rule-application framing`)
        .has(/do not (infer|embellish)/i, `${name} missing no-infer/embellish rule`)
        .has(/mark.{0,30}absent/i, `${name} missing "mark absent" no-fabrication guidance`)
        .lacks(/do not reason your way/i, `${name} still contains the anti-JSON-reasoning overclaim`)
        .lacks(/extended deliberation.{0,30}breaks/i, `${name} still contains the anti-reasoning overclaim`)
        .satisfies((text) => {
          const hasInputOutput = /Input:/i.test(text) && /Output:/i.test(text);
          const hasArrow = /Input\s{0,20}→/.test(text) || /Input\s{0,20}->/.test(text);
          return hasInputOutput || hasArrow;
        }, `${name} missing few-shot Input->Output exemplars`)
        .satisfies((text) => {
          const inputMatches = (text.match(/\bInput:/gi) || []).length;
          const arrowMatches = (text.match(/\bInput\s{0,20}[→-]/g) || []).length;
          const exemplars = inputMatches || arrowMatches;
          return exemplars >= 2 || `found ${exemplars}`;
        }, `${name} needs at least 2 exemplars (clean + UNKNOWN/ambiguous)`)
        .has(/terminal.{0,60}schema|schema.{0,60}restatement|output.{0,40}contract.{0,40}reminder|final.{0,40}output.{0,40}schema/i, `${name} missing terminal schema restatement before the write step`);
    }
  },
};
