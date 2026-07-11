'use strict';

/**
 * cline dispatch DEGRADATION — ADR-1239 / #2090.
 *
 * Proves cline's dispatch STAYS degraded/flat and is NEVER silently upgraded to
 * the programmatic-cli profile baseline's full nested/background dispatch.
 * Cline's own docs (docs/features/subagents.mdx) restrict subagents to a single
 * level, read-only toolkit, no nested spawning — so claiming full dispatch would
 * misrepresent a documented host restriction and violate the fail-closed
 * negotiation contract. This is the cline counterpart to cursor's dispatch
 * UPGRADE (#2089), asserting the OPPOSITE invariant: cline flattens.
 *
 * Cite:
 *   https://github.com/cline/cline/blob/main/docs/features/subagents.mdx
 *     — "subagents are restricted from editing files, using the browser,
 *        accessing MCP servers, or creating nested subagents."
 *   https://github.com/cline/cline/blob/main/docs/features/subagents.mdx
 *     — "They are explicitly prohibited from ... spawning other subagents."
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  shouldFlattenDispatch,
  degradationFor,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const CLN_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'cline', 'capability.json'), 'utf8'),
);
const CLN_DISPATCH = CLN_CAP.runtime.hostIntegration.dispatch;

// -- cline dispatch axes: documented restrictions ----------------------------

test('cline dispatch declares namedDispatch but NOT nested (single-level only)', () => {
  assert.equal(CLN_DISPATCH.namedDispatch, true,
    'cite agents-squad example — start_subagent(preset:..., task:...) named dispatch');
  assert.equal(CLN_DISPATCH.nested, false,
    'cite subagents.mdx — subagents cannot create nested subagents');
});

test('cline dispatch respects maxDepth: 1 (the documented hard limit)', () => {
  assert.equal(CLN_DISPATCH.maxDepth, 1,
    'cite subagents.mdx — "explicitly prohibited from ... spawning other subagents"');
});

test('cline subagentToolkit is read-only (no write/browser/mcp for subagents)', () => {
  assert.equal(CLN_DISPATCH.subagentToolkit, 'read-only',
    'cite subagents.mdx — "strictly limited to read-only operations"');
});

test('cline backgroundDispatch is false (background commands run, but no nested-dispatch)', () => {
  assert.equal(CLN_DISPATCH.background, true,
    'cite subagents.mdx — "Commands executed by subagents run in the background"');
  assert.equal(CLN_DISPATCH.backgroundDispatch, false,
    'cite subagents.mdx — cannot spawn nested subagents from a background context');
});

// -- shouldFlattenDispatch: cline MUST flatten (degraded) --------------------

test('shouldFlattenDispatch(cline) is true — waves run inline (the #853 rule)', () => {
  assert.equal(shouldFlattenDispatch(CLN_DISPATCH), true,
    'cline has backgroundDispatch:false → GSD must force-flatten (run inline)');
});

test('a hypothetical full-upgrade (backgroundDispatch:true) would NOT flatten — proving the discriminator', () => {
  const hypothetical = { ...CLN_DISPATCH, backgroundDispatch: true, nested: true, maxDepth: 2, subagentToolkit: 'full' };
  assert.equal(shouldFlattenDispatch(hypothetical), false,
    'only background:true AND backgroundDispatch:true escapes flattening — cline lacks both');
});

// -- degradationFor: cline dispatch is 'degraded' / flat ---------------------

test('degradationFor("dispatch", cline) is degraded with the flat-dispatch fallback', () => {
  const result = degradationFor('dispatch', CLN_CAP.runtime.hostIntegration);
  assert.equal(result.level, 'degraded',
    'maxDepth:1 (flat) is a degraded dispatch surface, never full');
  assert.equal(result.fallback, 'flat dispatch — waves run inline');
  assert.notEqual(result.level, 'full',
    'cline dispatch must NEVER be classified as full — that would misrepresent the host');
});

test('cline dispatch is never silently upgraded to the programmatic-cli baseline', () => {
  // The full baseline requires nested + maxDepth>=2 + subagentToolkit 'full'.
  // Cline violates ALL three (nested:false, maxDepth:1, read-only) — so it must
  // stay degraded regardless of any negotiation defaults.
  const result = degradationFor('dispatch', CLN_CAP.runtime.hostIntegration);
  assert.notEqual(result.level, 'full');
});

// -- boundary: maxDepth 1 vs 0 vs -1 ----------------------------------------

test('maxDepth 1 is flat (NOT absent, NOT unbounded)', () => {
  assert.ok(CLN_DISPATCH.maxDepth > 0, 'maxDepth must be positive (not absent/single-agent)');
  assert.notEqual(CLN_DISPATCH.maxDepth, -1, 'cline is NOT unbounded — depth-1 is the documented limit');
  assert.notEqual(CLN_DISPATCH.maxDepth, 0, 'maxDepth:0 would mean no named dispatch — cline HAS named dispatch');
});
