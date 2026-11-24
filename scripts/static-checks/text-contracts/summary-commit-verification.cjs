'use strict';

// Commit claims are measured, never narrated (#3968), and the commit-claim window is bounded to the plan's own
// history (#4670): the executor persists a HEAD ledger through `executor.ledger record` (#6216), takes the SUMMARY
// commit count from `executor.ledger read` (`git rev-list --count` over the recorded base),
// records plan_head_before and plan_head_after, and halts the SUMMARY write on a measured zero with code changes;
// verify-work reconciles each SUMMARY against git with exact equality over BASE..AFTER and flags a mismatch as a
// BLOCKER (legacy SUMMARYs without the anchor fall back to a WARNING); pause-work fills HANDOFF
// uncommitted_files from `git status --porcelain`. Was tests/summary-commit-verification.test.cjs. The windows
// around BLOCKER (1800 characters), the bounded-section markers (2400) and uncommitted_files (3000 each side) are
// the test's own numbers and are pinned at their edges.

const RECONCILIATION = 'Commit-claim reconciliation';
const RECONCILIATION_WINDOW = 1800;
const BOUNDED_WINDOW = 2400;
const PORCELAIN_WINDOW = 3000;
const LEGACY_SENTENCE = '`ACTUAL == CLAIMED + 1` tolerance was a guess';

module.exports = {
  id: 'summary-commit-verification',
  issue: '#3968',
  check(ctx) {
    ctx.doc('agents/gsd-executor.md')
      .has('gsd_run query executor.ledger record --phase {phase} --plan {plan}', 'the ledger must persist on disk through executor.ledger record (each Bash call is a fresh shell: a variable measures zero; #6216)')
      .has('git rev-list --count', 'the SUMMARY commit count must come from git rev-list --count, not narration')
      .has('`plan_head_before:`', 'the base is recorded in the frontmatter so the verifier reconciles with the same instrument')
      .has(/HALT — do not write the\s{1,20}SUMMARY/i, 'a measured zero with uncommitted code changes must halt the SUMMARY write')
      .has(/commits: 7 .{0,500}MEASURED/, 'the actuals block sources its count from the measurement')
      .has('`plan_head_after:`', 'the SUMMARY frontmatter must carry plan_head_after, captured at the measurement moment')
      .has('gsd_run query executor.ledger read --phase {phase} --plan {plan}', 'plan_head_after must come from the same executor.ledger read as the count (#6216)');

    ctx.doc('gsd-core/workflows/verify-work.md')
      .has(RECONCILIATION, 'verify-work must run a commit-claim reconciliation over each SUMMARY')
      .has('ACTUAL=$(git rev-list --count "${BASE}"..HEAD)', 'the reconciliation uses the SAME instrument as the executor (rev-list over the recorded base)')
      .has('Bounded reconciliation (#4670)', 'the bounded exact-equality reconciliation is the shipped rule')
      .before(RECONCILIATION, LEGACY_SENTENCE, 'the +1 tolerance appears only as the retired legacy rule inside the reconciliation block')
      .satisfies((text) => {
        const at = text.indexOf(RECONCILIATION);
        if (at === -1) return `no ${RECONCILIATION} block`;
        return text.slice(at, at + RECONCILIATION_WINDOW).includes('BLOCKER') || `no BLOCKER within ${RECONCILIATION_WINDOW} characters`;
      }, 'a mismatch must be flagged BLOCKER: the phase must not read as done')
      .has('AFTER=$(grep -oE \'^plan_head_after: [0-9a-f]{7,40}\' "$SUMMARY_FILE" | awk \'{print $2}\')', 'the reconciliation must extract plan_head_after')
      .has('git merge-base --is-ancestor "$AFTER" HEAD', 'the plan end must be verified to still be in history (ancestor check)')
      .has('git rev-list --count "${BASE}..${AFTER}"', 'the measured count must be bounded to the plan own window (BASE..AFTER)')
      .satisfies((text) => {
        const at = text.indexOf('#4670');
        if (at === -1) return 'no #4670 section';
        const section = text.slice(at, at + BOUNDED_WINDOW);
        if (!/BLOCKER/.test(section)) return `no BLOCKER within ${BOUNDED_WINDOW} characters of #4670`;
        return /commit_claim_mismatch/.test(section) || `no commit_claim_mismatch within ${BOUNDED_WINDOW} characters of #4670`;
      }, 'a bounded mismatch must remain a BLOCKER and keep the commit_claim_mismatch verdict name')
      .has('plan_head_after', 'plan_head_after must appear in verify-work')
      .has(/WARNING[\s\S]{0,400}plan_head_after/, 'SUMMARYs without plan_head_after must fall back to the WARNING path, not the unsound BLOCKER');

    ctx.doc('gsd-core/workflows/pause-work.md')
      .has('git status --porcelain', 'uncommitted_files must be populated from an actual git status --porcelain call')
      .satisfies((text) => {
        const at = text.indexOf('uncommitted_files');
        if (at === -1) return true;
        return text.slice(Math.max(0, at - PORCELAIN_WINDOW), at + PORCELAIN_WINDOW).includes('porcelain') || `no porcelain within ${PORCELAIN_WINDOW} characters of uncommitted_files`;
      }, 'the uncommitted_files field is defined by the porcelain command, not a narrated []');
  },
};
