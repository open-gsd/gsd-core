'use strict';

// ship.md's track_shipping step pushes the ship-note onto the PR branch (#2138): the STATE ship-note commit (phase N
// shipped, PR #N) was made after create_pr and never pushed, so it was lost when the PR merged. The commit carries no
// CI skip token (#6173): a squash or rebase merge carries the token onto the default branch, where the merge push then
// starts no workflow runs, so the #2783 wedge-recovery commit and its merge-state polling are gone with it. The step
// still records the phase and PR number, and writes only the activity line, never a Status (#5165). Was
// tests/ship-note.test.cjs.

module.exports = {
  id: 'ship-note',
  issue: '#2138',
  check(ctx) {
    ctx.doc('gsd-core/workflows/ship.md')
      .step('track_shipping')
      .has(/git push origin \$\{CURRENT_BRANCH\}/, 'track_shipping must push the ship-note commit onto the PR branch so it survives merge (#2138)')
      .lacks(/\[(?:ci skip|skip ci|no ci|skip actions|actions skip)\]|skip-checks: ?true/i, 'the ship-note commit must carry no CI skip token (#6173)')
      .lacks(/mergeStateStatus|--allow-empty/, 'track_shipping must not poll the PR merge state or push an empty recovery commit (#6173)')
      .has(/ship phase \$\{PHASE_NUMBER\}[^\n]{0,500}PR #\$\{PR_NUMBER\}/, 'track_shipping must still commit the phase + PR-number ship-note into STATE')
      .has(/state\.update \$\{GSD_WS:\+--ws=\$\{GSD_WS##\* \}\} "Last Activity" "\$\(date \+%Y-%m-%d\) -- Phase \$\{PHASE_NUMBER\} shipped as PR #\$\{PR_NUMBER\}"/, 'the activity line must carry the phase + PR description (#5165)')
      .lacks(/state\.update "Status"/, 'track_shipping must write the activity line only, no Status (#5165)');
  },
};
