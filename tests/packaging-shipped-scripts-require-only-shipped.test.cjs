// allow-test-rule: integration-test-input (see #2858)
// #2858 — class-extinction guard: every shipped scripts/**/*.cjs must be
// require-able using only shipped paths. A script that ships in the npm tarball
// but requires a module from tests/ (which does not ship) is MODULE_NOT_FOUND
// at load time in a published install.
//
// This test statically checks each shipped .cjs's require() calls against the
// resolved tarball file list (the files npm pack would pack, read from the tree by
// tests/helpers/pack-file-list.cjs; no process is spawned, #6498), so adding a new entry
// to `files` cannot silently opt out. It does NOT execute the scripts — it parses
// their require() calls and resolves them against the shipped set.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTempDir, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');

const { extractRequires } = require('./helpers/copy-script-fixture.cjs');
const { listPackedFiles } = require('./helpers/pack-file-list.cjs');

/**
 * Pure projection from `npm pack --json` output to the tarball path set —
 * extracted so the SHAPE contract is unit-testable without running npm.
 */
function packListToPathSet(parsed) {
  // #3902: npm <=11 emits an ARRAY of pack results; npm 12 (bundled with
  // Node 26) emits an OBJECT keyed by package name. parsed[0] is undefined on
  // the object shape — which threw in this file's before() hook and silently
  // disabled the whole packaging guard, including both `does NOT ship`
  // assertions. Resolve either shape; anything else fails loud.
  // Single-package assumption: this repo has no workspaces, so npm 12 emits
  // exactly ONE key. If workspaces are ever adopted, first-key would silently
  // validate only one package — recreate the silent-disarm this fix kills —
  // so a multi-key object fails loud instead.
  let entry;
  if (Array.isArray(parsed)) {
    entry = parsed[0];
  } else {
    const keys = Object.keys(parsed);
    if (keys.length !== 1) {
      throw new Error(`npm pack --json emitted ${keys.length} package keys; expected exactly 1 for this single-package repo`);
    }
    entry = parsed[keys[0]];
  }
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(`npm pack --json returned an unrecognized shape: ${Object.prototype.toString.call(parsed)}`);
  }
  return new Set(entry.files.map((f) => f.path.replace(/\\/g, '/')));
}

/**
 * Classify a require specifier from a given file path:
 * - 'builtin'   — node: prefix or a Node builtin (fs, path, etc.)
 * - 'shipped'   — resolves to a file within the shipped tarball set
 * - 'external'  — an npm dependency (resolvable from node_modules)
 * - 'unshipped' — resolves to a repo path that is NOT in the shipped set (VIOLATION)
 */
function classifyRequire(spec, fromFile, shippedFiles) {
  // Node builtins (including node: prefix)
  if (spec.startsWith('node:')) return 'builtin';
  const BUILTINS = ['fs', 'path', 'os', 'child_process', 'crypto', 'util', 'url', 'events', 'stream', 'http', 'https', 'net', 'tls', 'zlib', 'querystring', 'string_decoder', 'timers', 'vm', 'worker_threads', 'buffer', 'process'];
  const bare = spec.split('/')[0];
  if (BUILTINS.includes(bare)) return 'builtin';

  // Relative/absolute requires — resolve against the file's directory
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const fromDir = path.dirname(fromFile);
    const resolved = path.posix.normalize(path.posix.join(fromDir, spec));
    // Try exact, .cjs, .js, .json, /index.cjs, /index.js
    const candidates = [
      resolved,
      resolved + '.cjs',
      resolved + '.js',
      resolved + '.json',
      resolved + '/index.cjs',
      resolved + '/index.js',
    ];
    for (const c of candidates) {
      const normalized = c.replace(/\\/g, '/');
      if (shippedFiles.has(normalized)) return 'shipped';
    }
    // If it resolves to a real file on disk but is NOT shipped → violation
    const absResolved = path.resolve(REPO_ROOT, resolved);
    const absCandidates = [
      absResolved,
      absResolved + '.cjs',
      absResolved + '.js',
      absResolved + '.json',
      path.join(absResolved, 'index.cjs'),
      path.join(absResolved, 'index.js'),
    ];
    for (const c of absCandidates) {
      if (fs.existsSync(c)) return 'unshipped';
    }
    // Doesn't resolve to anything — likely a typo or generated artifact; flag it
    return 'unshipped';
  }

  // Bare specifier (not relative, not builtin) → npm dependency
  return 'external';
}

describe('#2858 — shipped scripts require only shipped paths', () => {
  let shippedFiles;
  let shippedScripts;

  before(() => {
    shippedFiles = listPackedFiles(REPO_ROOT);
    // Filter to scripts/**/*.{cjs,js} (the shipped script surface — both .cjs
    // and .js files ship under scripts/, e.g. build-hooks.js is required by
    // bin/install.js). Both extensions are checked so a broken require() in a
    // .js file is caught just the same as one in a .cjs file.
    shippedScripts = [...shippedFiles]
      .filter((f) => f.startsWith('scripts/') && /\.(cjs|js)$/.test(f))
      .sort();
  });

  test('#2665: the test-instrumentation chain does not ship', () => {
    // These four are one closed require chain of test instrumentation
    // (run-tests -> live-config-guard, affected-tests-lib -> run-tests,
    // run-affected-tests -> affected-tests-lib). Excluding a strict subset
    // re-trips the shipped-requires-only-shipped gate above on whichever links
    // still ship, so the exclusion set and this assertion cover the chain.
    const TEST_INSTRUMENTATION = [
      'scripts/live-config-guard.cjs',
      'scripts/run-tests.cjs',
      'scripts/affected-tests-lib.cjs',
      'scripts/run-affected-tests.cjs',
    ];
    for (const f of TEST_INSTRUMENTATION) {
      assert.ok(
        !shippedFiles.has(f),
        `${f} is test instrumentation and must not ship — restore its ` +
          "package.json files[] '!'-exclusion (and keep the whole chain excluded)",
      );
    }
  });

  test('every shipped scripts/*.{cjs,js} is require-able from a shipped-only tree', () => {
    assert.ok(shippedScripts.length > 0, 'expected at least one shipped script');

    const violations = [];
    for (const scriptRel of shippedScripts) {
      const absPath = path.join(REPO_ROOT, scriptRel);
      if (!fs.existsSync(absPath)) continue; // generated artifact, skip
      const source = fs.readFileSync(absPath, 'utf-8');
      const requires = extractRequires(source);

      for (const spec of requires) {
        const classification = classifyRequire(spec, scriptRel, shippedFiles);
        if (classification === 'unshipped') {
          violations.push({
            script: scriptRel,
            require: spec,
            classification,
          });
        }
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map((v) => `  ${v.script}: require('${v.require}') → ${v.classification}`)
        .join('\n');
      assert.fail(
        `${violations.length} shipped script(s) require modules outside the shipped tree (MODULE_NOT_FOUND in a published install):\n${details}`,
      );
    }
  });

  test('gen-emitted-baseline.cjs does NOT ship (repo-only CI tooling)', () => {
    // This script requires ../tests/helpers/* which does not ship. It is
    // repo-only CI tooling (CI workflows + test fixtures spawn it from a
    // checkout). It must be excluded from the npm tarball.
    assert.ok(
      !shippedFiles.has('scripts/gen-emitted-baseline.cjs'),
      'scripts/gen-emitted-baseline.cjs must NOT ship — it requires tests/ which does not ship (#2858)',
    );
  });

  test('lint-no-adhoc-regex-escape.cjs does NOT ship (repo-only CI tooling)', () => {
    // This script requires ../eslint-rules/ which does not ship. It is
    // repo-only CI tooling. It must be excluded from the npm tarball (#3412).
    assert.ok(
      !shippedFiles.has('scripts/lint-no-adhoc-regex-escape.cjs'),
      'scripts/lint-no-adhoc-regex-escape.cjs must NOT ship — it requires ../eslint-rules/ which does not ship (#3412)',
    );
  });

  test('a script requiring a sibling in the same shipped dir resolves as shipped (positive case)', () => {
    // Sanity: scripts/lib/cli-exit.cjs ships and is required by shipped scripts.
    // This confirms the guard's positive path works — a valid intra-shipped require
    // is NOT flagged.
    assert.ok(shippedFiles.has('scripts/lib/cli-exit.cjs'), 'scripts/lib/cli-exit.cjs should ship');
    const classification = classifyRequire('./lib/cli-exit.cjs', 'scripts/gen-adr-index.cjs', shippedFiles);
    assert.strictEqual(classification, 'shipped',
      `a sibling require within scripts/ must classify as 'shipped'; got '${classification}'`);
  });
});


// ─── #3902: npm 12's pack --json shape must resolve like npm <=11's ──────────

describe('#3902 packListToPathSet resolves both npm pack --json shapes', () => {
  const FILES = [{ path: 'gsd-core/bin/gsd-tools.cjs' }, { path: 'lib/Backslash\\Case.cjs' }];

  test('npm <=11 array shape', () => {
    const set = packListToPathSet([{ files: FILES }]);
    assert.ok(set.has('gsd-core/bin/gsd-tools.cjs'));
    assert.ok(set.has('lib/Backslash/Case.cjs'), 'windows separators normalized');
  });

  test('npm 12 (Node 26) object-keyed shape', () => {
    // npm 12 emits { "<pkg-name>": { files: [...] } } — parsed[0] is undefined
    // there, which used to throw in the before() hook and silently disable
    // the whole packaging guard, including both `does NOT ship` assertions.
    const set = packListToPathSet({ '@opengsd/gsd-core': { files: FILES } });
    assert.ok(set.has('gsd-core/bin/gsd-tools.cjs'));
    assert.ok(set.has('lib/Backslash/Case.cjs'));
  });

  test('an unrecognized shape fails loud, never silently-empty', () => {
    assert.throws(() => packListToPathSet({ weird: true }));
  });

  test('a multi-key object (workspaces) fails loud — first-key would silently validate one package', () => {
    assert.throws(() => packListToPathSet({
      'pkg-a': { files: FILES },
      'pkg-b': { files: FILES },
    }), /exactly 1/);
  });
});

// ─── #6498: the in-process file list, planted trees ──────────────────────────

describe('#6498 listPackedFiles reads the tree instead of spawning npm', () => {
  const planted = (manifest, paths, fn) => {
    const tmp = createTempDir('gsd-pack-list-');
    try {
      fs.writeFileSync(path.join(tmp, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
      for (const rel of paths) {
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.writeFileSync(path.join(tmp, rel), 'x');
      }
      fn(tmp);
    } finally {
      cleanup(tmp);
    }
  };
  const sorted = (set) => [...set].sort();

  test('a directory entry packs everything under it, a "!" entry removes a file from it, and a planted file under an excluded path stays out', () => {
    planted(
      { files: ['scripts', '!scripts/repo-only.cjs', '!scripts/private'] },
      ['scripts/a.cjs', 'scripts/lib/b.cjs', 'scripts/repo-only.cjs', 'scripts/private/c.cjs', 'tests/t.cjs'],
      (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)), ['package.json', 'scripts/a.cjs', 'scripts/lib/b.cjs']);
      },
    );
  });

  test('a file entry packs that file only; an entry that matches nothing is skipped', () => {
    planted({ files: ['GEMINI.md', 'missing-dir'] }, ['GEMINI.md', 'other.md'], (tmp) => {
      assert.deepEqual(sorted(listPackedFiles(tmp)), ['GEMINI.md', 'package.json']);
    });
  });

  test('package.json, README*, LICENSE* and the main and bin files ship without a files entry', () => {
    planted(
      { files: ['hooks'], main: 'main.js', bin: { tool: 'tool.js' } },
      ['README.md', 'LICENSE', 'licence.txt', 'main.js', 'tool.js', 'other.js', 'CHANGELOG.md'],
      (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)),
          ['LICENSE', 'README.md', 'licence.txt', 'main.js', 'package.json', 'tool.js']);
      },
    );
  });

  test('the names npm excludes at any depth never pack, even inside a packed directory', () => {
    planted(
      { files: ['hooks'] },
      ['hooks/keep.js', 'hooks/.DS_Store', 'hooks/._keep.js', 'hooks/a.orig', 'hooks/.a.swp', 'hooks/.npmrc',
        'hooks/.lock-wscript', 'hooks/.wafpickle-1', 'hooks/npm-debug.log', 'hooks/.git/config', 'hooks/CVS/Entries'],
      (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)), ['hooks/keep.js', 'package.json']);
      },
    );
  });

  test('a nested lock file, a *.swp file without the leading dot and a config.gypi do pack, as npm packs them', () => {
    planted(
      { files: ['hooks'] },
      ['hooks/package-lock.json', 'hooks/yarn.lock', 'hooks/pnpm-lock.yaml', 'hooks/bun.lockb', 'hooks/foo.swp', 'hooks/config.gypi'],
      (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)), [
          'hooks/bun.lockb', 'hooks/config.gypi', 'hooks/foo.swp', 'hooks/package-lock.json', 'hooks/pnpm-lock.yaml',
          'hooks/yarn.lock', 'package.json',
        ]);
      },
    );
  });

  test('a root lock file or node_modules named in files does not pack, even though a named file otherwise does', () => {
    planted(
      { files: ['package-lock.json', 'yarn.lock', 'node_modules', 'keep.js'] },
      ['package-lock.json', 'yarn.lock', 'node_modules/dep/index.js', 'keep.js'],
      (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)), ['keep.js', 'package.json']);
      },
    );
  });

  test('a files entry that names a file packs it despite a default or a "!" directory rule', () => {
    planted(
      { files: ['hooks', 'foo.orig', '.DS_Store', '!hooks/sub'] },
      ['hooks/a.js', 'hooks/sub/other.js', 'foo.orig', '.DS_Store'],
      (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)), ['.DS_Store', 'foo.orig', 'hooks/a.js', 'package.json']);
      },
    );
  });

  test('a directory named like an excluded file, build/config.gypi and archived-packages are pruned at any depth', () => {
    planted(
      { files: ['hooks'] },
      ['hooks/a.js', 'hooks/._d/x.js', 'hooks/b.orig/x.js', 'hooks/.npmrc/x.js', 'hooks/npm-debug.log/x.js',
        'hooks/.DS_Store/x.js', 'hooks/.x.swp/y.js', 'hooks/build/config.gypi', 'hooks/archived-packages/x.js', 'hooks/.git', 'hooks/CVS'],
      (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)), ['hooks/a.js', 'package.json']);
      },
    );
  });

  test('README and LICENSE need a dot and a last character other than ~ or $ after the stem, as npm requires', () => {
    planted({ files: ['hooks'] }, ['README.', 'README.md~', 'README.md$', 'LICENSE.bak~', 'README.m', 'LICENSE.x', 'README'], (tmp) => {
      assert.deepEqual(sorted(listPackedFiles(tmp)), ['LICENSE.x', 'README', 'README.m', 'package.json']);
    });
  });

  test('every name rule and "!" entry matches case-insensitively, as npm does', () => {
    planted(
      { files: ['hooks', 'scripts', '!scripts/Foo.cjs'] },
      ['hooks/a.js', 'hooks/NPM-DEBUG.LOG', 'hooks/Cvs/x.js', 'hooks/x.ORIG', 'hooks/.DS_STORE', 'hooks/Archived-Packages/x.js',
        'hooks/.A.SWP', 'hooks/Build/Config.gypi', 'scripts/foo.cjs', 'scripts/ok.cjs'],
      (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)), ['hooks/a.js', 'package.json', 'scripts/ok.cjs']);
      },
    );
  });

  test('an editor swap file with an empty name between the dots is excluded, one without a leading dot is not', () => {
    planted({ files: ['hooks'] }, ['hooks/..swp', 'hooks/.a.swp', 'hooks/a.swp', 'hooks/a'], (tmp) => {
      assert.deepEqual(sorted(listPackedFiles(tmp)), ['hooks/a', 'hooks/a.swp', 'package.json']);
    });
  });

  test('a file named archived-packages packs, only a directory of that name is pruned', () => {
    planted({ files: ['hooks'] }, ['hooks/archived-packages', 'hooks/a.js', 'hooks/sub/archived-packages', 'hooks/dir/archived-packages/x.js'], (tmp) => {
      assert.deepEqual(sorted(listPackedFiles(tmp)), ['hooks/a.js', 'hooks/archived-packages', 'hooks/sub/archived-packages', 'package.json']);
    });
  });

  test('a named .npmrc does not pack, and a named root file does', () => {
    planted({ files: ['.npmrc', 'keep.js'] }, ['.npmrc', 'keep.js'], (tmp) => {
      assert.deepEqual(sorted(listPackedFiles(tmp)), ['keep.js', 'package.json']);
    });
  });

  test('a files entry naming a file below the root throws, because npm packs it by rules this list does not model', () => {
    for (const entry of ['ok/z.js', '._d/x.js', 'a/build/config.gypi', 'node_modules/x/y.js']) {
      planted({ files: [entry] }, [entry], (tmp) => assert.throws(() => listPackedFiles(tmp), /naming a file below the root|leaves|does not model/));
    }
  });

  test('a main or bin target under a directory a default matches, and an unsupported bin shape, throw', () => {
    for (const main of ['lib/._x/b.js', 'lib/x.orig/b.js', 'lib/.DS_Store/b.js', 'node_modules/p/i.js']) {
      planted({ files: ['hooks'], main }, [main], (tmp) => assert.throws(() => listPackedFiles(tmp), /under a directory a default exclusion matches/));
    }
    for (const bin of ['cli.js', ['a/cli.js', 'b/cli.js'], { 'sub/x': 'p.js' }, { '': 'x.js' }, { '..': 'x.js' }]) {
      planted({ files: ['hooks'], bin }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /bin" is not an object with plain keys/));
    }
  });

  test('a root file name containing * does not pack as README or LICENSE, and an entry spelled in another case throws', () => {
    if (process.platform !== 'win32') {
      planted({ files: ['hooks'] }, ['README.*', 'LICENSE.a*', 'README'], (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)), ['README', 'package.json']);
      });
    }
    planted({ files: ['Hooks'] }, ['hooks/a.js'], (tmp) => {
      // A case-sensitive disk reaches the unmatched-entry sibling check; a case-insensitive one finds `hooks` under
      // another spelling and reaches the spelling check. Both throw.
      assert.throws(() => listPackedFiles(tmp), /another case|spells a name differently/);
    });
  });

  test('a main file spelled with ./ is not packed by npm, a bin file spelled with ./ is', () => {
    planted({ files: ['hooks', 'bin'], main: './lib/m.js', bin: { t: './bin/t.js' } }, ['lib/m.js', 'bin/t.js'], (tmp) => {
      assert.deepEqual(sorted(listPackedFiles(tmp)), ['bin/t.js', 'package.json']);
    });
  });

  test('a name containing * is dropped, and build/config.gypi is excluded only under a directory named exactly build', () => {
    planted(
      { files: ['hooks'] },
      // `*` is not a legal file name character on Windows, so the star names are planted elsewhere only.
      [...(process.platform === 'win32' ? [] : ['hooks/a*b.js', 'hooks/d*e/x.js']), 'hooks/ok.js',
        'hooks/xbuild/config.gypi', 'hooks/rebuild/config.gypi', 'hooks/build/config.gypi'],
      (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)),
          ['hooks/ok.js', 'hooks/rebuild/config.gypi', 'hooks/xbuild/config.gypi', 'package.json']);
      },
    );
  });

  test('a directory entry under node_modules or an excluded directory does not pack', () => {
    planted(
      { files: ['.git/sub', 'hooks/._d/sub', 'ok/dir'] },
      ['.git/sub/b.js', 'hooks/._d/sub/c.js', 'ok/dir/d.js'],
      (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)), ['ok/dir/d.js', 'package.json']);
      },
    );
  });

  test('a path both included and excluded, a backslash, and a manifest key the list does not model throw', () => {
    planted({ files: ['!a/x.js', 'a/x.js'] }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /follows an exclusion inside it/));
    planted({ files: ['a/x.js', '!a/X.js'] }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /both included and excluded/));
    planted({ files: ['a\\b'] }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /backslash/));
    for (const extra of [{ browser: 'b.js' }, { bundleDependencies: ['x'] }, { bundledDependencies: true }, { workspaces: ['p'] }]) {
      planted({ files: ['hooks'], ...extra }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /does not model/));
    }
  });

  test('an inclusion after an exclusion, a repeated "!", a root file sharing a base name with an exclusion, odd spellings and a nested excluded main throw', () => {
    planted({ files: ['!a/b', 'a'] }, ['a/b/c.js'], (tmp) => assert.throws(() => listPackedFiles(tmp), /follows an exclusion inside it/));
    planted({ files: ['!hooks/sub', 'pi'] }, [], (tmp) => assert.doesNotThrow(() => listPackedFiles(tmp)));
    planted({ files: ['hooks', '!!a/b'] }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /repeated "!"/));
    planted({ files: ['a', 'c.js', '!a/b/c.js'] }, ['c.js'], (tmp) => assert.throws(() => listPackedFiles(tmp), /shares a base name/));
    for (const files of [[' hooks'], ['hooks '], ['ho\nks'], ['#hooks']]) {
      planted({ files }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /plain paths only/));
    }
    planted({ files: ['hooks'], main: 'lib/a.orig' }, ['lib/a.orig'], (tmp) => assert.throws(() => listPackedFiles(tmp), /nested and matches a default exclusion/));
  });

  test('a root directory entry with an excluded name, an inclusion inside an earlier exclusion, and a main or bin leaving the root throw', () => {
    for (const dir of ['x.orig', 'build', '.svn', 'CVS', 'archived-packages']) {
      planted({ files: [dir] }, [`${dir}/y.js`], (tmp) => assert.throws(() => listPackedFiles(tmp), /does not model that/));
    }
    planted({ files: ['a', '!a/b', 'a/b/c'] }, ['a/x.js', 'a/b/c/f'], (tmp) => {
      assert.throws(() => listPackedFiles(tmp), /follows an exclusion inside it or around it/);
    });
    planted({ files: ['hooks'], main: '../sibling.js' }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /leaves the package root/));
    planted({ files: ['hooks'], bin: { t: path.resolve(os.tmpdir(), 't.js') } }, [], (tmp) => {
      assert.throws(() => listPackedFiles(tmp), /leaves the package root/);
    });
  });

  test('a trailing slash, a "." or empty segment and other spellings that are not a plain path throw, in files, main and bin', () => {
    for (const files of [['a.js/'], ['hooks/'], ['hooks/./sub'], ['hooks//sub'], ['hooks/.'], ['ho ks'], ['hooks/sub/', '!hooks/x.js']]) {
      planted({ files }, ['a.js'], (tmp) => assert.throws(() => listPackedFiles(tmp), /not a plain path|names the package root/));
    }
    planted({ files: ['hooks'], main: 'lib/./m.js' }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /not a plain path/));
    planted({ files: ['hooks'], bin: { t: 'bin//t.js' } }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /not a plain path/));
    planted({ files: ['./hooks'] }, ['hooks/a.js'], (tmp) => assert.deepEqual(sorted(listPackedFiles(tmp)), ['hooks/a.js', 'package.json']));
  });

  test('an ignore file in a directory above a nested entry throws, and so does a symlinked directory on its path', (t) => {
    for (const name of ['.gitignore', '.npmignore']) {
      planted({ files: ['a/sub'] }, [`a/${name}`, 'a/sub/x.js'], (tmp) => {
        assert.throws(() => listPackedFiles(tmp), /an ignore file above/);
      });
    }
    planted({ files: ['link/x.js', 'plain/x.js'] }, ['real/x.js', 'plain/x.js'], (tmp) => {
      try { fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link')); } catch (err) {
        t.skip(`symlinks are not available here (${err.code})`);
        return;
      }
      assert.throws(() => listPackedFiles(tmp), /symlinked directory on the path/);
    });
  });

  test('a files entry naming the package root throws', () => {
    for (const files of [['.'], ['./'], ['!.']]) {
      planted({ files }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /names the package root/));
    }
  });

  test('a files entry that leaves the package root throws', () => {
    for (const files of [['../x'], ['hooks/../../x'], ['!../x'], [path.resolve(os.tmpdir(), 'x')]]) {
      planted({ files }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /leaves the package root/));
    }
  });

  test('a root .git or node_modules file, and a root directory named like a lock file, do not pack', () => {
    planted({ files: ['.git', 'node_modules', 'keep.js'] }, ['.git', 'node_modules', 'keep.js'], (tmp) => {
      assert.deepEqual(sorted(listPackedFiles(tmp)), ['keep.js', 'package.json']);
    });
    planted(
      { files: ['yarn.lock', 'package-lock.json', 'bun.lockb', 'pnpm-lock.yaml', 'keep.js'] },
      ['yarn.lock/x.js', 'package-lock.json/y.js', 'bun.lockb/z.js', 'pnpm-lock.yaml/w.js', 'keep.js'],
      (tmp) => {
        assert.deepEqual(sorted(listPackedFiles(tmp)), ['keep.js', 'package.json']);
      },
    );
  });

  test('an exclusion spelled with ./, nested and root entries mixed, and an entry matching a name only in another case throw', () => {
    planted({ files: ['scripts', '!./scripts/x.cjs'] }, ['scripts/x.cjs'], (tmp) => assert.throws(() => listPackedFiles(tmp), /spelled with \.\//));
    planted({ files: ['a/c', 'b'] }, ['a/c/f.js', 'b/g.js', 'a/b'], (tmp) => assert.throws(() => listPackedFiles(tmp), /mixes nested and root entries/));
    planted({ files: ['gemini.md'] }, ['GEMINI.md'], (tmp) => {
      // A case-sensitive disk reaches the sibling check; a case-insensitive one finds the file and reaches the spelling check.
      assert.throws(() => listPackedFiles(tmp), /another case|spells a name differently/);
    });
  });

  test('a main, bin or nested entry spelled in another case than the disk throws, whichever the disk is sensitive to', () => {
    // A case-sensitive disk fails the lookup and reaches the sibling check; a case-insensitive one finds the file under
    // another spelling and reaches the spelling check. Both throw with one of these two messages.
    const message = /another case|spells a name differently/;
    planted({ files: ['hooks'], main: 'Main.js' }, ['main.js'], (tmp) => assert.throws(() => listPackedFiles(tmp), message));
    planted({ files: ['hooks'], bin: { t: 'Bin/t.js' } }, ['bin/t.js'], (tmp) => assert.throws(() => listPackedFiles(tmp), message));
    planted({ files: ['Hooks/a.js'] }, ['hooks/a.js'], (tmp) => assert.throws(() => listPackedFiles(tmp), message));
  });

  test('a main or bin under a directory no root entry covers, a non-string main, and a sibling differing only in case throw', (t) => {
    planted({ files: ['hooks', 'GEMINI.md'], main: 'lib/main.js' }, ['lib/main.js'], (tmp) => {
      assert.throws(() => listPackedFiles(tmp), /no files entry covers/);
    });
    planted({ files: ['hooks', 'lib'], main: 'lib/main.js' }, ['lib/main.js'], (tmp) => {
      assert.deepEqual(sorted(listPackedFiles(tmp)), ['lib/main.js', 'package.json']);
    });
    planted({ files: ['hooks'], main: 5 }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /"main" is not a string/));
    planted({ files: ['scripts'] }, ['scripts/a.js', 'Scripts/b.js'], (tmp) => {
      // The two spellings can only coexist on a case-sensitive disk, so a case-insensitive one has nothing to check.
      if (fs.readdirSync(tmp).filter((n) => n.toLowerCase() === 'scripts').length < 2) {
        t.skip('this disk is case-insensitive');
        return;
      }
      assert.throws(() => listPackedFiles(tmp), /differs from it only in case/);
    });
  });

  test('a node_modules segment in a nested entry, in any case, and a symlinked root README throw', (t) => {
    for (const entry of ['a/node_modules', 'a/node_modules/x', 'node_modules/x', 'Node_Modules/x']) {
      planted({ files: [entry] }, [`${entry}/f.js`], (tmp) => assert.throws(() => listPackedFiles(tmp), /nested node_modules|another case|spells a name differently/));
    }
    planted({ files: ['hooks'] }, ['hooks/a.js', 'hooks/Node_Modules/p/i.js'], (tmp) => {
      assert.throws(() => listPackedFiles(tmp), /nested node_modules/);
    });
    planted({ files: ['hooks'] }, ['real.md'], (tmp) => {
      try { fs.symlinkSync(path.join(tmp, 'real.md'), path.join(tmp, 'README.md')); } catch (err) {
        t.skip(`symlinks are not available here (${err.code})`);
        return;
      }
      assert.throws(() => listPackedFiles(tmp), /symlinked root file/);
    });
  });

  test('a main or bin target a rule could drop, a directory target, an uncovered nested target, a non-string bin value and a README directory throw', () => {
    for (const main of ['.npmrc', 'yarn.lock', 'package-lock.json', '.DS_Store', 'x.orig', '.x.swp']) {
      planted({ files: ['hooks'], main }, [main], (tmp) => assert.throws(() => listPackedFiles(tmp), /could drop/));
    }
    planted({ files: ['scripts', '!scripts/x.js'], bin: { x: 'scripts/x.js' } }, ['scripts/x.js'], (tmp) => {
      assert.throws(() => listPackedFiles(tmp), /could drop/);
    });
    planted({ files: ['gsd-core/bin'], bin: { x: 'scripts/x.js' } }, ['gsd-core/bin/a.js', 'scripts/x.js'], (tmp) => {
      assert.throws(() => listPackedFiles(tmp), /no files entry covers/);
    });
    planted({ files: ['hooks'], bin: { x: 5 } }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /not an object with plain keys/));
    planted({ files: ['hooks'], main: 'lib' }, ['lib/a.js'], (tmp) => assert.throws(() => listPackedFiles(tmp), /no files entry covers|symlink or a directory/));
    planted({ files: ['hooks', 'lib'], main: 'lib' }, ['lib/a.js'], (tmp) => assert.throws(() => listPackedFiles(tmp), /symlink or a directory/));
    planted({ files: ['hooks'] }, ['README.d/x.js'], (tmp) => assert.throws(() => listPackedFiles(tmp), /root directory named like a file/));
  });

  test('a symlinked main target throws', (t) => {
    planted({ files: ['hooks'], main: 'main.js' }, ['real.js'], (tmp) => {
      try { fs.symlinkSync(path.join(tmp, 'real.js'), path.join(tmp, 'main.js')); } catch (err) {
        t.skip(`symlinks are not available here (${err.code})`);
        return;
      }
      assert.throws(() => listPackedFiles(tmp), /symlink or a directory/);
    });
  });

  test('case-variant children of a walked directory throw', (t) => {
    planted({ files: ['hooks'] }, ['hooks/a.js', 'hooks/Dup.js', 'hooks/dup.js'], (tmp) => {
      // Two names that differ only in case coexist only on a case-sensitive disk.
      if (fs.readdirSync(path.join(tmp, 'hooks')).length < 3) {
        t.skip('this disk is case-insensitive');
        return;
      }
      assert.throws(() => listPackedFiles(tmp), /differ only in case/);
    });
  });

  test('a nested entry under a root directory a default matches, and a directories key, throw', () => {
    for (const entry of ['.hg/foo', 'x.orig/sub', 'archived-packages/x', 'CVS/y', '._d/sub', 'npm-debug.log/x', 'yarn.lock/x', 'package-lock.json/x', 'pnpm-lock.yaml/x', 'bun.lockb/x', 'Yarn.Lock/x']) {
      planted({ files: [entry] }, [`${entry}/a.js`], (tmp) => assert.throws(() => listPackedFiles(tmp), /under a root directory a default exclusion matches/));
    }
    planted({ files: ['hooks'], directories: { bin: 'tools' } }, ['tools/t.js'], (tmp) => {
      assert.throws(() => listPackedFiles(tmp), /"directories", which this list does not model/);
    });
  });

  test('a root COPYING file ships without a files entry', () => {
    planted({ files: ['hooks'] }, ['COPYING', 'COPYING.txt', 'copying-notes'], (tmp) => {
      assert.deepEqual(sorted(listPackedFiles(tmp)), ['COPYING', 'COPYING.txt', 'package.json']);
    });
  });

  test('a glob entry, a slash-less exclusion and a nested node_modules throw instead of changing the list', () => {
    for (const files of [['scripts/*.cjs'], ['hooks', '!hooks/*.js'], ['**/x'], ['dist/{a,b}']]) {
      planted({ files }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /is a glob/));
    }
    planted({ files: ['hooks', '!name.cjs'] }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /slash-less exclusion/));
    planted({ files: ['hooks'] }, ['hooks/node_modules/dep/index.js'], (tmp) => {
      assert.throws(() => listPackedFiles(tmp), /nested node_modules/);
    });
  });

  test('a package.json that is not JSON, or has no files array, throws', () => {
    planted('{not json', [], (tmp) => assert.throws(() => listPackedFiles(tmp), /cannot be read as JSON/));
    planted({ name: 'x' }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /no files array/));
    planted({ files: ['a', 7] }, [], (tmp) => assert.throws(() => listPackedFiles(tmp), /no files array/));
    assert.throws(() => listPackedFiles(path.join(os.tmpdir(), 'gsd-pack-list-no-such-root')), /cannot be read as JSON/);
  });

  test('a nested ignore file in a packed directory throws instead of being ignored', () => {
    for (const name of ['.npmignore', '.gitignore']) {
      planted({ files: ['hooks'] }, [`hooks/${name}`, 'hooks/a.js'], (tmp) => {
        assert.throws(() => listPackedFiles(tmp), /nested ignore file/);
      });
    }
  });

  test('a symlink in a packed directory, or as a files entry, throws', (t) => {
    planted({ files: ['hooks', 'linked'] }, ['hooks/a.js', 'target/x.js'], (tmp) => {
      try { fs.symlinkSync(path.join(tmp, 'target'), path.join(tmp, 'hooks', 'link')); } catch (err) {
        t.skip(`symlinks are not available here (${err.code})`);
        return;
      }
      assert.throws(() => listPackedFiles(tmp), /symlink in a packed directory/);
      fs.unlinkSync(path.join(tmp, 'hooks', 'link'));
      fs.symlinkSync(path.join(tmp, 'target'), path.join(tmp, 'linked'));
      assert.throws(() => listPackedFiles(tmp), /symlinked files entry/);
    });
  });

  test('every positive files entry of this package.json names a path that exists, so none shrinks the list silently', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const missing = manifest.files.filter((f) => !f.startsWith('!')).filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
    assert.deepEqual(missing, [], 'a files entry that matches nothing contributes no file to the tarball');
  });

  test('on this repository the list keeps the instrumentation chain out and the shipped scripts in', () => {
    const list = listPackedFiles(REPO_ROOT);
    for (const f of ['scripts/run-tests.cjs', 'scripts/live-config-guard.cjs', 'tests/helpers.cjs', 'package-lock.json']) {
      assert.ok(!list.has(f), `${f} must not ship`);
    }
    for (const f of ['package.json', 'bin/install.js', 'scripts/lib/cli-exit.cjs', 'LICENSE']) {
      assert.ok(list.has(f), `${f} must ship`);
    }
  });
});
