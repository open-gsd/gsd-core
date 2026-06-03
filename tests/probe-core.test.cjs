/**
 * probe-core reference-model unit tests (ADR-550 Decision 7).
 *
 * probe-core is the GENERIC spec-phase probe resolution model extracted from the
 * edge-probe (the first adapter): the resolution lifecycle, the two-axis
 * status×verification re-cut, `validateResolution`/`validateRequirement`, the
 * `analyzeCoverage(items, resolutions?, validators)` merge/rollup/orphan-reject
 * engine, the `byVerification` rollup, and the `runProbeCli` I/O scaffold.
 *
 * Asserts the LOCKED export surface against the BUILT artifact
 * (`gsd-core/bin/lib/probe-core.cjs`), which `npm run build:lib` (run by pretest /
 * the run-tests sentinel) emits from `src/probe-core.cts`.
 *
 * The injected runtime validators are the enforcement contract (ADR-550 #5): the
 * CLI runs over JSON where TS types are erased, so `analyzeCoverage` is told its
 * probe's closed vocabularies — `{ categories, verification, requiredFieldsByVerification }`
 * — rather than relying on the type system. These tests pin the validators' behavior.
 */
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const BUILT_SCRIPT = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'probe-core.cjs');
const pc = require(BUILT_SCRIPT);

// A representative validators bundle — the shape the edge adapter injects, used here
// to exercise the generic engine independent of any one probe.
const VALIDATORS = {
  categories: ['adjacency', 'empty', 'ordering'],
  verification: ['explicit', 'backstop'],
  requiredFieldsByVerification: { explicit: ['resolution'], backstop: ['resolution'] },
};

function item(category, overrides = {}) {
  return {
    requirement_id: 'R1',
    category,
    status: 'unresolved',
    verification: null,
    resolution: null,
    reason: null,
    probe: `probe-for-${category}`,
    ...overrides,
  };
}

const UNRESOLVED_ITEMS = [item('adjacency'), item('empty'), item('ordering')];

describe('probe-core: VALID_STATUS is the re-cut lifecycle enum', () => {
  test('exposes exactly resolved | dismissed | unresolved (no covered/backstop)', () => {
    assert.deepEqual([...ep_sorted(pc.VALID_STATUS)], ['dismissed', 'resolved', 'unresolved']);
    assert.ok(!pc.VALID_STATUS.includes('covered'), 'covered must not survive the re-cut as a status');
    assert.ok(!pc.VALID_STATUS.includes('backstop'), 'backstop must not survive the re-cut as a status');
  });
});

function ep_sorted(arr) {
  return [...arr].sort();
}

describe('probe-core: validateResolution (status×verification)', () => {
  const v = (r) => pc.validateResolution(r, VALIDATORS);
  test('rejects an unknown status', () => {
    assert.throws(() => v({ requirement_id: 'R1', category: 'adjacency', status: 'maybe' }), /invalid status/i);
  });
  test('rejects a former covered status (re-cut: no longer a valid status)', () => {
    assert.throws(() => v({ requirement_id: 'R1', category: 'adjacency', status: 'covered', resolution: 'x' }), /invalid status/i);
  });
  test('rejects dismissed without a reason', () => {
    assert.throws(() => v({ requirement_id: 'R1', category: 'adjacency', status: 'dismissed', reason: '' }), /dismissed requires a reason/i);
  });
  test('accepts dismissed with a reason', () => {
    assert.equal(v({ requirement_id: 'R1', category: 'adjacency', status: 'dismissed', reason: 'bounded enum' }), true);
  });
  test('rejects resolved with a missing verification tier', () => {
    assert.throws(() => v({ requirement_id: 'R1', category: 'adjacency', status: 'resolved', resolution: 'AC' }), /verification/i);
  });
  test('rejects resolved with an unknown verification tier', () => {
    assert.throws(() => v({ requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'judgment', resolution: 'AC' }), /invalid verification/i);
  });
  test('rejects resolved/explicit with empty resolution text', () => {
    assert.throws(() => v({ requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'explicit', resolution: '   ' }), /explicit requires a resolution/i);
  });
  test('rejects resolved/backstop with missing resolution note', () => {
    assert.throws(() => v({ requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'backstop' }), /backstop requires a resolution/i);
  });
  test('accepts resolved/explicit with a resolution', () => {
    assert.equal(v({ requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'explicit', resolution: 'AC#6' }), true);
  });
  test('accepts resolved/backstop with a resolution note', () => {
    assert.equal(v({ requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'backstop', resolution: 'held-out PBT suite' }), true);
  });
});

describe('probe-core: validateRequirement (generic id/text only)', () => {
  test('rejects a missing id', () => {
    assert.throws(() => pc.validateRequirement({ text: 'x' }), /requirement id must be a non-empty string/i);
  });
  test('rejects an empty id', () => {
    assert.throws(() => pc.validateRequirement({ id: '   ', text: 'x' }), /requirement id must be a non-empty string/i);
  });
  test('rejects a non-string text', () => {
    assert.throws(() => pc.validateRequirement({ id: 'R1', text: 42 }), /text must be a string/i);
  });
  test('accepts a valid requirement', () => {
    assert.doesNotThrow(() => pc.validateRequirement({ id: 'R1', text: 'a testable statement' }));
  });
});

describe('probe-core: analyzeCoverage (merge · rollup · byVerification)', () => {
  test('no resolutions → every item unresolved; resolved 0; byVerification zeroed per tier', () => {
    const rep = pc.analyzeCoverage(UNRESOLVED_ITEMS, [], VALIDATORS);
    assert.deepEqual(rep.coverage, {
      applicable: 3, resolved: 0, unresolved: 3, byVerification: { explicit: 0, backstop: 0 },
    });
  });
  test('merges a resolved/explicit resolution and counts byVerification.explicit', () => {
    const rep = pc.analyzeCoverage(UNRESOLVED_ITEMS, [
      { requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'explicit', resolution: 'AC#6: touching intervals merge' },
    ], VALIDATORS);
    const adj = rep.items.find((i) => i.category === 'adjacency');
    assert.equal(adj.status, 'resolved');
    assert.equal(adj.verification, 'explicit');
    assert.equal(adj.resolution, 'AC#6: touching intervals merge');
    assert.equal(rep.coverage.resolved, 1);
    assert.equal(rep.coverage.unresolved, 2);
    assert.deepEqual(rep.coverage.byVerification, { explicit: 1, backstop: 0 });
  });
  test('a dismissed item counts toward coverage.resolved (closed set) but NOT byVerification', () => {
    // coverage.resolved preserves the pre-re-cut "closed" semantic = applicable - unresolved
    // (covered + dismissed + backstop), per edge-probe.md and the migration contract.
    const rep = pc.analyzeCoverage(UNRESOLVED_ITEMS, [
      { requirement_id: 'R1', category: 'ordering', status: 'dismissed', reason: 'canonically sorted; no tie' },
    ], VALIDATORS);
    assert.equal(rep.coverage.resolved, 1);
    assert.equal(rep.coverage.unresolved, 2);
    assert.deepEqual(rep.coverage.byVerification, { explicit: 0, backstop: 0 });
    const ord = rep.items.find((i) => i.category === 'ordering');
    assert.equal(ord.status, 'dismissed');
    assert.equal(ord.verification, null);
    assert.equal(ord.reason, 'canonically sorted; no tie');
  });
  test('mixed resolved/explicit + backstop + dismissed: resolved = closed = applicable - unresolved', () => {
    const rep = pc.analyzeCoverage(UNRESOLVED_ITEMS, [
      { requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'explicit', resolution: 'AC#6' },
      { requirement_id: 'R1', category: 'empty', status: 'resolved', verification: 'backstop', resolution: 'held-out empty-input PBT' },
      { requirement_id: 'R1', category: 'ordering', status: 'dismissed', reason: 'canonically sorted' },
    ], VALIDATORS);
    assert.equal(rep.coverage.applicable, 3);
    assert.equal(rep.coverage.unresolved, 0);
    assert.equal(rep.coverage.resolved, 3); // 2 resolved-status + 1 dismissed
    assert.deepEqual(rep.coverage.byVerification, { explicit: 1, backstop: 1 });
  });
  test('rejects a duplicate (requirement_id, category) resolution', () => {
    assert.throws(() => pc.analyzeCoverage(UNRESOLVED_ITEMS, [
      { requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'explicit', resolution: 'AC#1' },
      { requirement_id: 'R1', category: 'adjacency', status: 'resolved', verification: 'explicit', resolution: 'AC#2' },
    ], VALIDATORS), /duplicate resolution/i);
  });
  test('rejects an orphan resolution (no matching proposed item)', () => {
    assert.throws(() => pc.analyzeCoverage(UNRESOLVED_ITEMS, [
      { requirement_id: 'R1', category: 'boundary', status: 'resolved', verification: 'explicit', resolution: 'AC' },
    ], VALIDATORS), /unknown resolution|no matching proposed/i);
  });
  test('propagates an invalid-resolution throw from validateResolution', () => {
    assert.throws(() => pc.analyzeCoverage(UNRESOLVED_ITEMS, [
      { requirement_id: 'R1', category: 'empty', status: 'dismissed' },
    ], VALIDATORS), /dismissed requires a reason/i);
  });
  test('rejects items that is not an array', () => {
    assert.throws(() => pc.analyzeCoverage('nope', [], VALIDATORS), /items must be an array/i);
  });
  test('rejects a proposed item whose category is not in validators.categories', () => {
    // Adapter self-consistency: an item carrying a category outside the probe's closed
    // vocabulary is an adapter bug, caught here rather than silently rolled up.
    assert.throws(() => pc.analyzeCoverage([item('bogus-category')], [], VALIDATORS), /unknown category/i);
  });
});

describe('probe-core: runProbeCli (generic I/O scaffold, injected io)', () => {
  const report = { items: [], coverage: { applicable: 0, resolved: 0, unresolved: 0, byVerification: {} } };
  test('no requirements path → writes usage to stderr and exits 2', () => {
    let code; let err = '';
    pc.runProbeCli(() => report, {
      usage: 'demo-probe.cjs <requirements.json> [resolutions.json]',
      argv: ['node', 'demo'], writeErr: (s) => { err += s; }, exit: (c) => { code = c; },
    });
    assert.equal(code, 2);
    assert.match(err, /usage: demo-probe\.cjs/);
  });
  test('valid requirements path → calls analyze and prints the report as JSON', () => {
    let out = '';
    pc.runProbeCli((reqs, res) => {
      assert.deepEqual(reqs, [{ id: 'R1', text: 'x' }]);
      assert.deepEqual(res, []);
      return report;
    }, {
      usage: 'demo', argv: ['node', 'demo', '/fake/req.json'],
      readFile: () => '[{"id":"R1","text":"x"}]', write: (s) => { out += s; }, exit: () => {},
    });
    assert.deepEqual(JSON.parse(out), report);
  });
  test('reads the optional resolutions file when a second path is given', () => {
    let seenRes;
    pc.runProbeCli((reqs, res) => { seenRes = res; return report; }, {
      usage: 'demo', argv: ['node', 'demo', '/req.json', '/res.json'],
      readFile: (p) => (p === '/res.json' ? '[{"requirement_id":"R1"}]' : '[{"id":"R1"}]'),
      write: () => {}, exit: () => {},
    });
    assert.deepEqual(seenRes, [{ requirement_id: 'R1' }]);
  });
  test('invalid requirements JSON → exits 2 (handled, not an uncaught throw)', () => {
    let code;
    pc.runProbeCli(() => report, {
      usage: 'demo', argv: ['node', 'demo', '/req.json'],
      readFile: () => 'not json {{{', writeErr: () => {}, exit: (c) => { code = c; },
    });
    assert.equal(code, 2);
  });
  test('an analyze throw → exits 2 (the engine fail-closed surfaces, never silently passes)', () => {
    let code;
    pc.runProbeCli(() => { throw new Error('boom'); }, {
      usage: 'demo', argv: ['node', 'demo', '/req.json'],
      readFile: () => '[]', writeErr: () => {}, exit: (c) => { code = c; },
    });
    assert.equal(code, 2);
  });
});
