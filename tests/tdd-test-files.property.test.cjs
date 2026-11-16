'use strict';

/**
 * Property-based tests for the #5181 test-file matcher
 *
 * Module: gsd-core/bin/lib/tdd-test-files.cjs (built from src/tdd-test-files.cts)
 * The matchers are module-private, so they are driven through the public
 * `isTestFilePath`, with samples from the shared SAMPLES_BY_GLOB.
 *
 * Properties tested:
 *   (a) separator invariance: `/` and `\` spell the same path
 *   (b) depth invariance: an instance of every glob stays a test file under any
 *       number of non-test parent directories (0, 1, 2, ... deep)
 *   (c) paths built only from non-test names are never test files, and `test_*.py` is a
 *       basename match, not a directory one
 *   (d) git (`log -- TEST_FILE_PATHSPECS`) and `isTestFilePath` agree on random nested,
 *       mixed-case paths seeded into one repo
 *   (e) empty segments and edge separators (`//`, a leading or trailing `/`) change nothing
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { isTestFilePath, TEST_FILE_PATHSPECS } = require('../gsd-core/bin/lib/tdd-test-files.cjs');
const { SAMPLES_BY_GLOB } = require('./helpers/tdd-test-paths.cjs');

// A directory segment that is not a test directory name (`test`, `tests`, `__tests__`).
// A name Windows reserves (in any case) cannot be created on disk; no segment may spell one.
const RESERVED = new Set(['con', 'nul', 'aux', 'prn']);
const filler = fc.stringMatching(/^[a-z]{1,8}$/).filter((s) => s !== 'test' && s !== 'tests' && !RESERVED.has(s));
const fillers = fc.array(filler, { maxLength: 4 });
const recase = (s, mode) => (mode === 'upper' ? s.toUpperCase() : mode === 'cap' ? s[0].toUpperCase() + s.slice(1) : s);
const caseMode = fc.constantFrom('lower', 'upper', 'cap');

// Paths seeded into one repo by (d). Directories share one case per run, so a case-folding disk
// (macOS, Windows) never sees one directory spelled two ways; each file name carries its own case,
// and uniqueness is on the lowercased path, so no two files collide there either.
const dirNames = fc.oneof(filler, fc.constantFrom('tests', 'test', '__tests__', 'testing', 'mytests', 'a.test.d', 'test_utils'));
const stems = fc.stringMatching(/^[a-z]{1,6}$/).filter((s) => !RESERVED.has(s));
const names = fc.tuple(
  fc.constantFrom('', 'test_'), stems,
  fc.constantFrom('.js', '.py', '.go', '.test.js', '.spec.ts', '_test.go', '_test.py', '_test.exs', '_spec.rb', '_test.rb'),
).map((parts) => parts.join(''));
const seededPaths = fc.tuple(
  caseMode,
  fc.uniqueArray(
    fc.tuple(fc.array(dirNames, { maxLength: 3 }), caseMode, names)
      .map(([dirs, mode, name]) => ({ dirs, name: recase(name, mode) })),
    { minLength: 1, maxLength: 25, selector: ({ dirs, name }) => [...dirs, name].join('/').toLowerCase() },
  ),
).map(([dirMode, entries]) => entries.map(({ dirs, name }) => [...dirs.map((d) => recase(d, dirMode)), name].join('/')));
// Every shared sample of every glob, flattened; the owner is tests/helpers/tdd-test-paths.cjs.
const samples = Object.entries(SAMPLES_BY_GLOB)
  .flatMap(([glob, paths]) => paths.map((sample) => [glob, sample]));

describe('#5181 tdd-test-files matcher properties', () => {
  test('(a) separator invariance', () => {
    const segment = fc.oneof(filler, fc.constantFrom('tests', '__tests__', 'test_a.py', 'a.test.js', 'x.js'));
    fc.assert(fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (segments) => {
      assert.equal(isTestFilePath(segments.join('/')), isTestFilePath(segments.join('\\')));
    }));
  });

  test('(e) empty segments and edge separators do not change the answer', () => {
    const segment = fc.oneof(filler, fc.constantFrom('tests', '__tests__', 'test_a.py', 'a.test.js', 'x.js'));
    fc.assert(fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (segments) => {
      const messy = `/${segments.join('//')}/`;
      assert.equal(isTestFilePath(messy), isTestFilePath(segments.join('/')), `${messy} must match its clean form`);
      assert.equal(isTestFilePath(messy.replaceAll('/', '\\')), isTestFilePath(segments.join('/')));
    }));
  });

  test('(b) depth invariance: every glob instance is a test file at any depth', () => {
    fc.assert(fc.property(fc.constantFrom(...samples), fillers, ([glob, sample], parents) => {
      const p = [...parents, sample].join('/');
      assert.equal(isTestFilePath(p), true, `${p} (from ${glob}) must be a test file`);
    }));
  });

  test('(c) non-test names and test_-prefixed directories are not test files', () => {
    fc.assert(fc.property(fillers, filler, (parents, name) => {
      const p = [...parents, `${name}.js`].join('/');
      assert.equal(isTestFilePath(p), false, `${p} must not be a test file`);
    }));
    // `:(glob,icase)**/test_*.py` is a basename match: a `test_`-prefixed directory is not a test.
    fc.assert(fc.property(fillers, filler, filler, (parents, dir, name) => {
      const p = [...parents, `test_${dir}`, `${name}.py`].join('/');
      assert.equal(isTestFilePath(p), false, `${p} must not be a test file`);
    }));
  });

  test('(d) git and isTestFilePath agree on random nested, mixed-case paths', (t) => {
    // The #5181 defect: git read the list differently from the router. One repo and one commit per run.
    const dirs = [];
    t.after(() => dirs.forEach(cleanup));
    fc.assert(fc.property(seededPaths, (files) => {
      const dir = createTempGitProject('gsd-5181-agree-');
      dirs.push(dir);
      for (const rel of files) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'x\n');
      }
      gitOrThrow(['add', '-A'], { cwd: dir });
      gitOrThrow(['commit', '-m', 'test(1-01): seed'], { cwd: dir });
      const out = gitOrThrow(['log', '--format=', '--name-only', '--', ...TEST_FILE_PATHSPECS], { cwd: dir });
      const hits = new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
      for (const rel of files) assert.equal(hits.has(rel), isTestFilePath(rel), `${rel}: git ${hits.has(rel)} vs router`);
    }), { numRuns: 25 });
  });
});
