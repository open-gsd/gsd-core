'use strict';

// gsd-ui-checker carries an adversarial stance with FORCE and the BLOCK/FLAG tiers, a third-person named-persona
// block (#16, arXiv 2505.23840) with objective framing (2506.04975), and an anti-capitulation rule. Was
// tests/ui-checker-adversarial-stance.test.cjs.

module.exports = {
  id: 'ui-checker-adversarial-stance',
  issue: '#16',
  check(ctx) {
    ctx.doc('agents/gsd-ui-checker.md')
      .has(/<adversarial_stance>/, 'missing <adversarial_stance>')
      .has(/FORCE stance/, 'missing FORCE stance line')
      .has(/go soft/i, 'missing go-soft failure list')
      .has(/BLOCK\b/, 'missing BLOCK tier')
      .has(/FLAG\b/, 'missing FLAG tier')
      .has(/The Auditor/i, 'missing named third-person reviewer "The Auditor"')
      .has(/The Auditor['’]s verdict/i, "missing third-person verdict phrasing \"The Auditor's verdict\"")
      .has(/independent/i, 'missing independent/objective framing')
      .has(/not\s{1,20}a\s{1,20}standalone\s{1,20}accuracy\s{1,20}guarantee/i, 'missing limitation on persona efficacy claim')
      .has(/anti.?capitulat/i, 'missing anti-capitulation rule')
      .has(/concrete fix/i, 'missing "concrete fix" requirement for BLOCK downgrade')
      .has(/Self-correction is allowed/i, 'missing carve-out for evidence-backed self-correction')
      .has(/prior dimension application was mistaken/i, 'missing mistaken-prior-application carve-out');
  },
};
