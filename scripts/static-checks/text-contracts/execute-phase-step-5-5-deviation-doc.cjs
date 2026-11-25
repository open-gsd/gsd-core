'use strict';

// execute-phase.md documents the cross-wave-dependency deviation cleanup (#3264) and keeps the human_needed branch honest
// (#3722): step 5.5 (the text from "5.5." up to "5.6.") names the standard wave contract and the cross-wave dependency
// deviation, carries the cleanup-tail commands (git worktree prune, remove --force, unlock, git branch -D), documents both
// skip conditions (empty WAVE_WORKTREE_PLANS, the custom-merge deviation with a pointer to the cleanup-tail), consumes the
// wave manifest line by line and does not rediscover global agent worktrees; the human_needed branch precedes gaps_found,
// offers no "approved" shortcut, never reaches update_roadmap directly, directs the user to verify-work and creates the
// {phase_num}-UAT.md file (never HUMAN-UAT.md). Was tests/execute-phase-step-5-5-deviation-doc.test.cjs (with the folded
// fix-3722 cases). The old `.*` between the worktree-list command and the agent path (dot-all) is one linear scan.

const WORKFLOW = 'gsd-core/workflows/execute-phase.md';
const WORKTREE_LIST = 'git worktree list --porcelain';
const AGENT_WORKTREES = '.claude/worktrees/agent-';

module.exports = {
  id: 'execute-phase-step-5-5-deviation-doc',
  issue: '#3264',
  check(ctx) {
    const workflow = ctx.doc(WORKFLOW);

    workflow.slice('\n5.5.', '\n5.6.')
      .has('Standard wave contract', 'step 5.5 must name the standard wave contract explicitly')
      .has('Cross-wave dependency deviation', 'step 5.5 must name the cross-wave dependency deviation as a supported mode')
      .has('git worktree prune', 'the step 5.5 cleanup-tail snippet must include git worktree prune')
      .satisfies((text) => text.includes('git worktree remove') && text.includes('--force'), 'the step 5.5 cleanup-tail snippet must include git worktree remove --force')
      .has('git worktree unlock', 'the step 5.5 cleanup-tail snippet must include git worktree unlock')
      .has('git branch -D', 'the step 5.5 cleanup-tail snippet must include git branch -D')
      .has('WAVE_WORKTREE_PLANS', 'step 5.5 must document the empty-WAVE_WORKTREE_PLANS skip condition')
      .has('cleanup-tail', 'step 5.5 must document the custom-merge-deviation skip condition with a pointer to the cleanup-tail')
      .has('WAVE_WORKTREE_MANIFEST', 'the cleanup-tail must consume the current wave manifest')
      .has('avoid touching unrelated active agents', 'the cleanup-tail must document why manifest-scoped cleanup is required')
      .satisfies((text) => {
        const list = text.indexOf(WORKTREE_LIST);
        return list === -1 || text.indexOf(AGENT_WORKTREES, list + WORKTREE_LIST.length) === -1;
      }, 'the cleanup-tail must not parse global git worktree list output for agent worktrees')
      .has('IFS= read -r', 'the cleanup-tail must still read manifest paths line by line to preserve paths with whitespace');

    workflow
      .has('human_needed', 'execute-phase.md must contain a human_needed branch')
      .lacks('"approved" → continue', 'the human_needed branch must not offer "approved" → continue: it marks the phase complete without verification (issue #38)')
      .satisfies((text) => {
        const humanNeeded = text.indexOf('**If human_needed:**');
        const gapsFound = text.indexOf('**If gaps_found:**');
        return humanNeeded === -1 || gapsFound === -1 || humanNeeded < gapsFound;
      }, 'the human_needed section must appear before the gaps_found section (a missing marker is reported by the section read below)')
      .satisfies((text) => {
        const humanNeeded = text.indexOf('**If human_needed:**');
        const gapsFound = text.indexOf('**If gaps_found:**');
        if (humanNeeded === -1 || gapsFound === -1) return true;
        const updateRoadmap = text.indexOf('update_roadmap', humanNeeded);
        return updateRoadmap === -1 || updateRoadmap >= gapsFound;
      }, 'update_roadmap must not be reachable directly from the human_needed branch: phase completion must go through verify-work (issue #38)');
    // With the markers in the wrong order the section is empty: the order finding above is the one cause, so the section
    // is not read then (the old test sliced to an empty string).
    const humanNeededAt = workflow.text.indexOf('**If human_needed:**');
    const gapsFoundAt = workflow.text.indexOf('**If gaps_found:**');
    if (!(humanNeededAt !== -1 && gapsFoundAt !== -1 && gapsFoundAt < humanNeededAt)) {
      workflow.slice('**If human_needed:**', '**If gaps_found:**')
        .has('verify-work', 'the human_needed branch must direct the user to /gsd:verify-work to complete verification')
        .has('-UAT.md', 'the human_needed branch must create a {phase_num}-UAT.md file for verify-work to resume')
        .lacks('HUMAN-UAT.md', 'the human_needed branch must not create HUMAN-UAT.md: use {phase_num}-UAT.md to align with verify-work\'s resume path (issue #38 edge case 3)');
    }
  },
};
