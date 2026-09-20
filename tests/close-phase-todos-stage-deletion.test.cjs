// allow-test-rule: source-text-is-the-product see #2415
// Workflow .md files — their text IS what the runtime loads. Testing text content
// tests the deployed contract. Per CONTRIBUTING.md exception matrix.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const EXECUTE_PHASE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const CLEANUP = path.join(__dirname, '..', 'gsd-core', 'workflows', 'cleanup.md');

describe('#2415: close_phase_todos must stage the pending/ deletion alongside completed/', () => {
  test('close_phase_todos stages the completed/ destination and the pending/ deletion (via --files-removed since #4208)', () => {
    const content = fs.readFileSync(EXECUTE_PHASE, 'utf8');

    // Isolate the close_phase_todos step body so we don't match unrelated --files lists
    // elsewhere in the workflow (other steps commit different paths for different reasons).
    const stepStart = content.indexOf('<step name="close_phase_todos">');
    assert.ok(stepStart > -1, 'close_phase_todos step must exist in execute-phase.md');
    const stepEnd = content.indexOf('</step>', stepStart);
    assert.ok(stepEnd > stepStart, 'close_phase_todos step must be properly closed');
    const stepBody = content.slice(stepStart, stepEnd);

    // The commit must reach BOTH the destination (completed/) AND the source-side
    // deletion (pending/). Without the source side, only the new completed/ copy gets
    // committed and the moved-away file persists as an unstaged deletion in git status
    // until some later broad git add -A happens to catch it (#2415).
    //
    // #4208 changed the MECHANISM, not that guarantee. The step used to pass the two
    // directories to --files, which also committed any unrelated todo a concurrent
    // session had dropped into pending/ or completed/ mid-close. It now names each
    // moved todo: destinations via the ADDED array under --files, and the source-side
    // deletions via the REMOVED array under --files-removed (--files alone cannot
    // record a deletion — a missing --files entry is skipped, never staged, per #2014).
    const gsdRunCommit = /gsd_run\s+query\s+commit\b[^\n]*--files\s+([^\n]+)/;
    const match = stepBody.match(gsdRunCommit);
    assert.ok(match, `close_phase_todos step must contain a gsd_run query commit ... --files invocation. Step body:\n${stepBody}`);
    const filesList = match[1];

    assert.match(filesList, /"\$\{ADDED\[@\]\}"/, 'commit --files must carry the ADDED array (destinations of the move)');
    assert.match(filesList, /--files-removed\s+"\$\{REMOVED\[@\]\}"/, 'the moved-away file must be staged as a deletion via --files-removed (#2415, #4208)');
    assert.match(filesList, /\.planning\/STATE\.md/, 'commit --files must still include .planning/STATE.md (the step also updates state)');

    // The arrays are only worth asserting if they are built from the right two dirs:
    // ADDED from completed/ (destination), REMOVED from pending/ (source).
    assert.match(stepBody, /ADDED\+=\("\$COMPLETED_DIR\/\$f"\)/, 'ADDED must be built from $COMPLETED_DIR — the destination of the move');
    assert.match(stepBody, /REMOVED\+=\("\$PENDING_DIR\/\$f"\)/, 'REMOVED must be built from $PENDING_DIR — the source whose deletion #2415 requires');
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

describe('#4208: cleanup.md archives phase directories without a --files directory sweep', () => {
  // The other caller #4208 rewrote. execute-phase.md's equivalent rewrite is
  // pinned above; this one was not, so a revert of the routing here would be
  // caught by nothing -- the mechanism's own unit tests pass either way,
  // because they never read this file.
  function archiveStepBody() {
    // splitLines (the text-lines seam), not a `[^\n]*` match over the whole
    // file: a bare \n is CRLF-fragile under Windows autocrlf, and an unbounded
    // quantifier over readFileSync content is the #2128 backtracking class.
    const lines = splitLines(fs.readFileSync(CLEANUP, 'utf8'));
    const line = lines.find(l => /gsd_run\s+query\s+commit\b/.test(l) && l.includes('--files-removed'));
    assert.ok(line, `cleanup.md must commit the archive via gsd_run query commit ... --files-removed. Lines scanned: ${lines.length}`);
    return line;
  }

  test('the archive commit routes the moved-away directories through --files-removed, not --files', () => {
    const line = archiveStepBody();
    const [added, removed] = line.split('--files-removed');

    // The two directories the archival mv empties. Under --files a directory
    // entry stages EVERYTHING under it, so an in-flight phase or quick-task
    // file a concurrent session had written there would be committed too --
    // the sweep #4208 exists to remove.
    for (const dir of ['.planning/phases/', '.planning/quick/']) {
      assert.ok(removed.includes(dir), `${dir} must be under --files-removed. Line: ${line}`);
      assert.ok(!added.includes(dir), `${dir} must NOT be under --files -- a directory entry there sweeps in concurrent writes. Line: ${line}`);
    }
  });

  test('the destinations and STATE.md stay under --files, which cannot record a deletion', () => {
    const line = archiveStepBody();
    const added = line.split('--files-removed')[0];
    // Assert the FLAG, not just the substrings: without this, deleting
    // `--files` entirely leaves the destinations sitting before
    // `--files-removed` and the test still passes (round review, MINOR).
    assert.match(added, /--files\s/, `the additive half must actually carry --files. Line: ${line}`);
    // --files keeps its #2014 skip-if-missing contract: it is the additive
    // half and the only half that can carry a path that must be WRITTEN.
    assert.ok(added.includes('.planning/milestones/'), `the archive destination must stay under --files. Line: ${line}`);
    assert.ok(added.includes('.planning/STATE.md'), `STATE.md must stay under --files. Line: ${line}`);
  });
});
