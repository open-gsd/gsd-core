'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

const { cleanup } = require('./helpers.cjs');
const { compact, INCLUDE_GLOBS, EXCLUDE_GLOBS } = require('../scripts/ci-compact-v8-coverage.cjs');

function script(cwd, rel, count) {
  return {
    scriptId: '1',
    url: pathToFileURL(path.join(cwd, rel)).href,
    functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 10, count }] }],
  };
}

// fileURLToPath, not URL#pathname ("/C:/..." on Windows); POSIX separators.
const relOf = (cwd, url) => path.relative(cwd, fileURLToPath(url)).split(path.sep).join('/');
function withFixture(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-compact-'));
  try {
    fs.mkdirSync(path.join(cwd, 'raw'));
    fn(cwd);
  } finally {
    cleanup(cwd);
  }
}

test('compaction keeps only gate-reportable files and sums counts across dumps', () => {
  withFixture((cwd) => {
    const dumps = [
      [script(cwd, 'gsd-core/bin/lib/a.cjs', 1), script(cwd, 'tests/a.test.cjs', 1), { scriptId: '2', url: 'node:fs', functions: [] }],
      [script(cwd, 'gsd-core/bin/lib/a.cjs', 2), script(cwd, 'scripts/b.cjs', 1), script(cwd, 'node_modules/x/index.js', 1)],
    ];
    dumps.forEach((result, i) => fs.writeFileSync(path.join(cwd, 'raw', `d${i}.json`), JSON.stringify({ result })));
    fs.writeFileSync(path.join(cwd, 'raw', 'junk.json'), '{not json');

    const out = path.join(cwd, 'out', 'c.json');
    const stats = compact({ tempDirectory: path.join(cwd, 'raw'), outFile: out, cwd });
    assert.equal(stats.inputFiles, 2);

    const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
    const byUrl = new Map(merged.result.map((s) => [relOf(cwd, s.url), s]));
    assert.deepEqual([...byUrl.keys()].sort(), ['gsd-core/bin/lib/a.cjs', 'scripts/b.cjs']);
    assert.equal(byUrl.get('gsd-core/bin/lib/a.cjs').functions[0].ranges[0].count, 3);
  });
});

test('compacting an empty temp directory yields an empty, valid dump', () => {
  withFixture((cwd) => {
    const out = path.join(cwd, 'out', 'c.json');
    compact({ tempDirectory: path.join(cwd, 'raw'), outFile: out, cwd });
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).result, []);
  });
});

test("retained globs equal the union of the gate scripts' c8 --include / --exclude globs", () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const globsOf = (cmd, flag) => [...cmd.matchAll(new RegExp(`--${flag} '([^']+)'`, 'g'))].map((m) => m[1]);
  const gateCmds = [scripts['test:coverage:report'], scripts['test:coverage:scripts-floor']];
  const includes = new Set(gateCmds.flatMap((c) => globsOf(c, 'include')));
  assert.deepEqual([...includes].sort(), [...INCLUDE_GLOBS].sort());
  for (const cmd of gateCmds) assert.deepEqual(globsOf(cmd, 'exclude'), EXCLUDE_GLOBS);
});

test("compaction retains included files that istanbul's default exclude would drop (c8's explicit --exclude replaces the defaults)", () => {
  withFixture((cwd) => {
    const result = [
      script(cwd, 'scripts/foo-test.cjs', 1),
      script(cwd, 'scripts/bar.test.cjs', 1),
      script(cwd, 'gsd-core/bin/lib/__tests__/x.cjs', 1),
      script(cwd, 'gsd-core/bin/lib/a.cjs', 1),
      script(cwd, 'tests/t.cjs', 1),
    ];
    fs.writeFileSync(path.join(cwd, 'raw', 'd0.json'), JSON.stringify({ result }));

    const out = path.join(cwd, 'out', 'c.json');
    compact({ tempDirectory: path.join(cwd, 'raw'), outFile: out, cwd });

    const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
    const rels = merged.result.map((s) => relOf(cwd, s.url));
    assert.deepEqual(rels.sort(), [
      'gsd-core/bin/lib/__tests__/x.cjs',
      'gsd-core/bin/lib/a.cjs',
      'scripts/bar.test.cjs',
      'scripts/foo-test.cjs',
    ]);
  });
});

test('compaction skips JSON that is not a coverage dump', () => {
  withFixture((cwd) => {
    fs.writeFileSync(path.join(cwd, 'raw', 'a.json'), '[]');
    fs.writeFileSync(path.join(cwd, 'raw', 'b.json'), '0');
    fs.writeFileSync(path.join(cwd, 'raw', 'c.json'), 'null');
    fs.writeFileSync(path.join(cwd, 'raw', 'd.json'), '{}');
    fs.writeFileSync(path.join(cwd, 'raw', 'e.json'), JSON.stringify({ result: [script(cwd, 'scripts/b.cjs', 1)] }));

    const out = path.join(cwd, 'out', 'c.json');
    const stats = compact({ tempDirectory: path.join(cwd, 'raw'), outFile: out, cwd });
    assert.equal(stats.inputFiles, 1);

    const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
    const rels = merged.result.map((s) => relOf(cwd, s.url));
    assert.deepEqual(rels, ['scripts/b.cjs']);
  });
});
