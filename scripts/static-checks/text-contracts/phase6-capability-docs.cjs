'use strict';

// ADR-857 phase 6: the Capability developer manual exists, the docs index links it, it uses the ADR-857
// terminology (plugin is packaging only), documents the GSD 1.5 development loop and the plan:pre hook
// fragments, and names the phase 6 planning capability cutovers. Was tests/phase6-capability-docs.test.cjs.

module.exports = {
  id: 'phase6-capability-docs',
  issue: 'ADR-857',
  check(ctx) {
    ctx.doc('docs/README.md')
      .has(/how-to\/develop-a-capability\.md/, 'docs index links the Capability developer manual');

    // A missing manual is one finding (ctx.doc reports it), covering the original existence test.
    ctx.doc('docs/how-to/develop-a-capability.md')
      .has(/Capability/, 'manual uses ADR-857 terminology')
      .has(/ADR-857/, 'manual cites ADR-857')
      .has(/plugin is a packaging or host-runtime term/i, 'manual names plugin as packaging only')
      .has(/GSD 1\.5/, 'manual documents the GSD 1.5 capability development loop')
      .has('capabilities/<id>/capability.json', 'manual documents the capability.json location')
      .has('node scripts/gen-capability-registry.cjs --write', 'manual documents the registry --write step')
      .has('node scripts/gen-capability-registry.cjs --check', 'manual documents the registry --check step')
      .has('plan:pre', 'manual documents plan:pre hook fragments')
      .has('fragment.path', 'manual documents fragment.path')
      .has('fragment.inline', 'manual documents fragment.inline')
      .has('gsd-tools loop render-hooks plan:pre', 'manual documents render-hooks verification')
      .has('research', 'manual documents the research planning capability cutover')
      .has('ai-integration', 'manual documents the ai-integration planning capability cutover')
      .has('pattern-mapper', 'manual documents the pattern-mapper planning capability cutover');
  },
};
