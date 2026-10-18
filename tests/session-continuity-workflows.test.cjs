// allow-test-rule: source-text-is-the-product
// Reads .md product files whose deployed text IS what the runtime loads —
// testing text content tests the deployed contract.
'use strict';

/**
 * Workflow-text invariants for per-session pause (see
 * tests/session-continuity.test.cjs for the runtime half).
 *
 * pause-work.md must route the pause through `state record-session --session`
 * and must never instruct a project-wide `status: paused` / `Paused At:`;
 * resume-project.md must consume the handoff through `state session-resume`
 * (not by hand-editing STATE.md's session block); next.md must key Route 8 on
 * this session's own HANDOFF file.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS = path.join(__dirname, '..', 'gsd-core', 'workflows');
const read = (name) => fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');

describe('pause-work.md', () => {
  const body = read('pause-work.md');

  test('records the pause through state record-session with --session', () => {
    assert.match(body, /gsd_run state record-session/);
    assert.match(body, /--session "\$session_id"/);
    assert.match(body, /--role-id "\$role_id"/);
  });

  test('states the per-session rule and never writes a project-wide pause', () => {
    assert.match(body, /Never set STATE\.md `status:` to `paused`/);
    assert.doesNotMatch(body, /^\s*status:\s*paused\s*$/m, 'must not show a `status: paused` frontmatter line to copy');
    assert.doesNotMatch(body, /\*\*Paused At:\*\*/, 'must not instruct a Paused At: line');
  });

  test('commits the per-session record alongside the handoff', () => {
    assert.match(body, /\.planning\/sessions\/\$\{session_id\}\.json/);
  });
});

describe('resume-project.md', () => {
  const body = read('resume-project.md');

  test('lists sessions and resumes through the verbs', () => {
    assert.match(body, /gsd_run state sessions/);
    assert.match(body, /gsd_run state session-resume/);
    assert.match(body, /--action "\[routed action/);
  });

  test('no longer hand-edits the Session Continuity block', () => {
    assert.doesNotMatch(body, /Stopped at: Session resumed, proceeding to \[action\]\n/, 'the old markdown template block must be gone');
    assert.match(body, /do \*\*not\*\* edit `## Session`/);
  });

  test('scans for session-keyed files with guarded globs, not the external find (#3689, #4805)', () => {
    assert.ok(body.includes('for f in .planning/HANDOFF*.json; do'));
    assert.ok(body.includes('for f in .planning/.continue-here*.md .planning/*/.continue-here*.md .planning/*/*/.continue-here*.md ./.continue-here*.md; do'));
    assert.doesNotMatch(body, /^find \./m);
  });

  test('deletion of other sessions\' handoffs is forbidden', () => {
    assert.match(body, /Never delete other sessions' `HANDOFF\*\.json` by hand/);
  });
});

describe('next.md', () => {
  const body = read('next.md');

  test('Route 8 keys on this session\'s own HANDOFF file', () => {
    assert.match(body, /HANDOFF\.\$\{CLAUDE_CODE_SESSION_ID\}\.json/);
    assert.match(body, /HANDOFF\.latest\.<role_id>\.json/);
    assert.match(body, /do not pause this session/);
  });

  test('Gate 1 checks this session\'s own continue-here first', () => {
    assert.match(body, /\.continue-here\.\$\{CLAUDE_CODE_SESSION_ID:-none\}\.md/);
  });
});
