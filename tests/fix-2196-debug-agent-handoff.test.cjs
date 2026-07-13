'use strict';

/**
 * #2194… no — #2196: the /gsd-debug orchestrator misused the foreground
 * session-manager Agent() spawn as a background task, then queried the returned
 * agent ID via TaskOutput (which expects a task ID) — yielding "No task found
 * with ID" and leaving the workflow waiting on a handoff that was never
 * queryable, with no recovery.
 *
 * The fix makes debug.md state explicitly that the spawn is foreground/blocking,
 * that an agent ID must never be passed to TaskOutput, and that a lost handoff
 * must be recovered (preserve checkpoint + resume). debug.md IS the product the
 * runtime loads, so this asserts the deployed text carries that contract.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DEBUG_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'debug.md');

describe('#2196 debug.md session-manager spawn contract', () => {
  const content = fs.readFileSync(DEBUG_MD, 'utf-8');
  const sectionStart = content.indexOf('Session Management');
  const section = sectionStart !== -1 ? content.slice(sectionStart) : '';

  test('debug.md has the Session Management section', () => {
    assert.notEqual(sectionStart, -1, 'debug.md must contain the Session Management section');
  });

  test('the session-manager spawn is declared foreground/blocking (not backgrounded)', () => {
    assert.ok(/foreground/i.test(section) && /blocking/i.test(section),
      'the Agent() spawn must be declared foreground and blocking so it is not polled');
  });

  test('an agent ID must not be passed to TaskOutput', () => {
    assert.ok(/TaskOutput/.test(section),
      'the contract must mention TaskOutput by name');
    assert.ok(/agent ID is NOT a task ID|agent ID is not a task ID/i.test(section),
      'the contract must state an agent ID is not a task ID');
  });

  test('a lost handoff has a recovery path (preserve checkpoint + resume)', () => {
    // Pin the CANONICAL colon form — the retired /gsd-debug hyphen syntax is
    // rejected by the slash-command-namespace guard, so this must be /gsd:debug.
    assert.ok(/\/gsd:debug continue \{slug\}/.test(section),
      'the contract must point to /gsd:debug continue {slug} (canonical colon form) as the resume path');
    assert.ok(/do not claim|do NOT claim/i.test(section),
      'the contract must forbid claiming a lost-handoff session is still running');
  });
});
