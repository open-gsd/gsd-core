'use strict';

// The methodology artifact type (#1488): artifact-types.md documents it (shape, lifecycle, location, consumption),
// discuss-phase-assumptions.md reads METHODOLOGY.md when it exists and applies its lenses, and pause-work.md lists
// it in the Required Reading template. Where the test accepted any of several words (`active`, `exists`, `lenses`,
// `2>/dev/null`) the contract asks for the phrase the real files carry. Was tests/methodology-artifact.test.cjs.

module.exports = {
  id: 'methodology-artifact',
  issue: '#1488',
  check(ctx) {
    ctx.exists('gsd-core/references/artifact-types.md', 'gsd-core/references/artifact-types.md must exist');
    ctx.doc('gsd-core/references/artifact-types.md')
      .has(/[Mm]ethodology/, 'artifact-types.md must document the methodology artifact type')
      .has(/[Ss]tanding reference|reusable interpretive|interpretive framework/, 'the methodology artifact must have its shape documented as a standing reference / interpretive framework')
      .has('Created → Active → Superseded', 'the methodology artifact lifecycle must read Created → Active → Superseded')
      .has('METHODOLOGY.md', 'artifact-types.md must document .planning/METHODOLOGY.md as the location')
      .has(/consumed by|consumption/i, 'the methodology artifact must document its consumption mechanism');

    ctx.exists('gsd-core/workflows/discuss-phase-assumptions.md', 'discuss-phase-assumptions.md must exist');
    ctx.doc('gsd-core/workflows/discuss-phase-assumptions.md')
      .has('METHODOLOGY.md', 'discuss-phase-assumptions.md must reference METHODOLOGY.md as a consumable artifact')
      .has('cat .planning/METHODOLOGY.md', 'discuss-phase-assumptions.md must read METHODOLOGY.md')
      .has('If METHODOLOGY.md exists', 'discuss-phase-assumptions.md must apply METHODOLOGY.md only when it exists');

    ctx.exists('gsd-core/workflows/pause-work.md', 'pause-work.md must exist');
    ctx.doc('gsd-core/workflows/pause-work.md')
      .has('METHODOLOGY.md', 'the pause-work.md Required Reading template must include METHODOLOGY.md so new sessions inherit the methodology');
  },
};
