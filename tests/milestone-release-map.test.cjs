'use strict';

/**
 * Milestone Release Map module (#5706, phase 2 of epic #3628).
 *
 * Covers the pure validate / render / read-back surface of
 * src/milestone-release-map.cts: strict validation, count and length limits,
 * markdown escaping, archive read-back, and parity of the exported enums with
 * the documented lists.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const {
  validateReleaseMap,
  renderReleaseMapMarkdown,
  readArchivedReleaseMap,
  releaseMapArchivePath,
  serializeReleaseMapArchive,
  loadReleaseMapFile,
  MAX_RELEASE_MAP_ENTRIES,
  MAX_RELEASE_MAP_FIELD_LENGTH,
  RELEASE_MAP_STATUSES,
  RELEASE_MAP_TAG_STATES,
} = require('../gsd-core/bin/lib/milestone-release-map.cjs');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');

function entry(overrides = {}) {
  return { repo: 'api', release: 'v1.2.0', reference: 'abc1234', environment: 'production', status: 'released', tag: 'created', ...overrides };
}

/** Split a rendered table row on unescaped pipes; returns the cell texts. */
function cellsOf(line) {
  const cells = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      current += ch + line[i + 1];
      i++;
    } else if (ch === '|') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.slice(1, -1).map((c) => c.trim());
}

describe('validateReleaseMap: shape and boundaries (rows 10, 11)', () => {
  test('accepts a valid map and normalizes absent optional fields to null', () => {
    const result = validateReleaseMap([{ repo: 'web', status: 'unreleased', tag: 'none' }]);
    assert.deepEqual(result, {
      ok: true,
      map: [{ repo: 'web', release: null, reference: null, environment: null, status: 'unreleased', tag: 'none' }],
    });
  });

  const invalid = [
    ['not an array (object)', { repo: 'a' }, /array/],
    ['not an array (string)', 'nope', /array/],
    ['not an array (null)', null, /array/],
    ['non-object entry', ['x'], /entries\[0\] must be an object/],
    ['null entry', [null], /entries\[0\] must be an object/],
    ['array entry', [[]], /entries\[0\] must be an object/],
    ['blank repo', [entry({ repo: '   ' })], /repo must be a non-blank string/],
    ['missing repo', [{ status: 'released', tag: 'none' }], /repo must be a non-blank string/],
    ['number repo', [entry({ repo: 7 })], /repo must be a non-blank string/],
    ['unknown status', [entry({ status: 'shipped' })], /status must be one of/],
    ['unknown tag', [entry({ tag: 'maybe' })], /tag must be one of/],
    ['missing status', [{ repo: 'a', tag: 'none' }], /status must be one of/],
    ['number release', [entry({ release: 3 })], /release must be a string or null/],
    ['unknown field', [entry({ extra: 'x' })], /unknown field "extra"/],
    ['duplicate repo', [entry(), entry()], /duplicate/],
  ];
  for (const [name, input, pattern] of invalid) {
    test(`rejects ${name}`, () => {
      const result = validateReleaseMap(input);
      assert.equal(result.ok, false);
      assert.ok(result.errors.length >= 1);
      assert.match(result.errors.join('\n'), pattern);
    });
  }

  test('lists every problem in one pass', () => {
    const result = validateReleaseMap([entry({ status: 'x' }), entry({ repo: 'b', tag: 'y' }), 5]);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 3);
  });

  test('field length: 199 and 200 accepted, 201 rejected', () => {
    for (const length of [MAX_RELEASE_MAP_FIELD_LENGTH - 1, MAX_RELEASE_MAP_FIELD_LENGTH]) {
      assert.equal(validateReleaseMap([entry({ release: 'r'.repeat(length) })]).ok, true, `release ${length}`);
      assert.equal(validateReleaseMap([entry({ repo: 'p'.repeat(length) })]).ok, true, `repo ${length}`);
    }
    const over = MAX_RELEASE_MAP_FIELD_LENGTH + 1;
    for (const field of ['repo', 'release', 'reference', 'environment']) {
      const result = validateReleaseMap([entry({ [field]: 'x'.repeat(over) })]);
      assert.equal(result.ok, false, `${field} ${over}`);
      assert.match(result.errors[0], new RegExp(`${field} exceeds ${MAX_RELEASE_MAP_FIELD_LENGTH}`));
    }
  });

  test('entry count: 255 and 256 accepted, 257 rejected', () => {
    const make = (n) => Array.from({ length: n }, (_, i) => entry({ repo: `repo-${i}` }));
    assert.equal(validateReleaseMap(make(MAX_RELEASE_MAP_ENTRIES - 1)).ok, true);
    assert.equal(validateReleaseMap(make(MAX_RELEASE_MAP_ENTRIES)).ok, true);
    const result = validateReleaseMap(make(MAX_RELEASE_MAP_ENTRIES + 1));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /257 entries; the maximum is 256/);
  });

  test('constants are the documented limits', () => {
    assert.equal(MAX_RELEASE_MAP_ENTRIES, 256);
    assert.equal(MAX_RELEASE_MAP_FIELD_LENGTH, 200);
  });

  test('a __proto__ key in an entry is rejected as an unknown field, not applied', () => {
    const hostile = JSON.parse('[{"repo":"a","status":"released","tag":"none","__proto__":{"polluted":true}}]');
    const result = validateReleaseMap(hostile);
    assert.equal(result.ok, false);
    assert.equal({}.polluted, undefined);
  });
});

describe('renderReleaseMapMarkdown (row 11)', () => {
  test('renders the header and one row per entry', () => {
    const md = renderReleaseMapMarkdown([entry(), entry({ repo: 'web', release: null, status: 'unreleased', tag: 'skipped' })]);
    const lines = md.trimEnd().split('\n');
    assert.equal(lines[0], '**Release mapping:**');
    assert.equal(lines[1], '');
    assert.equal(lines[2], '| Repository | Release | Reference | Environment | Status | Tag |');
    assert.equal(lines[3], '| --- | --- | --- | --- | --- | --- |');
    assert.equal(lines.length, 6);
    assert.deepEqual(cellsOf(lines[5]), ['web', '-', 'abc1234', 'production', 'unreleased', 'skipped']);
  });

  test('escapes pipes, newlines, backticks, angle brackets and leading hash', () => {
    const hostile = {
      repo: 'a|b',
      release: 'line1\nline2\r\n# Injected heading',
      reference: '`code` <script>alert(1)</script>',
      environment: '# heading',
      status: 'released',
      tag: 'none',
    };
    const md = renderReleaseMapMarkdown([hostile]);
    const lines = md.trimEnd().split('\n');
    assert.equal(lines.length, 5, 'newlines in values must not add lines');
    const cells = cellsOf(lines[4]);
    assert.equal(cells.length, 6);
    assert.ok(!md.includes('<script>'));
    assert.ok(!/^#/m.test(md), 'no line may start a heading');
    assert.equal(cells[3], '\\# heading');
    assert.equal(cells[0], 'a\\|b');
  });

  test('empty or whitespace-only optional values render as a dash', () => {
    const md = renderReleaseMapMarkdown([entry({ release: '', reference: '  ' })]);
    const cells = cellsOf(md.trimEnd().split('\n')[4]);
    assert.deepEqual(cells.slice(1, 3), ['-', '-']);
  });
});

describe('archive read-back (rows 15, 14)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-relmap-')); });
  afterEach(() => { cleanup(tmp); });

  test('a milestone archived without a map reads back as "no map", not an error', () => {
    assert.deepEqual(readArchivedReleaseMap(tmp, 'v1.0'), { ok: true, map: null });
  });

  test('a missing milestones directory also reads back as "no map"', () => {
    assert.deepEqual(readArchivedReleaseMap(path.join(tmp, 'absent'), 'v1.0'), { ok: true, map: null });
  });

  test('round-trips the recorded value', () => {
    const validated = validateReleaseMap([entry(), entry({ repo: 'gone', release: null, status: 'unreleased', tag: 'none' })]);
    assert.equal(validated.ok, true);
    fs.writeFileSync(releaseMapArchivePath(tmp, 'v1.0'), serializeReleaseMapArchive('v1.0', validated.map));
    const read = readArchivedReleaseMap(tmp, 'v1.0');
    assert.deepEqual(read, { ok: true, map: validated.map });
    assert.equal(JSON.parse(fs.readFileSync(releaseMapArchivePath(tmp, 'v1.0'), 'utf8')).version, 'v1.0');
  });

  test('a corrupt archive is reported, not guessed at', () => {
    fs.writeFileSync(releaseMapArchivePath(tmp, 'v1.0'), '{not json');
    const read = readArchivedReleaseMap(tmp, 'v1.0');
    assert.equal(read.ok, false);
    assert.ok(read.error.length > 0);
  });

  test('loadReleaseMapFile refuses a directory and a missing path', () => {
    assert.equal(loadReleaseMapFile(tmp).ok, false);
    assert.equal(loadReleaseMapFile(path.join(tmp, 'missing.json')).ok, false);
  });

  test('loadReleaseMapFile refuses a file over 1 MiB and accepts one at the limit of validity', () => {
    const big = path.join(tmp, 'big.json');
    fs.writeFileSync(big, `[${' '.repeat(1048577)}]`);
    const refused = loadReleaseMapFile(big);
    assert.equal(refused.ok, false);
    assert.match(refused.errors[0], /maximum is 1048576/);
    const ok = path.join(tmp, 'ok.json');
    fs.writeFileSync(ok, JSON.stringify([entry()]));
    assert.equal(loadReleaseMapFile(ok).ok, true);
  });
});

describe('parity: enums, docs and glossary (row 19)', () => {
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'CONFIGURATION.md'), 'utf8');
  const context = fs.readFileSync(path.join(ROOT, 'CONTEXT.md'), 'utf8');

  function listedValues(text, label) {
    const re = new RegExp(`${label}:\\s*((?:\`[a-z_]+\`(?:,\\s*)?(?:or\\s+)?)+)`, 'i');
    const match = text.match(re);
    assert.ok(match, `${label} list not found`);
    return [...match[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  }

  test('statuses and tag states match docs/CONFIGURATION.md', () => {
    assert.deepEqual(listedValues(docs, 'Release map statuses').sort(), [...RELEASE_MAP_STATUSES].sort());
    assert.deepEqual(listedValues(docs, 'Release map tag states').sort(), [...RELEASE_MAP_TAG_STATES].sort());
  });

  test('statuses and tag states match the CONTEXT.md glossary entry', () => {
    assert.deepEqual(listedValues(context, 'Release map statuses').sort(), [...RELEASE_MAP_STATUSES].sort());
    assert.deepEqual(listedValues(context, 'Release map tag states').sort(), [...RELEASE_MAP_TAG_STATES].sort());
  });

  test('the repo_tagging default in the defaults manifest is single and docs/CONFIGURATION.md lists both modes', () => {
    const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'gsd-core', 'bin', 'shared', 'config-defaults.manifest.json'), 'utf8'));
    assert.equal(defaults.git.repo_tagging, 'single');
    const rowMatch = /^[^\r\n]{0,2000}`git\.repo_tagging`[^\r\n]{0,2000}$/m.exec(docs);
    assert.ok(rowMatch, 'docs/CONFIGURATION.md must carry a git.repo_tagging row');
    assert.ok(rowMatch[0].includes('`single`') && rowMatch[0].includes('`per_repo`'), 'the row must list both modes');
  });
});

describe('properties (rows 17, 18)', () => {
  const FC = { seed: 5706, numRuns: 100 };
  const anyText = fc.string({ maxLength: MAX_RELEASE_MAP_FIELD_LENGTH });
  const optionalText = fc.option(anyText, { nil: null });
  const entryArb = fc.record({
    repo: fc.string({ minLength: 1, maxLength: MAX_RELEASE_MAP_FIELD_LENGTH }).filter((s) => s.trim() !== ''),
    release: optionalText,
    reference: optionalText,
    environment: optionalText,
    status: fc.constantFrom(...RELEASE_MAP_STATUSES),
    tag: fc.constantFrom(...RELEASE_MAP_TAG_STATES),
  });
  const mapArb = fc.uniqueArray(entryArb, { selector: (e) => e.repo, maxLength: 12 });

  test('fc: validate -> JSON roundtrip is identity and render keeps one row per entry', () => {
    fc.assert(
      fc.property(mapArb, (generated) => {
        // fast-check builds records with a null prototype; deepEqual compares prototypes.
        const map = generated.map((e) => ({ ...e }));
        const validated = validateReleaseMap(map);
        assert.equal(validated.ok, true);
        assert.deepEqual(validated.map, map);
        const roundtrip = JSON.parse(serializeReleaseMapArchive('v9', validated.map));
        assert.deepEqual(roundtrip.entries, map);
        assert.deepEqual(validateReleaseMap(roundtrip.entries), { ok: true, map });
        const md = renderReleaseMapMarkdown(validated.map);
        assert.equal(md.trimEnd().split('\n').length, 4 + map.length);
      }),
      FC,
    );
  });

  test('fc: render never breaks the table (exactly 6 cells per row)', () => {
    fc.assert(
      fc.property(fc.record({ repo: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim() !== ''), release: fc.string({ maxLength: 40 }), reference: fc.string({ maxLength: 40 }), environment: fc.string({ maxLength: 40 }) }), (e) => {
        const md = renderReleaseMapMarkdown([{ ...e, status: 'released', tag: 'none' }]);
        const lines = md.trimEnd().split('\n');
        assert.equal(lines.length, 5, 'one line per row regardless of content');
        assert.equal(cellsOf(lines[4]).length, 6);
        assert.ok(!lines[4].includes('<'), 'raw angle brackets never survive');
      }),
      FC,
    );
  });
});
