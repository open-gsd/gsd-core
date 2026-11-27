'use strict';

// Inversion guard for gated workflow sections (#2994, epic #1671 Phase 6.3): text needed exactly when a gate is
// closed must stay physically outside the gated `<!-- gsd:section -->` pair. discuss-phase-assumptions.md gates
// only auto-advance-dispatch (when state:auto-advance-active): the flag-absent fallback ("End here ...") and the
// resolvers (--auto parse, config-set, AUTO_MODE read) stay in the host file, once, in the always-composed gap
// text. verify-work.md's MVP false-branch note stays outside mvp-uat-framing (when state:phase-mvp-mode). The
// sections come from the real parseWorkflowSections (never a second marker scan). Was
// tests/section-marker-inversion-guard.test.cjs. A parse that throws is a finding for the file.

const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'workflow-fragments.cjs');

const FALLBACK_TEXT = 'End here — `confirm_creation` already ran; do not route back to it.';
const RESOLVER_MARKERS = [
  'Parse `--auto` flag from $ARGUMENTS',
  'gsd_run query config-set workflow._auto_chain_active',
  'AUTO_MODE=$(gsd_run query check auto-mode --pick active',
];
const FALSE_BRANCH_NOTE = 'When `MVP_MODE=false` (mode is null, absent, or the phase has no `**Mode:**` line in ROADMAP.md), fall back to the standard UAT generation path — no behavioral change.';

// The parsed sections of a workflow file, or the reason there are none.
function sectionsOf(text, rel) {
  try {
    return { sections: require(LIB).parseWorkflowSections(text, rel) };
  } catch (err) {
    return { error: `the sections of the workflow cannot be parsed: ${err.message}` };
  }
}

// The gated section by id: exactly one must exist.
function gatedOf(parsed, id) {
  const matches = parsed.sections.filter((section) => section.id === id);
  return matches.length === 1 ? { gated: matches[0] } : { error: `expected exactly one parsed section with id "${id}", found ${matches.length}` };
}

// Everything outside any explicit marker: the always-composed gap text.
const outsideGatedText = (parsed) => parsed.sections.filter((section) => !section.explicit).map((section) => section.body).join('');

// Runs `check(parsed, gated, text)` on the file's sections; a parse failure or a missing gated section is the finding.
const onGated = (rel, id, check) => (text) => {
  const parsed = sectionsOf(text, rel);
  if (parsed.error) return parsed.error;
  const found = gatedOf(parsed, id);
  return found.error || check(parsed, found.gated, text);
};

module.exports = {
  id: 'section-marker-inversion-guard',
  issue: '#2994',
  check(ctx) {
    const assumptions = 'gsd-core/workflows/discuss-phase-assumptions.md';
    const GATED = 'auto-advance-dispatch';
    ctx.doc(assumptions)
      .satisfies(onGated(assumptions, GATED, (parsed, gated) => gated.when === 'state:auto-advance-active' || `when is "${gated.when}"`), `the gated section must exist and be when="state:auto-advance-active"`)
      .has(FALLBACK_TEXT, 'the flag-absent "End here" fallback must exist verbatim in the host file')
      .satisfies(onGated(assumptions, GATED, (parsed, gated) => !gated.body.includes(FALLBACK_TEXT) || 'the fallback is inside the gated body'), 'the flag-absent fallback must live OUTSIDE the gated marker: gating it away would delete the text needed exactly when --auto is absent')
      .satisfies(onGated(assumptions, GATED, (parsed) => outsideGatedText(parsed).includes(FALLBACK_TEXT) || 'the fallback is not in any gap section'), 'the flag-absent fallback must be part of an always-composed gap section, not lost between gaps')
      .satisfies(onGated(assumptions, GATED, (parsed, gated) => {
        const inside = RESOLVER_MARKERS.find((marker) => gated.body.includes(marker));
        if (inside) return `"${inside}" is inside the gated body`;
        const gap = outsideGatedText(parsed);
        const missing = RESOLVER_MARKERS.find((marker) => !gap.includes(marker));
        return missing ? `"${missing}" is not in the gap text` : true;
      }), 'every resolver line (--auto parse, config-set, AUTO_MODE read) must lie OUTSIDE the gated marker and be present in the unconditionally-composed text')
      .satisfies((text) => {
        const occurrences = text.split(FALLBACK_TEXT).length - 1;
        return occurrences === 1 || `${occurrences} occurrences`;
      }, 'the fallback text must appear exactly once in the host file');

    const verifyWork = 'gsd-core/workflows/verify-work.md';
    const MVP = 'mvp-uat-framing';
    ctx.doc(verifyWork)
      .satisfies(onGated(verifyWork, MVP, (parsed, gated) => gated.when === 'state:phase-mvp-mode' || `when is "${gated.when}"`), 'the gated section must exist and be when="state:phase-mvp-mode"')
      .has(FALSE_BRANCH_NOTE, 'the MVP=false fallback note must be present in the host file')
      .satisfies(onGated(verifyWork, MVP, (parsed, gated) => !gated.body.includes(FALSE_BRANCH_NOTE) || 'the note is inside the gated body'), 'gating mvp-uat-framing away (MVP_MODE=false) must not delete the note that documents exactly that fallback')
      .satisfies(onGated(verifyWork, MVP, (parsed) => outsideGatedText(parsed).includes(FALSE_BRANCH_NOTE) || 'the note is not in any gap section'), 'the MVP=false fallback note must be present in the unconditionally-composed gap text');
  },
};
