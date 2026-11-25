'use strict';

// The component-inventory gate of gsd-ui-researcher checks itself (#4929), in the full and the compact agent: the
// first tool answer is always cross-checked against a filesystem count, a zero or mismatched count is recorded,
// version resolution falls back to the lockfile when node_modules is absent, empty output / a non-zero exit /
// `undefined` are failures, a caret range is not a resolved version, and the provenance line the checker's Dimension 7
// parses did not move. Where the test accepted any of several words, the real gate carries one phrase and the
// contract asks for it (`always`, `No components installed`, `packages['node_modules/<pkg>']`, `empty output`,
// `non-zero exit`) and for both lockfile names. Was tests/ui-researcher-inventory-self-check.test.cjs.

const PROVENANCE_LINE = 'Enumerated by `<command>` — <N> components — <package>@<version> — <YYYY-MM-DD>.';

module.exports = {
  id: 'ui-researcher-inventory-self-check',
  issue: '#4929',
  check(ctx) {
    for (const [variant, rel] of [['full', 'agents/gsd-ui-researcher.md'], ['compact', 'agents/gsd-ui-researcher.compact.md']]) {
      ctx.doc(rel)
        .slice('<component_inventory_gate>', '</component_inventory_gate>')
        .has(/cross-check/i, `${variant}: the first tool answer must be cross-checked`)
        .has(/\bls\b|filesystem/i, `${variant}: the cross-check must be a filesystem count`)
        .has(/always/i, `${variant}: the cross-check must be unconditional`)
        .has(/mismatch|disagree/i, `${variant}: a mismatched first-tier count must be recorded, not silently resolved`)
        .has(/No components installed/i, `${variant}: a zero first-tier count must be recorded, not silently resolved`)
        .has(/package-lock\.json/, `${variant}: version resolution must fall back to package-lock.json`)
        .has("packages['node_modules/<pkg>']", `${variant}: the lockfile lookup must show the packages entry`)
        .has(/pnpm-lock\.yaml/, `${variant}: version resolution must name pnpm-lock.yaml`)
        .has(/yarn\.lock/, `${variant}: version resolution must name yarn.lock`)
        .has(/empty output/i, `${variant}: empty output must be a failure, never a pass-through`)
        .has(/non-zero exit/i, `${variant}: a non-zero exit must be a failure, never a pass-through`)
        .has(/undefined/, `${variant}: "undefined" must be a failure, never a pass-through`)
        .has(/caret range/i, `${variant}: a caret range is still not a resolved version`)
        .has(PROVENANCE_LINE, `${variant}: the recorded-line grammar moved`)
        .has(/Could not enumerate: <reason>\./, `${variant}: the could-not-enumerate line must stay`);
    }
    ctx.doc('agents/gsd-ui-checker.md')
      .has(PROVENANCE_LINE, 'Dimension 7 of the checker must quote the same provenance grammar');
  },
};
