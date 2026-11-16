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
const filler = fc.stringMatching(/^[a-z]{1,8}$/).filter((s) => s !== 'test' && s !== 'tests');
const fillers = fc.array(filler, { maxLength: 4 });
// Every shared sample of every glob, flattened; the owner is tests/helpers/tdd-test-paths.cjs.
const samples = Object.entries(SAMPLES_BY_GLOB)
  .flatMap(([glob, paths]) => paths.map((path) => [glob, path]));

describe('#5181 tdd-test-files matcher properties', () => {
  test('(a) separator invariance', () => {
    const segment = fc.oneof(filler, fc.constantFrom('tests', '__tests__', 'test_a.py', 'a.test.js', 'x.js'));
    fc.assert(fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (segments) => {
      assert.equal(isTestFilePath(segments.join('/')), isTestFilePath(segments.join('\\')));
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

  test('(d) git and isTestFilePath agree on random nested, mixed-case paths', () => {
    // The #5181 defect: git read the list differently from the router. One repo and one commit per run.
    const dirNames = fc.oneof(filler, fc.constantFrom('tests', 'test', '__tests__', 'testing', 'mytests', 'a.test.d', 'test_utils'));
    const stems = fc.stringMatching(/^[a-z]{1,6}$/).filter((s) => !['con', 'nul', 'aux', 'prn'].includes(s));
    const names = fc.tuple(
      fc.constantFrom('', 'test_'), stems,
      fc.constantFrom('.js', '.py', '.go', '.test.js', '.spec.ts', '_test.go', '_test.py', '_test.exs', '_spec.rb', '_test.rb'),
    ).map((parts) => parts.join(''));
    const recase = (s, mode) => (mode === 'upper' ? s.toUpperCase() : mode === 'cap' ? s[0].toUpperCase() + s.slice(1) : s);
    const withCase = (arb) => fc.tuple(arb, fc.constantFrom('lower', 'upper', 'cap')).map(([s, mode]) => recase(s, mode));
    const pathArb = fc.tuple(fc.array(withCase(dirNames), { maxLength: 3 }), withCase(names))
      .map(([dirs, name]) => [...dirs, name].join('/'));
    // Names carry an extension and directories do not, so a file never shadows a directory;
    // uniqueness is on the lowercased path, so a case-folding disk cannot collide two files.
    const paths = fc.uniqueArray(pathArb, { minLength: 1, maxLength: 25, selector: (p) => p.toLowerCase() });
    fc.assert(fc.property(paths, (files) => {
      const dir = createTempGitProject('gsd-5181-agree-');
      try {
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
      } finally {
        cleanup(dir);
      }
    }), { numRuns: 25 });
  });
});
