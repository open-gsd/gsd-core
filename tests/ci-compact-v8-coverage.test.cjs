'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');

const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');
const { BUILD_TIMEOUT_MS, SEAM_DEFAULT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { compact, parseArgs, INCLUDE_GLOBS, EXCLUDE_GLOBS } = require('../scripts/ci-compact-v8-coverage.cjs');

function scriptCoverage(cwd, rel, count) {
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
      [scriptCoverage(cwd, 'gsd-core/bin/lib/a.cjs', 1), scriptCoverage(cwd, 'tests/a.test.cjs', 1), { scriptId: '2', url: 'node:fs', functions: [] }],
      [scriptCoverage(cwd, 'gsd-core/bin/lib/a.cjs', 2), scriptCoverage(cwd, 'scripts/b.cjs', 1), scriptCoverage(cwd, 'node_modules/x/index.js', 1)],
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

test("compacting an empty temp directory throws (restores the upload step's no-files guard)", () => {
  withFixture((cwd) => {
    const out = path.join(cwd, 'out', 'c.json');
    assert.throws(() => compact({ tempDirectory: path.join(cwd, 'raw'), outFile: out, cwd }), /no V8 coverage dumps/);
  });
});

test('a temp directory holding only unparsable or non-dump JSON throws', () => {
  withFixture((cwd) => {
    fs.writeFileSync(path.join(cwd, 'raw', 'a.json'), '{not json');
    fs.writeFileSync(path.join(cwd, 'raw', 'b.json'), '[]');
    fs.writeFileSync(path.join(cwd, 'raw', 'c.json'), '{}');
    const out = path.join(cwd, 'out', 'c.json');
    assert.throws(() => compact({ tempDirectory: path.join(cwd, 'raw'), outFile: out, cwd }), /no V8 coverage dumps/);
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
      scriptCoverage(cwd, 'scripts/foo-test.cjs', 1),
      scriptCoverage(cwd, 'scripts/bar.test.cjs', 1),
      scriptCoverage(cwd, 'gsd-core/bin/lib/__tests__/x.cjs', 1),
      scriptCoverage(cwd, 'gsd-core/bin/lib/a.cjs', 1),
      scriptCoverage(cwd, 'tests/t.cjs', 1),
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
    fs.writeFileSync(path.join(cwd, 'raw', 'e.json'), JSON.stringify({ result: [scriptCoverage(cwd, 'scripts/b.cjs', 1)] }));

    const out = path.join(cwd, 'out', 'c.json');
    const stats = compact({ tempDirectory: path.join(cwd, 'raw'), outFile: out, cwd });
    assert.equal(stats.inputFiles, 1);

    const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
    const rels = merged.result.map((s) => relOf(cwd, s.url));
    assert.deepEqual(rels, ['scripts/b.cjs']);
  });
});

test('a non-file source-map-cache key throws, as c8 does', () => {
  withFixture((cwd) => {
    const dump = { result: [scriptCoverage(cwd, 'scripts/b.cjs', 1)], 'source-map-cache': { 'node:internal/x': {} } };
    fs.writeFileSync(path.join(cwd, 'raw', 'd0.json'), JSON.stringify(dump));
    const out = path.join(cwd, 'out', 'c.json');
    assert.throws(() => compact({ tempDirectory: path.join(cwd, 'raw'), outFile: out, cwd }));
  });
});

test('source-map-cache keeps only retained files', () => {
  withFixture((cwd) => {
    const keep = pathToFileURL(path.join(cwd, 'scripts/b.cjs')).href;
    const drop = pathToFileURL(path.join(cwd, 'tests/t.cjs')).href;
    const dump = { result: [scriptCoverage(cwd, 'scripts/b.cjs', 1)], 'source-map-cache': { [keep]: { a: 1 }, [drop]: { b: 2 } } };
    fs.writeFileSync(path.join(cwd, 'raw', 'd0.json'), JSON.stringify(dump));
    const out = path.join(cwd, 'out', 'c.json');
    compact({ tempDirectory: path.join(cwd, 'raw'), outFile: out, cwd });
    const cache = JSON.parse(fs.readFileSync(out, 'utf8'))['source-map-cache'];
    assert.deepEqual(Object.keys(cache), [keep]);
  });
});

test('parseArgs validates flag values at their boundaries', () => {
  const dflt = path.join('coverage', 'tmp');
  assert.ok(parseArgs([]).error);
  assert.ok(parseArgs(['--out']).error);
  assert.ok(parseArgs(['--out', '--temp-directory', 'x']).error);
  assert.deepEqual(parseArgs(['--out', 'o.json']), { tempDirectory: dflt, outFile: 'o.json' });
  assert.ok(parseArgs(['--out', 'o.json', '--temp-directory']).error);
  assert.deepEqual(parseArgs(['--temp-directory', 'd', '--out', 'o.json']), { tempDirectory: 'd', outFile: 'o.json' });
});

test("sharded compaction equals one-pass compaction (the gate's composition contract)", () => {
  const files = ['gsd-core/bin/lib/a.cjs', 'gsd-core/bin/lib/b.cjs', 'scripts/c.cjs', 'tests/t.cjs', 'node_modules/x/i.js'];
  const dumpArb = fc.array(fc.record({ file: fc.constantFrom(...files), count: fc.nat({ max: 50 }) }), { maxLength: 4 });
  const arbitrary = fc.tuple(fc.array(dumpArb, { minLength: 2, maxLength: 6 }), fc.nat());

  const canonical = (cwd, file) => {
    const { result } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return result
      .map((s) => [relOf(cwd, s.url), JSON.stringify(s.functions)])
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  };

  withFixture((cwd) => {
    let n = 0;
    fc.assert(
      fc.property(arbitrary, ([dumps, split]) => {
        const base = path.join(cwd, `s${n++}`);
        const at = (...p) => path.join(base, ...p);
        const cut = (split % (dumps.length - 1)) + 1;
        for (const dir of ['all', 'shardA', 'shardB', 'g']) fs.mkdirSync(at(dir), { recursive: true });
        dumps.forEach((entries, i) => {
          const body = JSON.stringify({ result: entries.map((e) => scriptCoverage(cwd, e.file, e.count)) });
          fs.writeFileSync(at('all', `d${i}.json`), body);
          fs.writeFileSync(at(i < cut ? 'shardA' : 'shardB', `d${i}.json`), body);
        });
        compact({ tempDirectory: at('all'), outFile: at('out', 'all.json'), cwd });
        compact({ tempDirectory: at('shardA'), outFile: at('cA', 'shard.json'), cwd });
        compact({ tempDirectory: at('shardB'), outFile: at('cB', 'shard.json'), cwd });
        fs.copyFileSync(at('cA', 'shard.json'), at('g', 'a.json'));
        fs.copyFileSync(at('cB', 'shard.json'), at('g', 'b.json'));
        compact({ tempDirectory: at('g'), outFile: at('out', 'gate.json'), cwd });
        assert.deepEqual(canonical(cwd, at('out', 'gate.json')), canonical(cwd, at('out', 'all.json')));
      }),
    );
  });
});

test('c8 report json-summary is identical over raw and compacted dumps', () => {
  withFixture((tmp) => {
    // V8 records real paths (macOS /private/var, Windows long names, not 8.3), so match them.
    const cwd = fs.realpathSync.native(tmp);
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), text);
    };
    write(
      'gsd-core/bin/lib/a.cjs',
      [
        "'use strict';",
        'function f(x) {',
        '  if (x > 5) {',
        "    return 'big';",
        '  } else {',
        "    return 'small';",
        '  }',
        '}',
        'module.exports = { f };',
        '',
      ].join('\n'),
    );
    write('gsd-core/bin/lib/never.cjs', "'use strict';\nmodule.exports = () => 1;\n");
    write('scripts/s.cjs', "'use strict';\nmodule.exports = () => 2;\n");
    write(
      'driver.cjs',
      "'use strict';\nconst a = require('./gsd-core/bin/lib/a.cjs');\nconst s = require('./scripts/s.cjs');\nconsole.log(a.f(Number(process.argv[2])), s());\n",
    );

    const rawDir = path.join(cwd, 'raw');
    for (const arg of ['1', '9']) {
      execFileSync(process.execPath, [path.join(cwd, 'driver.cjs'), arg], {
        cwd,
        timeout: BUILD_TIMEOUT_MS,
        env: { ...process.env, NODE_V8_COVERAGE: rawDir },
        stdio: 'pipe',
      });
    }
    const compactedDir = path.join(cwd, 'compacted');
    compact({ tempDirectory: rawDir, outFile: path.join(compactedDir, 'shard.json'), cwd });

    const c8Bin = require.resolve('c8/bin/c8.js');
    const summaryFor = (tempDir, reportsDir) => {
      execFileSync(
        process.execPath,
        [
          c8Bin, 'report', '--reporter', 'json-summary', '--merge-async',
          '--include', 'gsd-core/bin/lib/**/*.cjs', '--include', 'scripts/**/*.cjs',
          '--exclude', 'tests/**', '--all',
          '--temp-directory', tempDir, '--reports-dir', reportsDir,
        ],
        { cwd, timeout: SEAM_DEFAULT_TIMEOUT_MS, stdio: 'pipe' },
      );
      const summary = JSON.parse(fs.readFileSync(path.join(reportsDir, 'coverage-summary.json'), 'utf8'));
      const bases = [fs.realpathSync(cwd), cwd].map((b) => b.split(path.sep).join('/'));
      const relKey = (key) => {
        const norm = key.split(path.sep).join('/');
        const base = bases.find((b) => norm.startsWith(`${b}/`));
        return base ? norm.slice(base.length + 1) : norm;
      };
      return Object.fromEntries(Object.entries(summary).map(([k, v]) => [relKey(k), v]));
    };

    const fromRaw = summaryFor(rawDir, path.join(cwd, 'rep-raw'));
    const fromCompacted = summaryFor(compactedDir, path.join(cwd, 'rep-compacted'));
    assert.ok(fromRaw['gsd-core/bin/lib/never.cjs'], '--all must report the never-executed file');
    assert.deepEqual(fromCompacted, fromRaw);
  });
});
