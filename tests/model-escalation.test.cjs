'use strict';
const { test } = require('node:test');
const fc = require('./helpers/fast-check-setup.cjs');
const { escalationAllows } = require('../gsd-core/bin/lib/model-escalation.cjs');

test('property: a record counts for a dispatch iff either side has no session or both carry the same one', () => {
  fc.assert(fc.property(fc.constantFrom(undefined, 's1', 's2', ''), fc.constantFrom(undefined, 's1', 's2', ''), (recSession, session) => {
    const rec = { model: 'opus', written_at: 0, ...(recSession === undefined ? {} : { session: recSession }) };
    return escalationAllows(rec, 'opus', { now: 0, session }) === (session === undefined || recSession === undefined || recSession === session);
  }));
});

test('property: modelFamily maps any id carrying a catalog tier name as a token to that tier, and anything else to its lower-cased id', () => {
  const { modelFamily } = require('../gsd-core/bin/lib/model-escalation.cjs');
  const { CLAUDE_AGENT_ALIASES } = require('../gsd-core/bin/lib/model-catalog.cjs');
  fc.assert(fc.property(fc.constantFrom(...CLAUDE_AGENT_ALIASES), fc.constantFrom('', 'claude-', 'anthropic/claude-', 'us.anthropic.claude-'),
    fc.constantFrom('', '-4-6', '-4-5-20250929', '@20250805', '4'), (tier, pre, post) => modelFamily(`${pre}${tier}${post}`.toUpperCase()) === tier));
  fc.assert(fc.property(fc.constantFrom('gpt-5', 'o3', 'gemini-2.5-pro', 'xopus', 'sonnetx', '9opus'), (id) => modelFamily(id) === id));
});
