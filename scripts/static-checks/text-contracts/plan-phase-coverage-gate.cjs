'use strict';

// #6814: plan-phase step 13 (Requirements Coverage Gate) reads the IDs each live plan claims from its `requirements`
// frontmatter field. The plan set has one owner, src/plan-scan.cts `scanPhasePlans`, reached through phase.list-plans;
// each plan's field is read through frontmatter.get. The step used to grep raw lines of root `*-PLAN.md` files, which
// missed block-list, nested and bare plans and counted body text and superseded plans. What the documented line
// captures is tested in tests/plan-phase-coverage-gate.process.test.cjs; this contract holds the step's text: the skip
// rule, the two verbs, the `tr -d '\r'` after each jq (a native Windows jq.exe ends each line with CR, and a path or
// an ID that ends in CR matches no plan or requirement; jq 1.7's -b avoids it, but jq 1.6 has no -b), no doubled
// backslash (Git Bash started from a native Windows process, as Node starts it, halves `\\` in a quoted argument, so
// a jq filter written `"\\s"` reaches jq as `"\s"`, an invalid escape), and the exact-match rule of step 2.

const PLAN = 'gsd-core/workflows/plan-phase.md';

module.exports = {
  id: 'plan-phase-coverage-gate',
  issue: '#6814',
  check(ctx) {
    ctx.doc(PLAN)
      .slice('## 13. Requirements Coverage Gate', '## 13a.')
      .has('**Skip if:** `phase_req_ids` is null or TBD', 'step 13 must still skip a phase with no mapped requirements')
      .has('gsd_run query phase.list-plans', 'step 13 must read the live plan set from phase.list-plans (scanPhasePlans owns it)')
      .has(/gsd_run query frontmatter\.get "[^"\n]{1,80}" --field requirements/, "step 13 must read each plan's `requirements` field through frontmatter.get")
      .has('while IFS= read -r p;', 'step 13 must read each plan path verbatim (an empty IFS and -r keep its edge blanks and backslashes)')
      .has(`jq -r '.plans[]' | tr -d '\\r' | while`, 'step 13 must strip the CR a native Windows jq.exe ends each plan path with')
      .has(`done | tr -d '\\r' | sort -u)`, 'step 13 must strip the CR a native Windows jq.exe ends each ID with')
      .lacks(/\bjq -[a-z]*b/, 'step 13 must not pass jq -b (jq 1.6 has no such option and exits 2)')
      .lacks('\\\\', 'step 13 must not carry a doubled backslash (Git Bash from a native Windows process halves it)')
      .lacks('requirements_addressed', 'step 13 must not read a field the plan format does not have')
      .lacks(/\bgrep\b/, "step 13 must not grep plan files' raw lines")
      .lacks('*-PLAN.md', 'step 13 must not glob root plan files (the live plan set comes from phase.list-plans)')
      .has('only if it equals a `PLAN_REQS` line exactly', 'step 2 must count a requirement as covered only on an exact line match');
  },
};
