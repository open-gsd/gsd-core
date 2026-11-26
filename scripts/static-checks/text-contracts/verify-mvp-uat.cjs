'use strict';

// verify-work's MVP-mode UAT framing: the workflow declares MVP_MODE, resolves it through the phase.mvp-mode verb,
// references verify-mvp-mode.md, runs user-flow steps first, defers technical checks and falls back to the standard
// UAT generation path when the mode is not MVP (verify-work.md is fragmented, #2994, so the host and every step file
// directly under verify-work/steps are read together). Folded bug #2504: the verifier phase-gates reference scopes
// identify_human_verification to infrastructure/foundation phases (auto-pass, N/A, no invented manual steps). Where
// the test accepted a disjunction the file satisfies by coincidence (`absent` anywhere for the standard-UAT fallback;
// `infrastructure` anywhere for the scoping; `only add human` for the prohibition) the contract asks for the phrase
// the file carries; an unterminated section is a finding. Was tests/verify-mvp-uat.test.cjs.

const HOST = 'gsd-core/workflows/verify-work.md';
const STEPS_DIR = 'gsd-core/workflows/verify-work/steps';
const GATES = 'gsd-core/references/verifier-phase-gates.md';

module.exports = {
  id: 'verify-mvp-uat',
  check(ctx) {
    // The step files directly under the directory (the test read it without descending), in sorted order.
    const steps = ctx.list(STEPS_DIR, '.md', 'the verify-work step files hold the MVP framing').filter((rel) => rel.split('/').length === STEPS_DIR.split('/').length + 1);
    ctx.docs([HOST, ...steps])
      .has(/MVP_MODE/, 'the workflow must declare MVP_MODE')
      .has(/phase\.mvp-mode/i, 'the workflow must resolve MVP mode via the centralized phase.mvp-mode verb (no inline roadmap+config bash)')
      .has(/verify-mvp-mode\.md/, 'the workflow must reference the UAT framing file verify-mvp-mode.md')
      .has(/user[\s-]?flow[^\n]{0,80}(first|before|precede)/i, 'the workflow must specify user-flow-first ordering')
      .has(/technical[\s-]?checks[^\n]{0,80}(after|defer|second)/i, 'the workflow must defer technical checks under MVP mode')
      .has('fall back to the standard UAT generation path', 'the workflow must specify the standard UAT fallback when the mode is not mvp');

    ctx.doc(GATES)
      .slice('identify_human_verification', '\n## ')
      .has('infrastructure/foundation phase', 'the identify_human_verification step must explicitly handle infrastructure/foundation phases that have no user-facing elements (root cause of #2504)')
      .has('auto-pass UAT', 'the identify_human_verification step must contain language about auto-passing UAT for phases without user-facing elements (root cause of #2504)')
      .has('Do NOT invent artificial manual steps', 'the identify_human_verification step must explicitly prohibit inventing artificial manual UAT steps for infrastructure phases (root cause of #2504)')
      .has('Mark human verification as **N/A**', 'the identify_human_verification step must include a not-applicable UAT state for phases with no user-facing elements (root cause of #2504)');
  },
};
