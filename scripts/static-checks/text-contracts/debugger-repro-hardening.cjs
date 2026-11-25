'use strict';

// Regression-test hardening for the debugger: shrinking, an explicit oracle and boundary neighbors (#1962, epic #1957
// Phase 3A). The reference extract exists and gsd-debugger @-includes it; it documents property-based shrinking
// with a degradation path, names the four oracle types and flags implicit (crash) as the weakest, documents boundary
// neighbors tied to the fixed defect's equivalence class, and notes the Phase 1A mutation integration; the DEBUG.md
// template records the oracle type. The test also accepted the generic words `seed`, `boundary`, `adjacent`,
// `fixed defect` and `mutation` alone; each assertion below asks for the phrase the reference carries. Was
// tests/debugger-repro-hardening.test.cjs.

const REFERENCE = 'gsd-core/references/debugger-repro-hardening.md';

module.exports = {
  id: 'debugger-repro-hardening',
  issue: '#1962',
  check(ctx) {
    ctx.exists(REFERENCE, 'the debugger-repro-hardening.md reference must exist');
    ctx.doc('agents/gsd-debugger.md')
      .has('@~/.claude/gsd-core/references/debugger-repro-hardening.md', 'gsd-debugger.md must @-include the repro-hardening reference (from Minimal Reproduction or Test-First Debugging)');

    ctx.doc(REFERENCE)
      .has(/shrink/i, 'the reference must document shrinking')
      .has(/fast-check/i, 'the reference must name fast-check (the JS/TS shrinker)')
      .has(/hypothesis/i, 'the reference must name Hypothesis (the Python shrinker)')
      .has(/minimi[sz]/i, 'the reference must reference minimization')
      .has(/regression seed|store[^\n]{0,500}minimi|minimi[^\n]{0,500}store/i, 'the reference must state the minimized counterexample is stored as the regression seed')
      .has(/no PBT framework/i, 'the reference must document degradation when no PBT framework is present')
      .has(/manual minimi/i, 'the degradation must fall back to manual minimization (not silently skip)')
      .has(/specified/i, 'the oracle type "specified" must be named')
      .has(/derived/i, 'the oracle type "derived" (contract/model) must be named')
      .has(/metamorphic/i, 'the oracle type "metamorphic" must be named')
      .has(/implicit/i, 'the oracle type "implicit" (crash) must be named')
      .has(/implicit[^\n]{0,500}(?:crash|weakest|weaker)|(?:crash|weakest|weaker)[^\n]{0,500}implicit/i, 'the reference must flag implicit/crash as the weakest oracle (force justification, never default silently)')
      .has(/off-by-one|off by one|n\s{0,20}[+-]\s{0,20}1/i, 'the boundary category off-by-one (N+-1) must be documented')
      .has(/min\/max|empty\/singleton/i, 'the boundary category min/max or empty/singleton must be documented')
      .has(/equivalence class/i, "boundary neighbors must be tied to the fixed defect's equivalence class (not generic edge cases)")
      .has(/root[\s-]?cause check/i, 'the reference must note that a minimized seed and a real oracle make the regression test a root-cause check (what Phase 1A needs to bite)');

    ctx.doc('gsd-core/templates/DEBUG.md')
      .has(/oracle_type/, 'the DEBUG.md Resolution must carry an oracle_type field');
  },
};
