'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');

const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');
const { compact, parseArgs, INCLUDE_GLOBS, EXCLUDE_GLOBS, MERGE_BATCH_SIZE } = require('../scripts/ci-compact-v8-coverage.cjs');

function scriptCoverage(cwd, rel, count, isBlockCoverage = true) {
  return {
    scriptId: '1',
    url: pathToFileURL(path.join(cwd, rel)).href,
    functions: [{ functionName: '', isBlockCoverage, ranges: [{ startOffset: 0, endOffset: 10, count }] }],
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

async function withFixtureAsync(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-compact-'));
  try {
    fs.mkdirSync(path.join(cwd, 'raw'));
    await fn(cwd);
  } finally {
    cleanup(cwd);
  }
}

const canonical = (cwd, file) => {
  const { result } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return result
    .map((s) => [
      relOf(cwd, s.url),
      JSON.stringify(
        s.functions.map((f) => ({
          functionName: f.functionName,
          isBlockCoverage: f.isBlockCoverage,
          ranges: f.ranges.map((r) => ({ startOffset: r.startOffset, endOffset: r.endOffset, count: r.count })),
        })),
      ),
    ])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
};

// Per-offset execution counts, the contract merge grouping preserves. Ranges are painted in array order
// (normalized pre-order: outer before inner, so inner ranges overwrite). Zero counts are kept: v8-to-istanbul
// marks a line uncovered only through a zero-count range, so a lost never-called function must show up here.
const offsetCounts = (cwd, file) => {
  const { result } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return result
    .map((s) => {
      const painted = new Map();
      for (const f of s.functions) {
        for (const r of f.ranges) {
          for (let o = r.startOffset; o < r.endOffset; o++) painted.set(o, r.count);
        }
      }
      const counts = [...painted].sort((x, y) => x[0] - y[0]);
      return [relOf(cwd, s.url), counts];
    })
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
};

// Multi-range generators (a superset of V8 output: they also emit shapes V8 normalization never would). Function slot i owns root [i*100, i*100+90]; block-level functions add two
// sibling blocks and optionally a block nested in the first. Counts are small so equal sums (ties) are frequent.
const genFiles = ['gsd-core/bin/lib/a.cjs', 'gsd-core/bin/lib/b.cjs', 'scripts/c.cjs', 'tests/t.cjs', 'node_modules/x/i.js'];
const countArb = fc.nat({ max: 6 });
const v8Function = (slot, shape) => {
  const root = slot * 100;
  const functionName = `fn${slot}`;
  if (shape === null) {
    // NODE_V8_COVERAGE collects detailed (block) coverage, so V8 reports isBlockCoverage:false only for a function it never compiled, which is never called: one range, count 0. Mixed inputs outside this invariant are not something V8 produces, and @bcoe/v8-coverage's block-over-function preference would drop the function-level counts.
    return { functionName, isBlockCoverage: false, ranges: [{ startOffset: root, endOffset: root + 90, count: 0 }] };
  }
  const ranges = [
    { startOffset: root, endOffset: root + 90, count: shape.rootCount },
    { startOffset: root + 10, endOffset: root + 30, count: shape.ifCount },
  ];
  if (shape.nestedCount !== null) ranges.push({ startOffset: root + 12, endOffset: root + 20, count: shape.nestedCount });
  ranges.push({ startOffset: root + 30, endOffset: root + 50, count: shape.elseCount });
  return { functionName, isBlockCoverage: true, ranges };
};
const shapeArb = fc.oneof(
  fc.constant(null),
  fc.record({ rootCount: countArb, ifCount: countArb, elseCount: countArb, nestedCount: fc.option(countArb, { nil: null }) }),
);
const fileCoverageArb = fc
  .tuple(fc.constantFrom(...genFiles), fc.array(shapeArb, { minLength: 1, maxLength: 3 }))
  .map(([file, shapes]) => ({ file, functions: shapes.map((shape, slot) => v8Function(slot, shape)) }));
const multiRangeDumpArb = fc.uniqueArray(fileCoverageArb, { minLength: 1, maxLength: 2, selector: (s) => s.file });
const dumpBody = (cwd, dump) =>
  JSON.stringify({
    result: dump.map((s) => ({ scriptId: '1', url: pathToFileURL(path.join(cwd, s.file)).href, functions: s.functions })),
  });

async function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
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

test('a never-called function has no block flag whatever the dump count (#5985 parity quirk)', () => {
  withFixture((cwd) => {
    for (const n of [1, 2, 3]) {
      const dir = path.join(cwd, `n${n}`);
      fs.mkdirSync(dir);
      const url = pathToFileURL(path.join(cwd, 'gsd-core/bin/lib/a.cjs')).href;
      for (let i = 0; i < n; i++) {
        const never = { functionName: 'f', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 10, count: 0 }] };
        const called = { functionName: 'g', isBlockCoverage: true, ranges: [{ startOffset: 20, endOffset: 30, count: 2 }] };
        fs.writeFileSync(path.join(dir, `d${i}.json`), JSON.stringify({ result: [{ scriptId: '1', url, functions: [never, called] }] }));
      }
      const out = path.join(cwd, `out${n}`, 'c.json');
      compact({ tempDirectory: dir, outFile: out, cwd });
      const fns = JSON.parse(fs.readFileSync(out, 'utf8')).result[0].functions;
      assert.equal(fns.find((f) => f.functionName === 'f').isBlockCoverage, false, `never-called, ${n} dumps`);
      assert.equal(fns.find((f) => f.functionName === 'g').isBlockCoverage, true, `called, ${n} dumps`);
    }
  });
});

test("sharded compaction preserves the one-pass per-offset counts (the gate's composition contract)", () => {
  const arbitrary = fc.tuple(fc.array(multiRangeDumpArb, { minLength: 2, maxLength: 6 }), fc.nat());

  withFixture((cwd) => {
    let n = 0;
    fc.assert(
      fc.property(arbitrary, ([dumps, split]) => {
        const base = path.join(cwd, `s${n++}`);
        const at = (...p) => path.join(base, ...p);
        const cut = (split % (dumps.length - 1)) + 1;
        for (const dir of ['all', 'shardA', 'shardB', 'g']) fs.mkdirSync(at(dir), { recursive: true });
        dumps.forEach((dump, i) => {
          const body = dumpBody(cwd, dump);
          fs.writeFileSync(at('all', `d${i}.json`), body);
          fs.writeFileSync(at(i < cut ? 'shardA' : 'shardB', `d${i}.json`), body);
        });
        compact({ tempDirectory: at('all'), outFile: at('out', 'all.json'), cwd });
        compact({ tempDirectory: at('shardA'), outFile: at('cA', 'shard.json'), cwd });
        compact({ tempDirectory: at('shardB'), outFile: at('cB', 'shard.json'), cwd });
        fs.copyFileSync(at('cA', 'shard.json'), at('g', 'a.json'));
        fs.copyFileSync(at('cB', 'shard.json'), at('g', 'b.json'));
        compact({ tempDirectory: at('g'), outFile: at('out', 'gate.json'), cwd });
        assert.deepEqual(offsetCounts(cwd, at('out', 'gate.json')), offsetCounts(cwd, at('out', 'all.json')));
      }),
    );
  });
});

test('c8 report json-summary is identical over raw and compacted dumps', async () => {
  await withFixtureAsync(async (tmp) => {
    // V8 records real paths (macOS /private/var, Windows long names, not 8.3), so match them.
    const cwd = fs.realpathSync.native(tmp);
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), text);
    };
    const aSrc = [
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
    ].join('\n');
    const sSrc = "'use strict';\nmodule.exports = () => 2;\n";
    write('gsd-core/bin/lib/a.cjs', aSrc);
    write('gsd-core/bin/lib/never.cjs', "'use strict';\nmodule.exports = () => 1;\n");
    write('scripts/s.cjs', sSrc);

    // Offsets come from the written text, never hardcoded.
    const fStart = aSrc.indexOf('function f');
    const fEnd = aSrc.indexOf('\n}\n', fStart) + 2;
    const ifOpen = aSrc.indexOf('{', aSrc.indexOf('if (x > 5) '));
    const ifEnd = aSrc.indexOf('}', ifOpen) + 1;
    const elseOpen = aSrc.indexOf('{', aSrc.indexOf('else '));
    const elseEnd = aSrc.indexOf('}', elseOpen) + 1;
    const urlOf = (rel) => pathToFileURL(path.join(cwd, rel)).href;
    const whole = (len, count) => ({ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: len, count }] });
    const dump = (n, b, e) => ({
      result: [
        {
          scriptId: '1',
          url: urlOf('gsd-core/bin/lib/a.cjs'),
          functions: [
            whole(aSrc.length, 1),
            {
              functionName: 'f',
              isBlockCoverage: true,
              ranges: [
                { startOffset: fStart, endOffset: fEnd, count: n },
                { startOffset: ifOpen, endOffset: ifEnd, count: b },
                { startOffset: elseOpen, endOffset: elseEnd, count: e },
              ],
            },
          ],
        },
        { scriptId: '2', url: urlOf('scripts/s.cjs'), functions: [whole(sSrc.length, 1)] },
        { scriptId: '3', url: urlOf('tests/t.cjs'), functions: [whole(10, 1)] },
        { scriptId: '9', url: 'node:fs', functions: [] },
      ],
      'source-map-cache': {},
    });

    const rawDir = path.join(cwd, 'raw');
    fs.writeFileSync(path.join(rawDir, 'coverage-1.json'), JSON.stringify(dump(1, 0, 1)));
    fs.writeFileSync(path.join(rawDir, 'coverage-2.json'), JSON.stringify(dump(2, 2, 0)));
    const compactedDir = path.join(cwd, 'compacted');
    compact({ tempDirectory: rawDir, outFile: path.join(compactedDir, 'shard.json'), cwd });

    const c8Require = createRequire(require.resolve('c8/package.json'));
    const Report = c8Require('./lib/report.js');
    const defaultExtension = c8Require('@istanbuljs/schema/default-extension');
    const summaryFor = async (tempDir, reportsDir) => {
      await inDir(cwd, async () => {
        // Same option set c8/lib/commands/report.js builds from argv; values are the CLI defaults plus the gate's flags.
        const report = Report({
          include: ['gsd-core/bin/lib/**/*.cjs', 'scripts/**/*.cjs'],
          exclude: ['tests/**'],
          extension: defaultExtension,
          excludeAfterRemap: false,
          reporter: ['json-summary'],
          reportsDirectory: reportsDir,
          reporterOptions: {},
          tempDirectory: tempDir,
          watermarks: undefined,
          resolve: '',
          omitRelative: true,
          wrapperLength: undefined,
          all: true,
          allowExternal: false,
          src: undefined,
          skipFull: false,
          excludeNodeModules: true,
          mergeAsync: true,
          monocartArgv: null,
        });
        await report.run();
      });
      const summary = JSON.parse(fs.readFileSync(path.join(reportsDir, 'coverage-summary.json'), 'utf8'));
      const bases = [fs.realpathSync(cwd), cwd].map((b) => b.split(path.sep).join('/'));
      const relKey = (key) => {
        const norm = key.split(path.sep).join('/');
        const base = bases.find((b) => norm.startsWith(`${b}/`));
        return base ? norm.slice(base.length + 1) : norm;
      };
      return Object.fromEntries(Object.entries(summary).map(([k, v]) => [relKey(k), v]));
    };

    const fromRaw = await summaryFor(rawDir, path.join(cwd, 'rep-raw'));
    const fromCompacted = await summaryFor(compactedDir, path.join(cwd, 'rep-compacted'));
    assert.ok(fromRaw['gsd-core/bin/lib/never.cjs'], '--all must report the never-executed file');
    assert.ok(fromRaw['gsd-core/bin/lib/a.cjs'].branches.total > 0, 'fixture must exercise branch coverage');
    assert.deepEqual(fromCompacted, fromRaw);
  });
});

const realMerge = createRequire(require.resolve('c8/package.json'))('@bcoe/v8-coverage').mergeProcessCovs;

test('compaction folds dumps into the accumulator in bounded batches instead of holding every dump (#6140)', () => {
  withFixture((cwd) => {
    for (let i = 0; i < 13; i++) {
      const result = [scriptCoverage(cwd, 'gsd-core/bin/lib/a.cjs', i + 1), scriptCoverage(cwd, 'scripts/b.cjs', 1)];
      fs.writeFileSync(path.join(cwd, 'raw', `d${String(i).padStart(2, '0')}.json`), JSON.stringify({ result }));
    }
    const sizes = [];
    const out = path.join(cwd, 'out', 'c.json');
    compact({
      tempDirectory: path.join(cwd, 'raw'),
      outFile: out,
      cwd,
      batchSize: 4,
      mergeProcessCovs: (inputs) => {
        sizes.push(inputs.length);
        return realMerge(inputs);
      },
    });
    assert.deepEqual(sizes, [4, 5, 5, 2]);
    const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
    const byUrl = new Map(merged.result.map((s) => [relOf(cwd, s.url), s]));
    assert.equal(byUrl.get('gsd-core/bin/lib/a.cjs').functions[0].ranges[0].count, 91);
    assert.equal(byUrl.get('scripts/b.cjs').functions[0].ranges[0].count, 13);
  });
});

test('batch boundaries: batchSize-1, batchSize and batchSize+1 dumps (#6140)', () => {
  withFixture((cwd) => {
    const expectedCalls = { 3: 1, 4: 1, 5: 2 };
    for (const n of [3, 4, 5]) {
      const dir = path.join(cwd, `n${n}`);
      fs.mkdirSync(dir);
      for (let i = 0; i < n; i++) {
        const result = [scriptCoverage(cwd, 'gsd-core/bin/lib/a.cjs', i + 1), scriptCoverage(cwd, 'scripts/b.cjs', 2)];
        fs.writeFileSync(path.join(dir, `d${i}.json`), JSON.stringify({ result }));
      }
      let calls = 0;
      const batched = path.join(cwd, `out-b${n}`, 'c.json');
      compact({
        tempDirectory: dir,
        outFile: batched,
        cwd,
        batchSize: 4,
        mergeProcessCovs: (inputs) => {
          calls++;
          return realMerge(inputs);
        },
      });
      assert.equal(calls, expectedCalls[n], `merge calls for ${n} dumps`);
      const onePass = path.join(cwd, `out-o${n}`, 'c.json');
      compact({ tempDirectory: dir, outFile: onePass, cwd, batchSize: n });
      assert.deepEqual(canonical(cwd, batched), canonical(cwd, onePass), `${n} dumps`);
    }
  });
});

test('batched compaction preserves every per-offset count of the one-pass merge, for any batch size (#6140)', () => {
  const arbitrary = fc.tuple(fc.array(multiRangeDumpArb, { minLength: 1, maxLength: 9 }), fc.integer({ min: 1, max: 8 }));
  withFixture((cwd) => {
    let n = 0;
    fc.assert(
      fc.property(arbitrary, ([dumps, batchSize]) => {
        const base = path.join(cwd, `p${n++}`);
        const dir = path.join(base, 'all');
        fs.mkdirSync(dir, { recursive: true });
        dumps.forEach((dump, i) => {
          fs.writeFileSync(path.join(dir, `d${String(i).padStart(2, '0')}.json`), dumpBody(cwd, dump));
        });
        const batched = path.join(base, 'out', 'batched.json');
        const onePass = path.join(base, 'out', 'one.json');
        compact({ tempDirectory: dir, outFile: batched, cwd, batchSize });
        compact({ tempDirectory: dir, outFile: onePass, cwd, batchSize: dumps.length });
        assert.deepEqual(offsetCounts(cwd, batched), offsetCounts(cwd, onePass));
      }),
    );
  });
});

test('merge grouping may change range structure but never a per-offset count (#6140)', () => {
  withFixture((cwd) => {
    // Sibling blocks end up with equal summed counts after the first merge, so normalization joins them and a
    // later merge wraps them in a synthetic range. If @bcoe/v8-coverage ever becomes associative, the canonical()
    // inequality below fails: revisit the exactness paragraph in scripts/ci-compact-v8-coverage.cjs.
    const dumps = [
      { root: 5, ifCount: 3, elseCount: 2 },
      { root: 5, ifCount: 2, elseCount: 3 },
      { root: 1, ifCount: 0, elseCount: 1 },
    ];
    dumps.forEach((d, i) => {
      const functions = [
        {
          functionName: 'f',
          isBlockCoverage: true,
          ranges: [
            { startOffset: 0, endOffset: 100, count: d.root },
            { startOffset: 10, endOffset: 30, count: d.ifCount },
            { startOffset: 30, endOffset: 50, count: d.elseCount },
          ],
        },
      ];
      const url = pathToFileURL(path.join(cwd, 'scripts/a.cjs')).href;
      fs.writeFileSync(path.join(cwd, 'raw', `d${i}.json`), JSON.stringify({ result: [{ scriptId: '1', url, functions }] }));
    });
    const run = (batchSize) => {
      const out = path.join(cwd, `out${batchSize}`, 'c.json');
      compact({ tempDirectory: path.join(cwd, 'raw'), outFile: out, cwd, batchSize });
      return out;
    };
    const three = run(3);
    const two = run(2);
    assert.notDeepEqual(canonical(cwd, three), canonical(cwd, two));
    assert.deepEqual(offsetCounts(cwd, three), offsetCounts(cwd, two));
  });
});

test('batchSize must be a positive integer', () => {
  withFixture((cwd) => {
    fs.writeFileSync(path.join(cwd, 'raw', 'd0.json'), JSON.stringify({ result: [scriptCoverage(cwd, 'scripts/b.cjs', 1)] }));
    const run = (batchSize) => compact({ tempDirectory: path.join(cwd, 'raw'), outFile: path.join(cwd, 'out', 'c.json'), cwd, batchSize });
    for (const bad of [0, -1, 1.5, NaN, '4']) assert.throws(() => run(bad), RangeError, `batchSize ${String(bad)}`);
    assert.doesNotThrow(() => run(1));
  });
});

test('the default batch size folds MERGE_BATCH_SIZE-1 and MERGE_BATCH_SIZE dumps in one merge and one more dump in a second (#6140)', () => {
  withFixture((cwd) => {
    const expectedCalls = { [MERGE_BATCH_SIZE - 1]: 1, [MERGE_BATCH_SIZE]: 1, [MERGE_BATCH_SIZE + 1]: 2 };
    for (const n of [MERGE_BATCH_SIZE - 1, MERGE_BATCH_SIZE, MERGE_BATCH_SIZE + 1]) {
      const dir = path.join(cwd, `n${n}`);
      fs.mkdirSync(dir);
      for (let i = 0; i < n; i++) {
        fs.writeFileSync(path.join(dir, `d${String(i).padStart(3, '0')}.json`), JSON.stringify({ result: [scriptCoverage(cwd, 'scripts/b.cjs', 1)] }));
      }
      let calls = 0;
      const out = path.join(cwd, `out${n}`, 'c.json');
      compact({
        tempDirectory: dir,
        outFile: out,
        cwd,
        mergeProcessCovs: (inputs) => {
          calls++;
          return realMerge(inputs);
        },
      });
      assert.equal(calls, expectedCalls[n], `${n} dumps`);
      assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).result[0].functions[0].ranges[0].count, n);
    }
  });
});
