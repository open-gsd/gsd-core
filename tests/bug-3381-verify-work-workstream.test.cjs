// allow-test-rule: source-text-is-the-product — verify-work.md is a runtime workflow contract.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('bug #1716: resume_from_file routes to complete_session when no [pending] tests remain', () => {
  test('resume_from_file step contains guard clause for zero-pending (all-blocked) case', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work.md'),
      'utf8',
    );

    const stepStart = workflow.indexOf('<step name="resume_from_file">');
    assert.ok(stepStart !== -1, 'resume_from_file step must exist');

    const stepEnd = workflow.indexOf('</step>', stepStart);
    const stepBody = workflow.slice(stepStart, stepEnd);

    // Guard must appear immediately after the find-pending instruction.
    // Without it, all-blocked sessions (pending_count==0, blocked_count>0)
    // silently terminate and never reach complete_session (#1716).
    const findIdx = stepBody.indexOf("Find first test with `result: [pending]`.");
    const guardIdx = stepBody.indexOf("If no `[pending]` test found → go to `complete_session`.");

    assert.ok(findIdx !== -1, 'find-pending instruction must be present');
    assert.ok(guardIdx !== -1, 'guard clause for zero-pending case must be present');
    assert.ok(guardIdx > findIdx, 'guard must appear after find-pending instruction');

    const between = stepBody
      .slice(findIdx + "Find first test with `result: [pending]`.".length, guardIdx)
      .trim();
    assert.strictEqual(between, '', 'guard must be the next non-whitespace line after find-pending');
  });
});

describe('bug #3381: verify-work forwards workstream context', () => {
  test('workflow forwards ${GSD_WS} to workstream-sensitive SDK queries', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work.md'),
      'utf8',
    );

    assert.match(workflow, /GSD_WS=""/, 'verify-work must initialize GSD_WS');
    assert.match(
      workflow,
      /grep -qE -- '--ws\[\[:space:\]\]\+\[\^\[:space:\]\]\+'/,
      'verify-work must detect --ws in $ARGUMENTS',
    );
    assert.match(
      workflow,
      /grep -oE -- '--ws\[\[:space:\]\]\+\[\^\[:space:\]\]\+'/,
      'verify-work must extract the --ws flag pair from $ARGUMENTS',
    );
    assert.match(
      workflow,
      /PHASE_ARG=\$\(echo "\$ARGUMENTS" \| sed -E 's\/--ws\[\[:space:\]\]\+\[\^\[:space:\]\]\+\/\/g' \| xargs\)/,
      'verify-work must derive PHASE_ARG after removing --ws',
    );
    // After #3797 architectural fix, callsites use gsd_run
    assert.match(
      workflow,
      /gsd_run query init\.verify-work "\$\{PHASE_ARG\}" \$\{GSD_WS\}/,
      'init.verify-work must receive GSD_WS so phase_dir resolves in workstreams',
    );
    assert.match(
      workflow,
      /gsd_run query phase\.mvp-mode "\$\{phase_number\}" \$\{GSD_WS\} --pick active/,
      'phase.mvp-mode must receive GSD_WS so roadmap mode is workstream-scoped',
    );
    assert.match(
      workflow,
      /gsd_run query roadmap\.get-phase "\$\{phase_number\}" \$\{GSD_WS\} --pick goal/,
      'roadmap.get-phase must receive GSD_WS so goals are workstream-scoped',
    );
  });
});
