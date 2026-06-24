'use strict';
/** 4-mode eval: baseline / disconfirmation / exogenous / abstention per model:
 *  REAL blind recordings (sonnet + haiku, 2026-06-23), judged blind on a constant
 *  model, only the mode prompt varies.
 *  disconfirmation + abstention are the two endogenous arms:
 *    disconfirmation — "re-examine your initial PASS; look for contradictions"
 *    abstention      — "don't PASS unless confident; FLAG/abstain on what you can't confirm"
 *  flagEverything: SYNTHETIC adversarial mode (BLOCKs everything) for the gate
 *  anti-gaming test. */
const recorded = require('./recorded-transcripts.json'); // { sonnet:{mode:{id:str}}, haiku:{...} }
const corpus = require('./corpus.cjs');
const flagEverything = {};
for (const it of corpus) flagEverything[it.id] = 'Analysis omitted.\nVERDICT: BLOCK\nconfidence: high';
module.exports = {
  recorded,
  flagEverything,
  MODELS: ['sonnet', 'haiku'],
  MODES: ['baseline', 'disconfirmation', 'exogenous', 'abstention'],
};
