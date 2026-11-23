'use strict';

// The few-shot calibration examples for the plan-checker and the verifier: both reference files exist, carry
// frontmatter metadata (component, a numeric version, a calibration date), hold the exact example counts (4 for the
// plan-checker, 7 for the verifier) with the Positive section before the Negative one, give every example a
// "Why this is good/bad" annotation and an Input and Output block, and the agents reference them. The verifier also
// carries the calibration-derived gap patterns table. The metadata fields are read inside the frontmatter, where the
// test searched the whole file. Was tests/few-shot-calibration.test.cjs.

const REFS = 'gsd-core/references/few-shot-examples';

const countOf = (text, pattern) => (text.match(pattern) || []).length;
const EXAMPLE = /^### Example \d{1,9}/gm;
const WHY = /^\*\*Why this is (good|bad):\*\*/gm;
const INPUT = /^\*\*Input:\*\*/gm;
const OUTPUT = /^\*\*Output:\*\*/gm;

// A reference file holding `examples` examples, each annotated and (for at least `examples`) with an Input and Output block.
function checkReference(ctx, name, componentPattern, examples) {
  const rel = `${REFS}/${name}.md`;
  ctx.exists(rel, `${name}.md must exist in references/few-shot-examples/`);
  const doc = ctx.doc(rel);
  doc.frontmatter()
    .has(componentPattern, `${name}.md frontmatter must name its component`)
    .has(/^version:[ \t]{0,20}\d{1,9}[ \t]{0,20}$/m, `${name}.md frontmatter must carry a numeric version`)
    .has(/^last_calibrated:[ \t]{0,20}\d{4}-\d{2}-\d{2}[ \t]{0,20}$/m, `${name}.md frontmatter must carry a last_calibrated date`);
  doc
    .satisfies((text) => {
      const total = countOf(text, EXAMPLE);
      return total === examples || `found ${total}`;
    }, `${name}.md must contain exactly ${examples} examples`)
    .satisfies((text) => {
      const positive = text.indexOf('## Positive Examples');
      const negative = text.indexOf('## Negative Examples');
      if (positive < 0) return 'no Positive Examples section';
      if (negative < 0) return 'no Negative Examples section';
      return positive < negative || 'the Negative section comes before the Positive one';
    }, `${name}.md must have a Positive Examples section before a Negative Examples section`)
    .satisfies((text) => {
      const why = countOf(text, WHY);
      const total = countOf(text, EXAMPLE);
      return why === total || `expected ${total} WHY annotations, found ${why}`;
    }, `every ${name} example must have a WHY annotation`)
    .satisfies((text) => {
      const inputs = countOf(text, INPUT);
      return inputs >= examples || `expected at least ${examples} Input blocks, found ${inputs}`;
    }, `${name} examples must include Input blocks`)
    .satisfies((text) => {
      const outputs = countOf(text, OUTPUT);
      return outputs >= examples || `expected at least ${examples} Output blocks, found ${outputs}`;
    }, `${name} examples must include Output blocks`);
  return doc;
}

module.exports = {
  id: 'few-shot-calibration',
  check(ctx) {
    checkReference(ctx, 'plan-checker', /^component:[ \t]{0,20}plan-checker[ \t]{0,20}$/m, 4);
    checkReference(ctx, 'verifier', /^component:[ \t]{0,20}verifier[ \t]{0,20}$/m, 7)
      .has('## Calibration-Derived Gap Patterns', 'verifier.md must include the calibration-derived gap patterns table')
      .has('Missing wiring', 'the gap patterns table must name Missing wiring')
      .has('Missing tests', 'the gap patterns table must name Missing tests');

    ctx.doc('agents/gsd-plan-checker.md')
      .has('@~/.claude/gsd-core/references/few-shot-examples/plan-checker.md', 'gsd-plan-checker.md must reference the plan-checker few-shot examples');
    ctx.doc('agents/gsd-verifier.md')
      .has('@~/.claude/gsd-core/references/few-shot-examples/verifier.md', 'gsd-verifier.md must reference the verifier few-shot examples');
  },
};
