'use strict';

// ship.md's track_shipping step pushes the ship-note onto the PR branch (#2138): the STATE ship-note commit (phase N
// shipped, PR #N) was made after create_pr and never pushed, so it was lost when the PR merged. The commit carries a
// `[ci skip]` trailer so the push does not trigger a redundant pipeline, the step handles PRs wedged by the skip token
// or required status checks (#2783), still records the phase and PR number, and writes only the activity line, never
// a Status (#5165). Was tests/ship-note.test.cjs.

module.exports = {
  id: 'ship-note',
  issue: '#2138',
  check(ctx) {
    ctx.doc('gsd-core/workflows/ship.md')
      .step('track_shipping')
      .has(/git push origin \$\{CURRENT_BRANCH\}/, 'track_shipping must push the ship-note commit onto the PR branch so it survives merge (#2138)')
      .has(/\[ci skip\]|\[skip ci\]/, 'the ship-note commit must carry a [ci skip] trailer')
      .has(/mergeStateStatus|BLOCKED|trigger CI/, 'track_shipping must include self-healing or check handling for wedged PRs (#2783)')
      .has(/ship phase \$\{PHASE_NUMBER\}[^\n]{0,500}PR #\$\{PR_NUMBER\}/, 'track_shipping must still commit the phase + PR-number ship-note into STATE')
      .has(/state\.update \$\{GSD_WS:\+--ws=\$\{GSD_WS##\* \}\} "Last Activity" "\$\(date \+%Y-%m-%d\) -- Phase \$\{PHASE_NUMBER\} shipped as PR #\$\{PR_NUMBER\}"/, 'the activity line must carry the phase + PR description (#5165)')
      .lacks(/state\.update "Status"/, 'track_shipping must write the activity line only, no Status (#5165)');
  },
};
