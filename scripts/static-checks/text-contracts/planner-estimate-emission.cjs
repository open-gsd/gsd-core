'use strict';

// Planner estimate emission and the over-budget flag (#2631, ADR-2629): the planner's PLAN.md template carries an
// `estimate:` block (tokens, tasks, confidence) and a field-table row, with confidence derived from the sample count;
// gsd-plan-checker reads the configured smart-zone budget, runs the estimate-check verb, recommends splitting as a
// warning never a blocker, and consults the estimate in Dimension 5; plan-md.md documents `estimate` as optional;
// CONFIGURATION.md states the shipped smart_zone_tokens default. Was tests/planner-estimate-emission.test.cjs.
// The template is found with the repo's one fence owner (locateFrontmatterFence), not the test's lazy regex: a closing
// fence is `---` plus optional trailing spaces or tabs, or a `----` line when no exact closer follows; a lone CR or
// U+2028 neither opens nor closes a block; an opener is exactly `---` before LF or CRLF, as the regex's was. Cases pin
// these (ADR-5057). The `m`-flag patterns on the body still treat U+2028 and U+2029 as line starts, as the test's did.
// Confidence values come from the template's `# low | med | high` comment (the test took any low/med/high word, so
// it could never see a value the parser rejects). The test accepted `calibration factor`, `derived` and `split` or
// `never a blocker` alone; the files carry `estimate-calibration`, `sample count`, `re-slic` and
// `WARNING, never a blocker`, which are asked for.

const path = require('node:path');

const ESTIMATION_LIB = path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'phase-estimation.cjs');
const DIMENSION_WINDOW = 2500;
const ESTIMATE_ROW = /\|\s{0,20}`estimate`\s{0,20}\|/;
const ESTIMATE_FIELDS = [
  ['tokens', /^\s{1,20}tokens:/m],
  ['tasks', /^\s{1,20}tasks:/m],
  ['confidence', /^\s{1,20}confidence:/m],
];

// The fence rules (opening fence, whole-line closing fence) have one owner; this reads the planner's fenced
// blocks (the PLAN.md template examples) through it, one block at a time.
const FENCE_LIB = path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'frontmatter-fence.cjs');

// The first fenced block of the planner that declares both phase: and must_haves:, or null.
function plannerFrontmatterTemplate(text) {
  const { locateFrontmatterFence } = require(FENCE_LIB);
  let offset = 0;
  while (offset <= text.length) {
    const eol = text.indexOf('\n', offset);
    const line = text.slice(offset, eol === -1 ? text.length : eol);
    // Only a line of three characters before its trailing blanks, starting with a hyphen, is offered to the fence
    // owner (which decides whether one opens here): this keeps the walk linear without a bound on the blanks.
    if (line.startsWith('-') && line.trimEnd().length === 3) {
      const rest = text.slice(offset);
      const fence = locateFrontmatterFence(rest);
      if (fence) {
        if (!fence.closed) return null;
        const body = rest.slice(fence.openEnd, fence.bodyEnd);
        if (/^phase:/m.test(body) && /^must_haves:/m.test(body)) return body;
        offset += fence.closingFenceEnd;
        continue;
      }
    }
    if (eol === -1) break;
    offset = eol + 1;
  }
  return null;
}

const onTemplate = (check) => (text) => {
  const template = plannerFrontmatterTemplate(text);
  return template === null ? 'the PLAN.md frontmatter template is not in the planner' : check(template);
};

module.exports = {
  id: 'planner-estimate-emission',
  issue: '#2631',
  check(ctx) {
    ctx.doc('agents/gsd-planner.md')
      .satisfies(onTemplate((template) => /^estimate:/m.test(template) || 'no estimate: line'), 'the template must declare an `estimate:` block')
      .satisfies(onTemplate((template) => {
        const missing = ESTIMATE_FIELDS.filter(([, pattern]) => !pattern.test(template)).map(([field]) => field);
        return missing.length === 0 || `missing ${missing.join(', ')}`;
      }), 'the estimate block must carry tokens, tasks and confidence')
      .has(ESTIMATE_ROW, 'the field reference table must have an `estimate` row')
      .has(/estimate-calibration/, 'the planner must consume the calibration surface (estimate-calibration)')
      .has(/sample count/, 'the planner must be told confidence is derived from the sample count, not self-rated')
      .satisfies(onTemplate((template) => {
        const line = template.split('\n').find((candidate) => /^\s{1,20}confidence:/.test(candidate));
        if (!line) return 'the template must show the confidence field';
        const comment = line.split('#')[1];
        const words = comment === undefined ? [] : comment.split('\u2014')[0].split('|').map((word) => word.trim()).filter((word) => word.length > 0);
        if (words.length === 0) return 'the confidence line must enumerate the allowed values';
        const { CONFIDENCE_VALUES } = require(ESTIMATION_LIB);
        const rejected = words.filter((word) => !CONFIDENCE_VALUES.includes(word));
        return rejected.length === 0 || `the planner offers ${rejected.join(', ')} but CONFIDENCE_VALUES does not accept it`;
      }), 'every confidence value the planner may emit must be accepted by the parser');

    ctx.doc('agents/gsd-plan-checker.md')
      .has(/workflow\.smart_zone_tokens/, 'the checker must read the configured budget, not hardcode one')
      .has(/estimate-check/, 'the flag must be computed by the estimate-check verb, not re-derived in prose')
      .has(/re-slic/, 'an over-budget plan must recommend splitting (re-slice)')
      .has(/WARNING, never a blocker/, 'the over-budget flag is advisory: WARNING, never a blocker')
      .satisfies((text) => {
        const at = text.indexOf('Dimension 5');
        if (at === -1) return 'no Dimension 5 section';
        return /estimate/i.test(text.slice(at, at + DIMENSION_WINDOW)) || `no estimate within ${DIMENSION_WINDOW} characters of Dimension 5`;
      }, 'Dimension 5 (Scope Sanity) must consult the emitted estimate');

    ctx.doc('docs/reference/plan-md.md')
      .has(ESTIMATE_ROW, 'plan-md.md must document `estimate`')
      .satisfies((text) => {
        const row = text.split('\n').find((line) => ESTIMATE_ROW.test(line));
        if (!row) return 'estimate row not found';
        return /\bNo\b/.test(row) || 'the row does not say No';
      }, 'estimate must be documented as NOT required (additive and optional)');

    let shipped = null;
    ctx.doc('gsd-core/bin/shared/config-defaults.manifest.json').satisfies((text) => {
      let manifest;
      try {
        manifest = JSON.parse(text);
      } catch (err) {
        return `the manifest is not valid JSON: ${err.message}`;
      }
      const value = manifest && manifest.workflow ? manifest.workflow.smart_zone_tokens : undefined;
      if (!(Number.isSafeInteger(value) && value > 0)) return `workflow.smart_zone_tokens is ${JSON.stringify(value)}`;
      shipped = value;
      return true;
    }, 'the manifest must ship a usable smart_zone_tokens default');
    ctx.doc('docs/CONFIGURATION.md').satisfies((text) => {
      if (shipped === null) return 'the shipped default is unknown';
      const row = text.split('\n').find((line) => line.includes('workflow.smart_zone_tokens'));
      if (!row) return 'CONFIGURATION.md does not document the key';
      return row.includes(String(shipped)) || `the row does not carry the shipped ${shipped}`;
    }, 'the documented smart_zone_tokens default must be the shipped one');
  },
};
