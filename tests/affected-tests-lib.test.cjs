'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  parseRelativeSpecifiers,
  pickAffectedTests,
  resolveRunPlan,
  shouldRunFullSuite,
  resolveBaseRef,
  PR_EXCLUDED_SUITES,
  PR_FULL_SUITES,
  buildTransitiveReverseIndex,
  resolveRelativeDependency,
} = require('../scripts/affected-tests-lib.cjs');

const { cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp repo with given files (keys = relative paths, values = content). */
function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Original tests (kept green)
// ---------------------------------------------------------------------------

test('parseRelativeSpecifiers captures local require/import paths', () => {
  const source = `
    const a = require('./alpha.cjs');
    const b = require("node:assert/strict");
    import c from "../beta.js";
    import d from "external-lib";
  `;
  const out = parseRelativeSpecifiers(source);
  assert.deepEqual(out, ['./alpha.cjs', '../beta.js']);
});

test('shouldRunFullSuite true when critical paths change', () => {
  assert.equal(shouldRunFullSuite(['package-lock.json']), true);
  assert.equal(shouldRunFullSuite(['.github/workflows/test.yml']), true);
  assert.equal(shouldRunFullSuite(['tests/foo.test.cjs']), false);
});

test('pickAffectedTests includes direct test changes and reverse-index matches, excluding install suite', () => {
  const allTests = [
    'tests/alpha.test.cjs',
    'tests/install.test.cjs',
    'tests/tarball.install.test.cjs',
  ];
  const reverse = new Map([
    ['bin/install.js', new Set(['tests/install.test.cjs'])],
  ]);
  const selected = pickAffectedTests(
    ['tests/alpha.test.cjs', 'bin/install.js'],
    allTests,
    reverse,
  );
  // tests/install.test.cjs is a plain unit test (no install suite marker) so it is included.
  // tests/tarball.install.test.cjs is install suite — excluded.
  assert.deepEqual(selected, [
    'tests/alpha.test.cjs',
    'tests/install.test.cjs',
  ]);
});

test('pickAffectedTests falls back to smoke test when no matches found', () => {
  const allTests = ['tests/release-tarball-smoke.install.test.cjs'];
  const selected = pickAffectedTests(
    ['docs/README.md'],
    allTests,
    new Map(),
  );
  // New contract: install files are excluded; empty selection returns empty array.
  assert.deepEqual(selected, []);
});

test('pickAffectedTests excludes a directly-changed install test file', () => {
  // Even if the changed file IS an install test, it must be excluded from PR selection.
  const allTests = [
    'tests/foo.install.test.cjs',
    'tests/bar.test.cjs',
  ];
  const selected = pickAffectedTests(
    ['tests/foo.install.test.cjs'],
    allTests,
    new Map(),
  );
  assert.ok(!selected.includes('tests/foo.install.test.cjs'), 'install test must be excluded');
  assert.deepEqual(selected, []);
});

test('pickAffectedTests excludes install/slow pulled in by stem match', () => {
  // A changed source file whose stem matches an install or slow test file.
  const allTests = [
    'tests/release-tarball.install.test.cjs',
    'tests/perf-check.slow.test.cjs',
    'tests/release-tarball.test.cjs',
  ];
  const selected = pickAffectedTests(
    ['src/release-tarball.cjs'],
    allTests,
    new Map(),
  );
  assert.ok(!selected.includes('tests/release-tarball.install.test.cjs'), 'install suite must be excluded via stem match');
  assert.ok(!selected.includes('tests/perf-check.slow.test.cjs'), 'slow suite must be excluded');
  // The plain unit test matched by stem is still included.
  assert.ok(selected.includes('tests/release-tarball.test.cjs'), 'unit test matched by stem should be included');
});

test('pickAffectedTests returns empty (no install smoke) when nothing maps', () => {
  const allTests = [
    'tests/release-tarball-smoke.install.test.cjs',
    'tests/some-unit.test.cjs',
  ];
  // Changed file has no match and no stem match with unit tests.
  const selected = pickAffectedTests(
    ['docs/CONTRIBUTING.md'],
    allTests,
    new Map(),
  );
  assert.ok(
    !selected.includes('tests/release-tarball-smoke.install.test.cjs'),
    'install smoke test must not be injected as fallback',
  );
  assert.deepEqual(selected, []);
});

test('PR_EXCLUDED_SUITES contains install and slow; PR_FULL_SUITES excludes them', () => {
  assert.ok(PR_EXCLUDED_SUITES instanceof Set, 'PR_EXCLUDED_SUITES must be a Set');
  assert.ok(PR_EXCLUDED_SUITES.has('install'), 'install must be in PR_EXCLUDED_SUITES');
  assert.ok(PR_EXCLUDED_SUITES.has('slow'), 'slow must be in PR_EXCLUDED_SUITES');
  assert.ok(Array.isArray(PR_FULL_SUITES), 'PR_FULL_SUITES must be an array');
  assert.ok(PR_FULL_SUITES.includes('unit'), 'unit must be in PR_FULL_SUITES');
  assert.ok(PR_FULL_SUITES.includes('integration'), 'integration must be in PR_FULL_SUITES');
  assert.ok(PR_FULL_SUITES.includes('security'), 'security must be in PR_FULL_SUITES');
  assert.ok(!PR_FULL_SUITES.includes('install'), 'install must NOT be in PR_FULL_SUITES');
  assert.ok(!PR_FULL_SUITES.includes('slow'), 'slow must NOT be in PR_FULL_SUITES');
});

test('resolveBaseRef prefers explicit env override', () => {
  const original = {
    GSD_AFFECTED_BASE: process.env.GSD_AFFECTED_BASE,
    GITHUB_BASE_REF: process.env.GITHUB_BASE_REF,
  };
  try {
    process.env.GSD_AFFECTED_BASE = 'origin/next';
    process.env.GITHUB_BASE_REF = 'main';
    assert.equal(resolveBaseRef(), 'origin/next');

    delete process.env.GSD_AFFECTED_BASE;
    process.env.GITHUB_BASE_REF = 'next';
    assert.equal(resolveBaseRef(), 'origin/next');

    delete process.env.GSD_AFFECTED_BASE;
    delete process.env.GITHUB_BASE_REF;
    assert.equal(resolveBaseRef(), 'origin/main');
  } finally {
    if (original.GSD_AFFECTED_BASE === undefined) delete process.env.GSD_AFFECTED_BASE;
    else process.env.GSD_AFFECTED_BASE = original.GSD_AFFECTED_BASE;
    if (original.GITHUB_BASE_REF === undefined) delete process.env.GITHUB_BASE_REF;
    else process.env.GITHUB_BASE_REF = original.GITHUB_BASE_REF;
  }
});

// ---------------------------------------------------------------------------
// NEW: Transitive test (RED against old code)
// Fixture: tests/t.test.cjs -> ../gsd-core/bin/lib/depA.cjs -> ./depB.cjs
// Changed: gsd-core/bin/lib/depB.cjs
// Expected: tests/t.test.cjs is selected
// ---------------------------------------------------------------------------

test('transitive: changing a deep dependency selects the test that depends on it', (t) => {
  const dir = makeFixture({
    'gsd-core/bin/lib/depB.cjs': `'use strict';\nmodule.exports = { b: 1 };\n`,
    'gsd-core/bin/lib/depA.cjs': `'use strict';\nconst depB = require('./depB.cjs');\nmodule.exports = { a: depB };\n`,
    'tests/t.test.cjs': `'use strict';\nconst depA = require('../gsd-core/bin/lib/depA.cjs');\n`,
  });
  t.after(() => cleanup(dir));

  const reverseIndex = buildTransitiveReverseIndex(dir, ['tests/t.test.cjs']);
  const selected = pickAffectedTests(
    ['gsd-core/bin/lib/depB.cjs'],
    ['tests/t.test.cjs'],
    reverseIndex,
  );

  assert.ok(
    selected.includes('tests/t.test.cjs'),
    `Expected tests/t.test.cjs in selection, got: ${JSON.stringify(selected)}`,
  );
});

// ---------------------------------------------------------------------------
// Adversarial matrix
// ---------------------------------------------------------------------------

test('adversarial(a): cycle depA<->depB — changing depA selects test, no hang', (t) => {
  const dir = makeFixture({
    'gsd-core/bin/lib/depA.cjs': `'use strict';\nconst depB = require('./depB.cjs');\nmodule.exports = {};\n`,
    'gsd-core/bin/lib/depB.cjs': `'use strict';\nconst depA = require('./depA.cjs');\nmodule.exports = {};\n`,
    'tests/cycle.test.cjs': `'use strict';\nconst depA = require('../gsd-core/bin/lib/depA.cjs');\n`,
  });
  t.after(() => cleanup(dir));

  // Must complete without hanging
  const reverseIndex = buildTransitiveReverseIndex(dir, ['tests/cycle.test.cjs']);
  const selected = pickAffectedTests(
    ['gsd-core/bin/lib/depA.cjs'],
    ['tests/cycle.test.cjs'],
    reverseIndex,
  );

  assert.ok(
    selected.includes('tests/cycle.test.cjs'),
    `Expected cycle.test.cjs selected, got: ${JSON.stringify(selected)}`,
  );
});

test('adversarial(b): missing require (gone file) — null resolve, no crash', (t) => {
  const dir = makeFixture({
    // Requires a file that does not exist
    'tests/missing.test.cjs': `'use strict';\nconst x = require('../gsd-core/bin/lib/gone.cjs');\n`,
  });
  t.after(() => cleanup(dir));

  // Should not throw
  let reverseIndex;
  assert.doesNotThrow(() => {
    reverseIndex = buildTransitiveReverseIndex(dir, ['tests/missing.test.cjs']);
  });

  // Changing the missing file produces no selection (it doesn't exist, so no dependents)
  const selected = pickAffectedTests(
    ['gsd-core/bin/lib/gone.cjs'],
    ['tests/missing.test.cjs'],
    reverseIndex,
  );
  // gone.cjs is not in the graph (null resolve), so no test selected via index
  // stem match may or may not fire; either way, no crash is the key assertion
  assert.ok(Array.isArray(selected), 'result must be an array');
});

test('adversarial(c): .json dependency — changing data.json selects the test', (t) => {
  const dir = makeFixture({
    'gsd-core/bin/lib/data.json': `{"key":"value"}`,
    'tests/json.test.cjs': `'use strict';\nconst data = require('../gsd-core/bin/lib/data.json');\n`,
  });
  t.after(() => cleanup(dir));

  const reverseIndex = buildTransitiveReverseIndex(dir, ['tests/json.test.cjs']);
  const selected = pickAffectedTests(
    ['gsd-core/bin/lib/data.json'],
    ['tests/json.test.cjs'],
    reverseIndex,
  );

  assert.ok(
    selected.includes('tests/json.test.cjs'),
    `Expected json.test.cjs selected for data.json change, got: ${JSON.stringify(selected)}`,
  );
});

test('adversarial(d): re-export chain — changing depB selects the test that requires the re-exporter', (t) => {
  const dir = makeFixture({
    'gsd-core/bin/lib/depB.cjs': `'use strict';\nmodule.exports = { deep: true };\n`,
    'gsd-core/bin/lib/reexporter.cjs': `'use strict';\nmodule.exports = require('./depB.cjs');\n`,
    'tests/reexport.test.cjs': `'use strict';\nconst x = require('../gsd-core/bin/lib/reexporter.cjs');\n`,
  });
  t.after(() => cleanup(dir));

  const reverseIndex = buildTransitiveReverseIndex(dir, ['tests/reexport.test.cjs']);
  const selected = pickAffectedTests(
    ['gsd-core/bin/lib/depB.cjs'],
    ['tests/reexport.test.cjs'],
    reverseIndex,
  );

  assert.ok(
    selected.includes('tests/reexport.test.cjs'),
    `Expected reexport.test.cjs selected when depB changes, got: ${JSON.stringify(selected)}`,
  );
});

test('adversarial(e): bare and node: specifiers are ignored', () => {
  const source = `
    const a = require('node:fs');
    const b = require('external-package');
    import c from 'node:path';
    import d from 'lodash';
    const e = require('./local.cjs');
  `;
  const out = parseRelativeSpecifiers(source);
  // Only the relative specifier survives
  assert.deepEqual(out, ['./local.cjs']);
});

test('adversarial(f): WIDEN — changing a src file with no test dependents widens to unit/all', (t) => {
  // orphan.cjs is a source file no test file requires (statically)
  const dir = makeFixture({
    'gsd-core/bin/lib/orphan.cjs': `'use strict';\nmodule.exports = {};\n`,
    'tests/unrelated.test.cjs': `'use strict';\n// requires nothing\n`,
  });
  t.after(() => cleanup(dir));

  const reverseIndex = buildTransitiveReverseIndex(dir, ['tests/unrelated.test.cjs']);

  // Verify orphan.cjs has no dependents in the index
  const dependents = reverseIndex.get('gsd-core/bin/lib/orphan.cjs');
  assert.ok(
    !dependents || dependents.size === 0,
    'orphan.cjs must have no transitive test dependents',
  );

  // The widen backstop is tested via the WIDEN_SIGNAL attached to pickAffectedTests result
  const selected = pickAffectedTests(
    ['gsd-core/bin/lib/orphan.cjs'],
    ['tests/unrelated.test.cjs'],
    reverseIndex,
    { detectWiden: true },
  );

  assert.ok(
    selected._widenRequired === true,
    `Expected _widenRequired=true for orphan src file with no test dependents, got: ${JSON.stringify(selected._widenRequired)}`,
  );
});

test('adversarial(g): dynamic require in changed file with no static dependents — widen backstop catches it', (t) => {
  // dynamic.cjs uses a template literal require — not statically parseable
  // No test requires dynamic.cjs statically
  const dir = makeFixture({
    'gsd-core/bin/lib/dynamic.cjs': `'use strict';\nconst x = 'foo';\nconst m = require(\`./\${x}\`);\nmodule.exports = {};\n`,
    'tests/unrelated.test.cjs': `'use strict';\n// does not require dynamic.cjs\n`,
  });
  t.after(() => cleanup(dir));

  const reverseIndex = buildTransitiveReverseIndex(dir, ['tests/unrelated.test.cjs']);

  const selected = pickAffectedTests(
    ['gsd-core/bin/lib/dynamic.cjs'],
    ['tests/unrelated.test.cjs'],
    reverseIndex,
    { detectWiden: true },
  );

  assert.ok(
    selected._widenRequired === true,
    `Expected _widenRequired=true for dynamic-require src file with no static dependents, got: ${JSON.stringify(selected._widenRequired)}`,
  );
});

test('resolveRelativeDependency resolves .ts, .json extensions', (t) => {
  const dir = makeFixture({
    'src/helper.ts': `export const x = 1;\n`,
    'src/data.json': `{"k":1}`,
  });
  t.after(() => cleanup(dir));

  const fromAbs = path.join(dir, 'tests/consumer.cjs');

  const tsResult = resolveRelativeDependency(dir, fromAbs, '../src/helper');
  assert.equal(tsResult, 'src/helper.ts', `Expected src/helper.ts, got: ${tsResult}`);

  const jsonResult = resolveRelativeDependency(dir, fromAbs, '../src/data.json');
  assert.equal(jsonResult, 'src/data.json', `Expected src/data.json, got: ${jsonResult}`);
});

// ---------------------------------------------------------------------------
// resolveRunPlan — pure unit tests
// ---------------------------------------------------------------------------

test('resolveRunPlan: noChanges → mode:suite unit', () => {
  // Arrange
  const plan = resolveRunPlan({ changedFiles: [], selected: [], widenRequired: false, criticalPath: false, noChanges: true });
  // Assert
  assert.deepEqual(plan, { mode: 'suite', suite: 'unit' });
});

test('resolveRunPlan: criticalPath → mode:suites PR_FULL_SUITES', () => {
  // Arrange
  const plan = resolveRunPlan({ changedFiles: ['package.json'], selected: [], widenRequired: false, criticalPath: true, noChanges: false });
  // Assert
  assert.deepEqual(plan, { mode: 'suites', suites: PR_FULL_SUITES });
});

test('resolveRunPlan: widenRequired → mode:suites PR_FULL_SUITES (not unit-only)', () => {
  // Arrange: orphan source file, no static dependents → widen signal
  const selected = [];
  selected._widenRequired = true;
  const plan = resolveRunPlan({ changedFiles: ['bin/orphan.cjs'], selected, widenRequired: true, criticalPath: false, noChanges: false });
  // Assert — must be suites covering all three PR suites, NOT unit-only
  assert.equal(plan.mode, 'suites', 'widen must produce mode:suites, not mode:suite');
  assert.deepEqual(plan.suites, PR_FULL_SUITES);
  assert.ok(plan.suites.includes('integration'), 'integration must be in widen plan');
  assert.ok(plan.suites.includes('security'), 'security must be in widen plan');
  assert.ok(plan.suites.includes('unit'), 'unit must be in widen plan');
});

test('resolveRunPlan: empty selection (no widen) → mode:suite unit smoke', () => {
  // Arrange
  const plan = resolveRunPlan({ changedFiles: ['docs/README.md'], selected: [], widenRequired: false, criticalPath: false, noChanges: false });
  // Assert
  assert.deepEqual(plan, { mode: 'suite', suite: 'unit' });
});

test('resolveRunPlan: concrete selection without widen → mode:files', () => {
  // Arrange
  const files = ['tests/foo.test.cjs', 'tests/bar.integration.test.cjs'];
  const plan = resolveRunPlan({ changedFiles: ['bin/foo.cjs'], selected: files, widenRequired: false, criticalPath: false, noChanges: false });
  // Assert
  assert.deepEqual(plan, { mode: 'files', files });
});

// ---------------------------------------------------------------------------
// Mixed-diff regression: widen must be a SUPERSET, never drop concrete matches
// ---------------------------------------------------------------------------

test('regression(mixed-diff): widen plan covers integration suite; concrete match not dropped', (t) => {
  // Arrange: two changed files in one diff.
  //   - bin/lib/server.cjs → has a concrete dependent: tests/server.integration.test.cjs
  //   - bin/lib/orphan.cjs → has NO test dependents (triggers widen)
  // Under the OLD (buggy) code, widenRequired caused an early-return to
  // runSuite(root,'unit'), which excludes integration-marked tests, so the
  // concrete integration match was silently dropped.
  // Under the NEW code, widen must resolve to mode:suites with PR_FULL_SUITES,
  // which covers unit + integration + security — a strict superset of selected.

  const dir = makeFixture({
    'bin/lib/server.cjs': `'use strict';\nmodule.exports = { serve: true };\n`,
    'bin/lib/orphan.cjs': `'use strict';\nmodule.exports = {};\n`,
    'tests/server.integration.test.cjs': `'use strict';\nconst s = require('../bin/lib/server.cjs');\n`,
    'tests/unrelated.test.cjs': `'use strict';\n// requires nothing\n`,
  });
  t.after(() => cleanup(dir));

  // Act: build graph over both test files
  const allTests = [
    'tests/server.integration.test.cjs',
    'tests/unrelated.test.cjs',
  ];
  const reverseIndex = buildTransitiveReverseIndex(dir, allTests);

  // Verify the fixture: server.cjs DOES have a concrete dependent
  const serverDependents = reverseIndex.get('bin/lib/server.cjs');
  assert.ok(
    serverDependents && serverDependents.has('tests/server.integration.test.cjs'),
    'fixture: bin/lib/server.cjs must map to tests/server.integration.test.cjs in the reverse index',
  );

  // Verify the fixture: orphan.cjs has NO dependents
  const orphanDependents = reverseIndex.get('bin/lib/orphan.cjs');
  assert.ok(
    !orphanDependents || orphanDependents.size === 0,
    'fixture: bin/lib/orphan.cjs must have zero test dependents',
  );

  // pickAffectedTests with detectWiden=true on the mixed diff
  const changedFiles = ['bin/lib/server.cjs', 'bin/lib/orphan.cjs'];
  const selected = pickAffectedTests(changedFiles, allTests, reverseIndex, { detectWiden: true });

  // The concrete match must still be in selected (widen doesn't strip it)
  assert.ok(
    selected.includes('tests/server.integration.test.cjs'),
    `Concrete integration match must survive pickAffectedTests even when widen fires; selected=${JSON.stringify(selected)}`,
  );

  // widenRequired must be set because orphan.cjs has no static dependents
  assert.ok(
    selected._widenRequired === true,
    `_widenRequired must be true when any source file has no static dependents; got ${JSON.stringify(selected._widenRequired)}`,
  );

  // resolveRunPlan must return mode:suites covering integration (not unit-only)
  const plan = resolveRunPlan({
    changedFiles,
    selected,
    widenRequired: selected._widenRequired === true,
    criticalPath: false,
    noChanges: false,
  });

  assert.equal(
    plan.mode,
    'suites',
    `widen plan must be mode:suites (not mode:suite/mode:files); got mode:${plan.mode} — OLD behaviour would have been mode:suite/unit, dropping the integration test`,
  );
  assert.ok(
    plan.suites.includes('integration'),
    `widen plan must include integration suite to cover the concrete match; suites=${JSON.stringify(plan.suites)}`,
  );
  assert.ok(
    plan.suites.includes('security'),
    `widen plan must include security suite; suites=${JSON.stringify(plan.suites)}`,
  );
  assert.ok(
    plan.suites.includes('unit'),
    `widen plan must include unit suite; suites=${JSON.stringify(plan.suites)}`,
  );

  // Prove the old behaviour would have FAILED this test:
  // Old code: widenRequired → runSuite(root,'unit') only.
  // 'unit' suite selects only files with NO suite marker (suiteOf === null).
  // tests/server.integration.test.cjs has marker 'integration', so it would be
  // excluded from the unit suite run → the concrete match is silently dropped.
  // The assertion above catches this because old plan would have been
  // { mode: 'suite', suite: 'unit' } which does NOT include 'integration'.
});

// ---------------------------------------------------------------------------
// Regression: delete-only diffs
// ---------------------------------------------------------------------------

test('regression(delete-only-source): deleting a source file triggers widen, never unit-smoke', (t) => {
  // Arrange: fixture has an unrelated test but does NOT contain gone.cjs.
  // The deletion-only diff (changedFiles includes gone.cjs which is absent on disk)
  // must trigger the widen backstop — gone.cjs has no static dependents because
  // it was never built into the forward graph (it doesn't exist).
  const dir = makeFixture({
    'gsd-core/bin/lib/other.cjs': `'use strict';\nmodule.exports = {};\n`,
    'tests/unrelated.test.cjs': `'use strict';\n// requires nothing from gone.cjs\n`,
  });
  t.after(() => cleanup(dir));

  // Act
  const allTests = ['tests/unrelated.test.cjs'];
  const reverseIndex = buildTransitiveReverseIndex(dir, allTests);

  // gone.cjs does not exist in the fixture — simulates a delete-only PR.
  const changedFiles = ['gsd-core/bin/lib/gone.cjs'];

  const selected = pickAffectedTests(changedFiles, allTests, reverseIndex, { detectWiden: true });

  // Assert: widen must be signalled (deleted source file has no static dependents)
  assert.ok(
    selected._widenRequired === true,
    `Expected _widenRequired=true for deleted source file, got: ${JSON.stringify(selected._widenRequired)}`,
  );

  const plan = resolveRunPlan({
    changedFiles,
    selected,
    widenRequired: selected._widenRequired === true,
    criticalPath: false,
    noChanges: false,
  });

  // The plan must be mode:suites (widen), NOT mode:suite/unit and NOT empty.
  assert.equal(
    plan.mode,
    'suites',
    `Delete-only source diff must resolve to mode:suites, got mode:${plan.mode} — old ACMR filter would have produced empty changedFiles → mode:suite/unit (smoke only), silently skipping integration/security`,
  );
  assert.deepEqual(
    plan.suites,
    PR_FULL_SUITES,
    `Delete-only widen plan must cover all PR_FULL_SUITES, got: ${JSON.stringify(plan.suites)}`,
  );
});

// ---------------------------------------------------------------------------
// Regression: rename-stale-old-path
// ---------------------------------------------------------------------------

test('regression(rename-stale-old-path): deleted old path triggers widen, protecting stale importers', (t) => {
  // Arrange: simulate the DELETE side of a rename.
  // oldname.cjs is absent from disk (renamed away); newname.cjs is present with
  // a concrete test dependent.  A stale importer still requiring oldname.cjs
  // would break at runtime, but static analysis cannot see it (the stale importer
  // is not in this fixture).  The correct safe behaviour is to widen, not to
  // select only newname.cjs's dependents — which would silently skip the stale
  // importer's tests.
  //
  // With --no-renames, git emits Delete(oldname.cjs) + Add(newname.cjs).
  // oldname.cjs is absent on disk → not in the forward graph → zero static
  // dependents → widen backstop fires → mode:suites (PR_FULL_SUITES).
  const dir = makeFixture({
    // newname.cjs exists; oldname.cjs intentionally absent (it was renamed away)
    'gsd-core/bin/lib/newname.cjs': `'use strict';\nmodule.exports = { v: 2 };\n`,
    'tests/newname.test.cjs': `'use strict';\nconst x = require('../gsd-core/bin/lib/newname.cjs');\n`,
    'tests/unrelated.test.cjs': `'use strict';\n// no dependency on oldname or newname\n`,
  });
  t.after(() => cleanup(dir));

  // Act
  const allTests = ['tests/newname.test.cjs', 'tests/unrelated.test.cjs'];
  const reverseIndex = buildTransitiveReverseIndex(dir, allTests);

  // changedFiles mirrors what --no-renames git diff emits for a rename:
  //   Delete(old) + Add(new)
  const changedFiles = [
    'gsd-core/bin/lib/oldname.cjs', // deleted old path — absent from disk
    'gsd-core/bin/lib/newname.cjs', // added new path — present on disk
  ];

  // Assert: oldname.cjs must have zero static dependents (not in graph)
  const oldDependents = reverseIndex.get('gsd-core/bin/lib/oldname.cjs');
  assert.ok(
    !oldDependents || oldDependents.size === 0,
    `oldname.cjs must have no static dependents (absent from disk), got: ${JSON.stringify(oldDependents && [...oldDependents])}`,
  );

  const selected = pickAffectedTests(changedFiles, allTests, reverseIndex, { detectWiden: true });

  // Widen must be signalled because oldname.cjs has no static dependents
  assert.ok(
    selected._widenRequired === true,
    `Expected _widenRequired=true because deleted old path has no static dependents; got: ${JSON.stringify(selected._widenRequired)}`,
  );

  const plan = resolveRunPlan({
    changedFiles,
    selected,
    widenRequired: selected._widenRequired === true,
    criticalPath: false,
    noChanges: false,
  });

  // Plan must be mode:suites — conservative widen covers any stale importer
  assert.equal(
    plan.mode,
    'suites',
    `Rename (old-path delete) must resolve to mode:suites, got mode:${plan.mode}`,
  );
  assert.deepEqual(
    plan.suites,
    PR_FULL_SUITES,
    `Rename widen plan must cover all PR_FULL_SUITES, got: ${JSON.stringify(plan.suites)}`,
  );
});

test('regression(delete-only-test): deleting a test file does not trigger widen and does not select the absent test', (t) => {
  // Arrange: fixture has one surviving test; tests/gone.test.cjs is NOT on disk.
  const dir = makeFixture({
    'tests/surviving.test.cjs': `'use strict';\n// a plain surviving unit test\n`,
  });
  t.after(() => cleanup(dir));

  // Act
  // allTests comes from the fixture's tests/ directory — gone.test.cjs is absent.
  const allTests = ['tests/surviving.test.cjs'];
  const reverseIndex = buildTransitiveReverseIndex(dir, allTests);

  const changedFiles = ['tests/gone.test.cjs'];

  const selected = pickAffectedTests(changedFiles, allTests, reverseIndex, { detectWiden: true });

  // Assert: the deleted test file must NOT appear in selected (can't run it).
  assert.ok(
    !selected.includes('tests/gone.test.cjs'),
    `Deleted test file must not appear in selection, got: ${JSON.stringify(selected)}`,
  );

  // Assert: widen must NOT be triggered (a deleted test is not impactful for selection).
  assert.ok(
    selected._widenRequired !== true,
    `Deleted test file must not trigger widen, got _widenRequired=${JSON.stringify(selected._widenRequired)}`,
  );

  const plan = resolveRunPlan({
    changedFiles,
    selected,
    widenRequired: selected._widenRequired === true,
    criticalPath: false,
    noChanges: false,
  });

  // A delete-only test-file diff with no surviving selection → unit smoke (not widen).
  assert.equal(
    plan.mode,
    'suite',
    `Delete-only test-file diff must resolve to mode:suite (smoke), got mode:${plan.mode}`,
  );
  assert.equal(
    plan.suite,
    'unit',
    `Delete-only test-file diff must run unit smoke, got suite:${plan.suite}`,
  );
});
