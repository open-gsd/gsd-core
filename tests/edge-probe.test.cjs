/**
 * Edge-probe reference core unit tests.
 *
 * Asserts the LOCKED export surface of the spec-completeness edge-probe against
 * the BUILT artifact (`gsd-core/bin/lib/edge-probe.cjs`), which
 * `npm run build:lib` (run by pretest) emits from `src/edge-probe.cts`.
 */
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const BUILT_SCRIPT = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'edge-probe.cjs');
const ep = require(BUILT_SCRIPT);

describe('edge-probe: classifyShape', () => {
  test('detects numeric-range from rounding/threshold cues', () => {
    assert.deepEqual(ep.classifyShape('Round a number to N decimal places').sort(),
      ['numeric-range']);
  });
  test('detects collection from interval/merge cues', () => {
    const shapes = ep.classifyShape('Merge a list of overlapping intervals');
    assert.ok(shapes.includes('collection'));
  });
  test('detects text from truncate/string cues', () => {
    const shapes = ep.classifyShape('Truncate a string to a maximum length');
    assert.ok(shapes.includes('text'));
  });
  test('returns [] when no cue matches', () => {
    assert.deepEqual(ep.classifyShape('Display the company logo'), []);
  });
});

describe('edge-probe: TAXONOMY + applicableCategories', () => {
  test('TAXONOMY has the 8 documented categories in order', () => {
    assert.deepEqual(ep.TAXONOMY.map((c) => c.id),
      ['boundary', 'adjacency', 'empty', 'encoding', 'ordering', 'precision', 'idempotency', 'concurrency']);
  });
  test('every category has name, shapes[], probe', () => {
    for (const c of ep.TAXONOMY) {
      assert.equal(typeof c.name, 'string');
      assert.ok(Array.isArray(c.shapes) && c.shapes.length >= 1);
      assert.equal(typeof c.probe, 'string');
    }
  });
  test('numeric-range raises boundary + precision only', () => {
    assert.deepEqual(ep.applicableCategories(['numeric-range']).sort(),
      ['boundary', 'precision']);
  });
  test('collection raises adjacency, empty, ordering', () => {
    assert.deepEqual(ep.applicableCategories(['collection']).sort(),
      ['adjacency', 'empty', 'ordering']);
  });
  test('text raises empty + encoding', () => {
    assert.deepEqual(ep.applicableCategories(['text']).sort(),
      ['empty', 'encoding']);
  });
  test('no shapes raises nothing', () => {
    assert.deepEqual(ep.applicableCategories([]), []);
  });
});

describe('edge-probe: proposeEdges', () => {
  test('rounding requirement proposes boundary + precision, all unresolved', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'Round a number to N decimal places' });
    assert.deepEqual(edges.map((e) => e.category).sort(), ['boundary', 'precision']);
    for (const e of edges) {
      assert.equal(e.requirement_id, 'R1');
      assert.equal(e.status, 'unresolved');
      assert.equal(e.resolution, null);
      assert.equal(e.reason, null);
      assert.equal(typeof e.probe, 'string');
    }
  });
  test('authored shapes override prose classification', () => {
    const edges = ep.proposeEdges({ id: 'R9', text: 'opaque label', shapes: ['collection'] });
    assert.deepEqual(edges.map((e) => e.category).sort(), ['adjacency', 'empty', 'ordering']);
  });
});

describe('edge-probe: validateResolution', () => {
  test('rejects an unknown status', () => {
    assert.throws(() => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'maybe' }),
      /invalid status/i);
  });
  test('rejects dismissed without a reason', () => {
    assert.throws(() => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'dismissed', reason: '' }),
      /dismissed requires a reason/i);
  });
  test('accepts dismissed with a reason', () => {
    assert.equal(ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'dismissed', reason: 'bounded enum' }), true);
  });
});

describe('edge-probe: analyzeCoverage', () => {
  const reqs = [{ id: 'R1', text: 'Merge a list of overlapping intervals' }];
  test('with no resolutions, every applicable edge is unresolved', () => {
    const rep = ep.analyzeCoverage(reqs, []);
    assert.deepEqual(rep.coverage, { applicable: 3, resolved: 0, unresolved: 3 });
  });
  test('merges a covered resolution and counts it resolved', () => {
    const rep = ep.analyzeCoverage(reqs, [
      { requirement_id: 'R1', category: 'adjacency', status: 'covered', resolution: 'AC#6: touching intervals merge' },
    ]);
    const adj = rep.items.find((i) => i.category === 'adjacency');
    assert.equal(adj.status, 'covered');
    assert.equal(adj.resolution, 'AC#6: touching intervals merge');
    assert.equal(rep.coverage.resolved, 1);
    assert.equal(rep.coverage.unresolved, 2);
  });
  test('throws if a resolution is invalid (dismissed w/o reason)', () => {
    assert.throws(() => ep.analyzeCoverage(reqs, [
      { requirement_id: 'R1', category: 'empty', status: 'dismissed' },
    ]), /dismissed requires a reason/i);
  });
});

describe('edge-probe: CLI (built artifact)', () => {
  test('reads a requirements file and prints a coverage report as JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-'));
    const reqPath = path.join(dir, 'requirements.json');
    fs.writeFileSync(reqPath, JSON.stringify([{ id: 'R1', text: 'Round a number to N decimal places' }]));
    const out = execFileSync('node', [BUILT_SCRIPT, reqPath], { encoding: 'utf8' });
    const rep = JSON.parse(out);
    assert.deepEqual(rep.coverage, { applicable: 2, resolved: 0, unresolved: 2 });
  });
  test('with no args exits with status 2 (assert on exit code, not stderr prose)', () => {
    let status;
    try {
      execFileSync('node', [BUILT_SCRIPT], { stdio: 'pipe' });
      status = 0;
    } catch (error) {
      status = error.status;
    }
    assert.equal(status, 2);
  });
});

describe('edge-probe: CLI JSON.parse error handling (RR-10)', () => {
  test('invalid requirements JSON exits with status 2 (handled error, not uncaught throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-rr10-'));
    const badJson = path.join(dir, 'bad-req.json');
    fs.writeFileSync(badJson, 'not valid json {{{');
    try {
      const r = spawnSync(process.execPath, [BUILT_SCRIPT, badJson], { stdio: 'pipe' });
      assert.equal(r.status, 2);
    } finally {
      cleanup(dir);
    }
  });
  test('invalid resolutions JSON exits with status 2 (handled error, not uncaught throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-rr10-'));
    const goodReq = path.join(dir, 'req.json');
    const badRes = path.join(dir, 'bad-res.json');
    fs.writeFileSync(goodReq, JSON.stringify([{ id: 'R1', text: 'Round a number to N decimal places' }]));
    fs.writeFileSync(badRes, 'not valid json {{{');
    try {
      const r = spawnSync(process.execPath, [BUILT_SCRIPT, goodReq, badRes], { stdio: 'pipe' });
      assert.equal(r.status, 2);
    } finally {
      cleanup(dir);
    }
  });
  test('valid requirements file exits 0 and stdout is parseable JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-rr10-'));
    const reqPath = path.join(dir, 'req.json');
    fs.writeFileSync(reqPath, JSON.stringify([{ id: 'R1', text: 'Round a number to N decimal places' }]));
    try {
      const r = spawnSync(process.execPath, [BUILT_SCRIPT, reqPath], { stdio: 'pipe', encoding: 'utf8' });
      assert.equal(r.status, 0);
      const rep = JSON.parse(r.stdout);
      assert.deepEqual(rep.coverage, { applicable: 2, resolved: 0, unresolved: 2 });
    } finally {
      cleanup(dir);
    }
  });
});

describe('edge-probe: proposeEdges — empty-shapes override (RR-06)', () => {
  test('shapes: [] returns zero edges (explicit empty-shapes override)', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'merge intervals', shapes: [] });
    assert.deepEqual(edges, []);
  });
  test('absent shapes key classifies from prose (no override)', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'merge intervals' });
    assert.ok(edges.length > 0, 'should classify collection edges from prose');
  });
  test('shapes: [collection] overrides prose and proposes collection categories', () => {
    const edges = ep.proposeEdges({ id: 'R9', text: 'opaque text with no cues', shapes: ['collection'] });
    assert.deepEqual(edges.map((e) => e.category).sort(), ['adjacency', 'empty', 'ordering']);
  });
});

describe('edge-probe: proposeEdges — invalid authored shapes fail closed (re-review #3 High)', () => {
  // A non-empty but INVALID shapes array must NOT silently suppress every probe.
  // shapes:['numeric'] (typo for the locked 'numeric-range') previously passed
  // Array.isArray, matched no category, and returned applicable:0 — failing OPEN.
  test('rejects an unknown shape value (typo for a locked shape)', () => {
    assert.throws(
      () => ep.proposeEdges({ id: 'R1', text: 'Round a number', shapes: ['numeric'] }),
      /invalid shape/i,
    );
  });
  test('rejects a mixed array where one entry is invalid', () => {
    assert.throws(
      () => ep.proposeEdges({ id: 'R1', text: 'Round a number', shapes: ['numeric-range', 'bogus'] }),
      /invalid shape/i,
    );
  });
  test('rejects a non-string shape entry', () => {
    assert.throws(
      () => ep.proposeEdges({ id: 'R1', text: 'Round a number', shapes: [42] }),
      /invalid shape/i,
    );
  });
  test('analyzeCoverage propagates the invalid-shape throw', () => {
    assert.throws(
      () => ep.analyzeCoverage([{ id: 'R1', text: 'Round a number', shapes: ['numeric'] }]),
      /invalid shape/i,
    );
  });
  test('CLI exits 2 (handled) on an invalid authored shape, not an uncaught trace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-shape-'));
    const reqPath = path.join(dir, 'req.json');
    fs.writeFileSync(reqPath, JSON.stringify([{ id: 'R1', text: 'Round a number', shapes: ['numeric'] }]));
    try {
      const r = spawnSync(process.execPath, [BUILT_SCRIPT, reqPath], { stdio: 'pipe' });
      assert.equal(r.status, 2);
    } finally {
      cleanup(dir);
    }
  });
  test('a valid locked shape still proposes its categories (no false rejection)', () => {
    const edges = ep.proposeEdges({ id: 'R1', text: 'opaque', shapes: ['numeric-range'] });
    assert.deepEqual(edges.map((e) => e.category).sort(), ['boundary', 'precision']);
  });
  test('shapes: [] remains a valid zero-edge override (RR-06 intact)', () => {
    assert.deepEqual(ep.proposeEdges({ id: 'R1', text: 'merge intervals', shapes: [] }), []);
  });
});

describe('edge-probe: input validation & orphan-resolution rejection (adversarial review)', () => {
  // HIGH: a resolution whose (requirement_id, category) matches no proposed edge — a typo'd
  // category or a non-applicable one — was silently DROPPED, so an author who typos `precison`
  // sees the precision edge as still-unresolved with no error (a confirmed money-rounding exploit).
  test('rejects an orphan resolution (typo category — no matching proposed edge)', () => {
    assert.throws(
      () => ep.analyzeCoverage(
        [{ id: 'R1', text: 'Round a number to N decimal places' }],
        [{ requirement_id: 'R1', category: 'precison', status: 'covered', resolution: 'AC: precision handled' }],
      ),
      /unknown resolution|no matching proposed edge/i,
    );
  });
  test('rejects a resolution for a valid-but-non-applicable category', () => {
    // 'encoding' is a real taxonomy id but applies to text, not the numeric-range requirement.
    assert.throws(
      () => ep.analyzeCoverage(
        [{ id: 'R1', text: 'Round a number to N decimal places' }],
        [{ requirement_id: 'R1', category: 'encoding', status: 'covered', resolution: 'AC' }],
      ),
      /unknown resolution|no matching proposed edge/i,
    );
  });
  test('a matching resolution still resolves (no false orphan rejection)', () => {
    const rep = ep.analyzeCoverage(
      [{ id: 'R1', text: 'Round a number to N decimal places' }],
      [{ requirement_id: 'R1', category: 'precision', status: 'covered', resolution: 'AC: precision tested' }],
    );
    assert.equal(rep.coverage.resolved, 1);
  });
  test('rejects requirements that is not an array', () => {
    assert.throws(() => ep.analyzeCoverage('nope'), /requirements must be an array/i);
  });
  test('rejects a duplicate requirement id', () => {
    assert.throws(
      () => ep.analyzeCoverage([{ id: 'R1', text: 'a' }, { id: 'R1', text: 'b' }]),
      /duplicate requirement/i,
    );
  });
  test('rejects a truthy non-array shapes (string instead of array)', () => {
    // A bare string `shapes: "numeric-range"` previously fell through to prose classification,
    // silently ignoring the authored override instead of honoring or rejecting it.
    assert.throws(
      () => ep.proposeEdges({ id: 'R1', text: 'x', shapes: 'numeric-range' }),
      /shapes must be an array/i,
    );
  });
  test('rejects a missing requirement id', () => {
    assert.throws(() => ep.proposeEdges({ text: 'x' }), /requirement id must be a non-empty string/i);
  });
  test('rejects an empty requirement id', () => {
    assert.throws(() => ep.proposeEdges({ id: '   ', text: 'x' }), /requirement id must be a non-empty string/i);
  });
  test('rejects a non-string requirement text', () => {
    assert.throws(() => ep.proposeEdges({ id: 'R1', text: 42 }), /text must be a string/i);
  });
});

describe('edge-probe: validateResolution — covered-needs-resolution (RR-07)', () => {
  test('rejects covered with empty resolution string', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'covered', resolution: '' }),
      /covered requires a resolution/i,
    );
  });
  test('rejects covered with whitespace-only resolution', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'covered', resolution: '   ' }),
      /covered requires a resolution/i,
    );
  });
  test('rejects covered with missing resolution', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'covered' }),
      /covered requires a resolution/i,
    );
  });
  test('accepts covered with a non-empty resolution', () => {
    assert.equal(
      ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'covered', resolution: 'AC#3: boundary tested in suite' }),
      true,
    );
  });
});

describe('edge-probe: validateResolution — backstop-needs-resolution (RR-07 follow-up)', () => {
  test('rejects backstop with empty resolution string', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'backstop', resolution: '' }),
      /backstop requires a resolution/i,
    );
  });
  test('rejects backstop with whitespace-only resolution', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'backstop', resolution: '   ' }),
      /backstop requires a resolution/i,
    );
  });
  test('rejects backstop with missing resolution', () => {
    assert.throws(
      () => ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'backstop' }),
      /backstop requires a resolution/i,
    );
  });
  test('accepts backstop with a non-empty resolution note', () => {
    assert.equal(
      ep.validateResolution({ requirement_id: 'R1', category: 'boundary', status: 'backstop', resolution: 'held-out: covered by integration fuzz suite' }),
      true,
    );
  });
});

describe('edge-probe: analyzeCoverage — duplicate rejection (RR-09)', () => {
  const reqs = [{ id: 'R1', text: 'Merge a list of overlapping intervals' }];
  test('rejects duplicate (requirement_id, category) resolution', () => {
    assert.throws(
      () => ep.analyzeCoverage(reqs, [
        { requirement_id: 'R1', category: 'adjacency', status: 'covered', resolution: 'AC#1' },
        { requirement_id: 'R1', category: 'adjacency', status: 'covered', resolution: 'AC#2' },
      ]),
      /duplicate resolution/i,
    );
  });
  test('distinct pairs still analyze without throwing', () => {
    // mirrors fixture 06-resolved-mixed
    assert.doesNotThrow(() => ep.analyzeCoverage(reqs, [
      { requirement_id: 'R1', category: 'adjacency', status: 'covered', resolution: 'AC#6: touching intervals merge' },
      { requirement_id: 'R1', category: 'ordering', status: 'dismissed', resolution: null, reason: 'output is canonically sorted; no tie possible' },
    ]));
  });
});

describe('edge-probe: golden fixtures', () => {
  const root = path.join(__dirname, '..', 'gsd-core', 'references', 'edge-probe-fixtures');
  const fixtures = fs.readdirSync(root).filter((d) =>
    fs.statSync(path.join(root, d)).isDirectory());
  assert.ok(fixtures.length >= 6, 'expected at least 6 fixtures');
  for (const name of fixtures) {
    test(`fixture ${name} matches its golden coverage`, () => {
      const dir = path.join(root, name);
      const reqs = JSON.parse(fs.readFileSync(path.join(dir, 'requirements.json'), 'utf8'));
      const resPath = path.join(dir, 'resolutions.json');
      const res = fs.existsSync(resPath) ? JSON.parse(fs.readFileSync(resPath, 'utf8')) : [];
      const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected-coverage.json'), 'utf8'));
      assert.deepEqual(ep.analyzeCoverage(reqs, res), expected);
    });
  }
});
