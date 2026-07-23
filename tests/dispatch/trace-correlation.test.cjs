'use strict';

/**
 * End-to-end trace correlation tests (issue #178).
 *
 * Demonstrates the full parentTraceId propagation seam:
 *   1. A Hub is created with a real DispatchLogger writing to a real temp audit file.
 *   2. A "root" dispatch produces a root event (parentTraceId === undefined).
 *   3. Three "child" dispatches pass parentTraceId = root.traceId.
 *   4. The audit file is read back and all four events are verified.
 *   5. A JS filter (simulating jq) confirms the three children are recoverable
 *      by filtering on parentTraceId === rootTraceId.
 *
 * No mocks. No fs stubs. Real file I/O to os.tmpdir().
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createHub } = require('../../gsd-core/bin/lib/command-routing-hub.cjs');
const { createDefaultLogger } = require('../../gsd-core/bin/lib/observability/logger.cjs');
const { cleanup } = require('../helpers.cjs');

// ─── Test fixture setup ───────────────────────────────────────────────────────

/** Minimal registry that always succeeds — all we care about is the event shape. */
function makeRegistry() {
  return {
    plan: { '': () => ({ ok: true, data: 'plan-ok' }) },
    discuss: { '': () => ({ ok: true, data: 'discuss-ok' }) },
    test: { '': () => ({ ok: true, data: 'test-ok' }) },
  };
}

function makeManifest() {
  return {
    plan: [''],
    discuss: [''],
    test: [''],
  };
}

/** Parse a JSONL file into an array of parsed event objects. */
function readJsonl(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split(/\r?\n/).map(line => JSON.parse(line));
}

// ─── Shared state for the test group ─────────────────────────────────────────

let tmpDir;
let auditPath;
let savedAudit;
let capturedEvents;

describe('trace correlation — end-to-end parentTraceId propagation', () => {
  before(() => {
    // Create an isolated temp dir for this test group
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-trace-correlation-test-'));
    auditPath = path.join(tmpDir, '.planning', '.gsd-trace.jsonl');

    // Enable audit file writes
    savedAudit = process.env.GSD_AUDIT;
    process.env.GSD_AUDIT = '1';

    // Build a Hub backed by the real logger writing to our temp dir
    const logger = createDefaultLogger({ cwd: tmpDir });
    const hub = createHub({
      cjsRegistry: makeRegistry(),
      manifest: makeManifest(),
      logger,
    });

    // ── Root dispatch (no parentTraceId) ──────────────────────────────────────
    hub.dispatch({ family: 'plan', subcommand: '' });

    // ── Read root traceId from the audit file ─────────────────────────────────
    const rootEvents = readJsonl(auditPath);
    assert.equal(rootEvents.length, 1, 'setup: one event after root dispatch');
    const rootTraceId = rootEvents[0].traceId;

    // ── Child dispatches — each passes parentTraceId = rootTraceId ────────────
    hub.dispatch({ family: 'plan',    subcommand: '', parentTraceId: rootTraceId });
    hub.dispatch({ family: 'discuss', subcommand: '', parentTraceId: rootTraceId });
    hub.dispatch({ family: 'test',    subcommand: '', parentTraceId: rootTraceId });

    // Capture all events for the assertions below
    capturedEvents = readJsonl(auditPath);
  });

  after(() => {
    // Restore GSD_AUDIT to whatever it was before this test group
    if (savedAudit === undefined) {
      delete process.env.GSD_AUDIT;
    } else {
      process.env.GSD_AUDIT = savedAudit;
    }
    // Clean up the temp directory
    cleanup(tmpDir);
  });

  // ── Assertions ────────────────────────────────────────────────────────────

  test('audit file contains exactly 4 events (1 root + 3 children)', () => {
    assert.equal(capturedEvents.length, 4,
      'audit file must contain exactly 4 events');
  });

  test('root event has parentTraceId === undefined', () => {
    const root = capturedEvents[0];
    // When parentTraceId is undefined it is omitted from JSON serialization.
    // Either absent or explicitly undefined → the contract is "no parent".
    const hasNoParent = !('parentTraceId' in root) || root.parentTraceId === undefined || root.parentTraceId === null;
    assert.ok(hasNoParent,
      `root event must have no parentTraceId, got: ${root.parentTraceId}`);
  });

  test('all 3 child events carry parentTraceId === rootTraceId', () => {
    const rootTraceId = capturedEvents[0].traceId;
    const children = capturedEvents.slice(1);
    assert.equal(children.length, 3, 'there must be exactly 3 child events');
    for (const child of children) {
      assert.strictEqual(child.parentTraceId, rootTraceId,
        `child event must carry parentTraceId=${rootTraceId}, got: ${child.parentTraceId}`);
    }
  });

  test('all 4 events have unique traceIds', () => {
    const ids = capturedEvents.map(e => e.traceId);
    const unique = new Set(ids);
    assert.equal(unique.size, 4,
      'all 4 events must have unique traceIds even when parentTraceId is shared');
  });

  test('JS filter on parentTraceId returns exactly the 3 children (jq-style)', () => {
    const rootTraceId = capturedEvents[0].traceId;
    // Simulates: jq 'select(.parentTraceId == $rootTraceId)' .gsd-trace.jsonl
    const children = capturedEvents.filter(e => e.parentTraceId === rootTraceId);
    assert.equal(children.length, 3,
      'filtering events by parentTraceId === rootTraceId must yield exactly 3 events');
    // Confirm the root itself is not in the filtered set
    const rootInChildren = children.some(e => e.traceId === rootTraceId);
    assert.ok(!rootInChildren,
      'the root event must not appear in the children filter result');
  });

  test('invalid parentTraceId in a child dispatch breaks the correlation tree for that child but does not poison sibling traces', () => {
    // This test uses its own isolated Hub + audit file to avoid interfering with
    // the shared capturedEvents fixture above.
    const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-poison-test-'));
    let isolatedSavedAudit;
    try {
      isolatedSavedAudit = process.env.GSD_AUDIT;
      process.env.GSD_AUDIT = '1';

      const logger = createDefaultLogger({ cwd: isolatedTmp });
      const hub = createHub({
        cjsRegistry: makeRegistry(),
        manifest: makeManifest(),
        logger,
      });

      // Root dispatch — no parentTraceId
      hub.dispatch({ family: 'plan', subcommand: '' });

      const isolatedAuditPath = path.join(isolatedTmp, '.planning', '.gsd-trace.jsonl');
      const afterRoot = readJsonl(isolatedAuditPath);
      assert.equal(afterRoot.length, 1, 'setup: one root event');
      const rootTraceId = afterRoot[0].traceId;

      // Valid child: passes rootTraceId as parentTraceId
      hub.dispatch({ family: 'discuss', subcommand: '', parentTraceId: rootTraceId });

      // Invalid child: passes 'junk' as parentTraceId
      hub.dispatch({ family: 'test', subcommand: '', parentTraceId: 'junk' });

      const allEvents = readJsonl(isolatedAuditPath);
      assert.equal(allEvents.length, 3, 'must have 3 events total (root + valid child + invalid child)');

      const [, validChild, invalidChild] = allEvents;

      // Valid child carries the correct parentTraceId
      assert.strictEqual(validChild.parentTraceId, rootTraceId,
        'valid child must carry parentTraceId === rootTraceId');

      // Invalid child has parentTraceId coerced to undefined (absent from JSON)
      const invalidChildHasNoParent =
        !('parentTraceId' in invalidChild) ||
        invalidChild.parentTraceId === undefined ||
        invalidChild.parentTraceId === null;
      assert.ok(invalidChildHasNoParent,
        'invalid child must have parentTraceId dropped to undefined — not "junk"');

      // Sibling relations are unaffected: filtering by rootTraceId yields only the valid child
      const correlatedChildren = allEvents.filter(e => e.parentTraceId === rootTraceId);
      assert.equal(correlatedChildren.length, 1,
        'only the valid child must appear when filtering by rootTraceId — invalid child must not contaminate');
      assert.strictEqual(correlatedChildren[0].traceId, validChild.traceId,
        'the correlated child must be the valid one');

      // All three events still have unique traceIds
      const ids = allEvents.map(e => e.traceId);
      assert.equal(new Set(ids).size, 3, 'all 3 events must have unique traceIds');
    } finally {
      if (isolatedSavedAudit === undefined) {
        delete process.env.GSD_AUDIT;
      } else {
        process.env.GSD_AUDIT = isolatedSavedAudit;
      }
      cleanup(isolatedTmp);
    }
  });

  test('JS filter on traceId returns only the root event', () => {
    const rootTraceId = capturedEvents[0].traceId;
    // Simulates: jq 'select(.traceId == $rootTraceId)'
    const roots = capturedEvents.filter(e => e.traceId === rootTraceId);
    assert.equal(roots.length, 1, 'filtering by traceId must return exactly one root event');
    assert.ok(
      !('parentTraceId' in roots[0]) || roots[0].parentTraceId === undefined || roots[0].parentTraceId === null,
      'the root event found by traceId must have no parentTraceId'
    );
  });
});
