// allow-test-rule: source-text-is-the-product see #2415
// Workflow .md files — their text IS what the runtime loads. Testing text content
// tests the deployed contract. Per CONTRIBUTING.md exception matrix.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXECUTE_PHASE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');

describe('#2415: close_phase_todos must stage the pending/ deletion alongside completed/', () => {
  test('the close_phase_todos commit --files list includes .planning/todos/pending/', () => {
    const content = fs.readFileSync(EXECUTE_PHASE, 'utf8');

    // Isolate the close_phase_todos step body so we don't match unrelated --files lists
    // elsewhere in the workflow (other steps commit different paths for different reasons).
    const stepStart = content.indexOf('<step name="close_phase_todos">');
    assert.ok(stepStart > -1, 'close_phase_todos step must exist in execute-phase.md');
    const stepEnd = content.indexOf('</step>', stepStart);
    assert.ok(stepEnd > stepStart, 'close_phase_todos step must be properly closed');
    const stepBody = content.slice(stepStart, stepEnd);

    // The commit must include BOTH the destination (completed/) AND the source (pending/)
    // — git add of pending/ stages the deletion of each moved file. Without pending/ in
    // the list, only the new completed/ copy gets committed and the moved-away file
    // persists as an unstaged deletion in git status until some later broad git add -A
    // happens to catch it (#2415).
    const gsdRunCommit = /gsd_run\s+query\s+commit\b[^\n]*--files\s+([^\n]+)/;
    const match = stepBody.match(gsdRunCommit);
    assert.ok(match, `close_phase_todos step must contain a gsd_run query commit ... --files invocation. Step body:\n${stepBody}`);
    const filesList = match[1];

    assert.match(filesList, /\.planning\/todos\/completed/, 'commit --files must include .planning/todos/completed/ (destination of the move)');
    assert.match(filesList, /\.planning\/todos\/pending/, 'commit --files must include .planning/todos/pending/ so the moved-away file is staged as a deletion (#2415)');
    assert.match(filesList, /\.planning\/STATE\.md/, 'commit --files must still include .planning/STATE.md (the step also updates state)');
  });

  test('close_phase_todos uses plain mv (not git mv) so untracked todos and non-git .planning dirs still work', () => {
    const content = fs.readFileSync(EXECUTE_PHASE, 'utf8');
    const stepStart = content.indexOf('<step name="close_phase_todos">');
    const stepEnd = content.indexOf('</step>', stepStart);
    const stepBody = content.slice(stepStart, stepEnd);

    // Strip bash comments so a doc comment mentioning "git mv" (rationale) doesn't
    // trip the assertion. We care about the actual command, not the prose.
    const withoutComments = stepBody.replace(/^\s*#.*$/gm, '');

    // git mv would stage the rename atomically, but it FAILS on untracked todos and on
    // non-git .planning dirs. Plain mv + the two-dir --files list (verified above) is
    // more robust and what the fix uses. Pin the choice so a future contributor doesn't
    // switch to git mv without revisiting the failure modes.
    assert.match(withoutComments, /\bmv\s+"\$TODO_FILE"\s+"\$COMPLETED_DIR\/"/, 'close_phase_todos must use plain shell mv to move the file');
    assert.doesNotMatch(withoutComments, /\bgit\s+mv\b/, 'close_phase_todos must NOT use git mv as the actual move command — it fails on untracked todos and on non-git .planning dirs');
  });
});
