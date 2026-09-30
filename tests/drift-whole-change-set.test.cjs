/**
 * detectDrift sees the whole change set and sanitizes its output (#5134,
 * Phase 5 of epic #5056).
 *
 * Behaviour rows T1-T14, C1-C3 and the fast-check properties P1 / P2 with
 * their positive controls P1c / P2c. The library is driven in-process; the
 * CLI rows run `verify codebase-drift` in a temp git repository.
 *
 * Inverse-territory rule under test: an addition is drift OUTSIDE mapped
 * territory, a modification or deletion is drift INSIDE it; a rename is a
 * deletion of the old path plus an addition of the new path.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const {
  createTempGitProject,
  cleanup,
  runGsdTools,
} = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const {
  detectDrift,
  chooseAffectedPaths,
  writeMappedCommit,
  DRIFT_CATEGORIES,
} = require('../gsd-core/bin/lib/drift.cjs');

const SEVEN_DOCS = [
  'STACK.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md',
  'TESTING.md', 'INTEGRATIONS.md', 'CONCERNS.md',
];

const WITHHELD_STATEMENT = 'path(s) withheld: absolute, traversal or shell-metacharacter paths';

// Test-side statement of the allowlist policy: repo-relative components of
// [A-Za-z0-9_.-] (not starting with `-`), separated by `/`, no `..`.
const SAFE = /^(?!.*\.\.)[A-Za-z0-9_.][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)*$/;
const isSafe = (p) => typeof p === 'string' && SAFE.test(p);

function git(cwd, ...args) {
  return gitOrThrow(args, { cwd }).trim();
}

function docs(structure, extra = {}) {
  return { 'STRUCTURE.md': structure, ...extra };
}

function run(overrides) {
  return detectDrift({
    addedFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    threshold: 1,
    ...overrides,
  });
}

function topOf(p) {
  return p.split('/')[0];
}

function assertWithheldCovers(withheldPaths, hostilePaths) {
  for (const p of hostilePaths) {
    assert.ok(
      withheldPaths.includes(p) || withheldPaths.includes(topOf(p)),
      `withheldPaths ${JSON.stringify(withheldPaths)} must name ${JSON.stringify(p)} or its top-level directory`,
    );
  }
  for (const w of withheldPaths) {
    assert.ok(!isSafe(w), `a withheld path must be one the allowlist rejects: ${JSON.stringify(w)}`);
  }
}

// ─── T1 / T2 / T3: modified and deleted files inside mapped territory ────────

describe('detectDrift — modification and deletion are drift inside mapped territory (#5134)', () => {
  const structure = '# Structure\n\n- `src/lib/` — helpers\n';

  test('T1: a modified file under a mapped directory is a `modified` element', () => {
    const r = run({ modifiedFiles: ['src/lib/a.ts'], documents: docs(structure) });
    assert.strictEqual(r.skipped, false);
    assert.deepStrictEqual(r.elements, [{ category: 'modified', path: 'src/lib/a.ts' }]);
    assert.deepStrictEqual(r.counts, { added: 0, modified: 1, deleted: 0 });
  });

  test('T2: a deleted file under a mapped directory is a `deleted` element', () => {
    const r = run({ deletedFiles: ['src/lib/gone.ts'], documents: docs(structure) });
    assert.strictEqual(r.skipped, false);
    assert.deepStrictEqual(r.elements, [{ category: 'deleted', path: 'src/lib/gone.ts' }]);
    assert.deepStrictEqual(r.counts, { added: 0, modified: 0, deleted: 1 });
  });

  test('T3: a modified or deleted file outside mapped territory is not drift', () => {
    const r = run({
      modifiedFiles: ['zzz/edited.ts'],
      deletedFiles: ['yyy/removed.ts'],
      documents: docs(structure),
    });
    assert.deepStrictEqual(r.elements, []);
    assert.strictEqual(r.actionRequired, false);
    assert.deepStrictEqual(r.counts, { added: 0, modified: 1, deleted: 1 });
  });

  test('T3: an added file under the same mapped directory stays not-drift (inverse rule)', () => {
    const r = run({ addedFiles: ['src/lib/fresh.ts'], documents: docs(structure) });
    assert.deepStrictEqual(r.elements, []);
  });
});

// ─── T4: edits count against the threshold (limit-1 / limit / limit+1) ───────

describe('detectDrift — edits-only change sets gate on the threshold (#5134)', () => {
  const structure = '# Structure\n\n- `src/`\n';
  const files = (n, prefix) => Array.from({ length: n }, (_, i) => `src/${prefix}${i}.ts`);

  for (const threshold of [1, 3, 5]) {
    for (const kind of ['modified', 'deleted']) {
      const key = kind === 'modified' ? 'modifiedFiles' : 'deletedFiles';
      test(`T4: ${kind} — ${threshold - 1} / ${threshold} / ${threshold + 1} files at threshold ${threshold}`, () => {
        const at = (n) => run({ [key]: files(n, 'f'), documents: docs(structure), threshold });
        const below = at(threshold - 1);
        const exact = at(threshold);
        const above = at(threshold + 1);
        assert.strictEqual(below.elements.length, threshold - 1);
        assert.strictEqual(below.actionRequired, false, 'limit-1 must not require action');
        assert.strictEqual(exact.elements.length, threshold);
        assert.strictEqual(exact.actionRequired, true, 'limit must require action');
        assert.strictEqual(above.elements.length, threshold + 1);
        assert.strictEqual(above.actionRequired, true, 'limit+1 must require action');
      });
    }
  }

  test('T4: modified and deleted elements are counted together', () => {
    const r = run({
      modifiedFiles: files(1, 'm'),
      deletedFiles: files(1, 'd'),
      documents: docs(structure),
      threshold: 2,
    });
    assert.strictEqual(r.actionRequired, true);
    assert.deepStrictEqual(
      r.elements.map((e) => `${e.category}:${e.path}`),
      ['deleted:src/d0.ts', 'modified:src/m0.ts'],
    );
  });
});

// ─── T5: mapped territory is the whole corpus ────────────────────────────────

describe('detectDrift — territory comes from every provided document (#5134)', () => {
  const structure = '# Structure\n\nnothing of note\n';
  const architecture = '# Architecture\n\nServices live in `services/api/`.\n';

  test('T5: an added file under a directory named only in ARCHITECTURE.md is not new_dir', () => {
    const withArch = run({
      addedFiles: ['services/api/x.ts'],
      documents: docs(structure, { 'ARCHITECTURE.md': architecture }),
    });
    assert.deepStrictEqual(withArch.elements, []);
    const withoutArch = run({ addedFiles: ['services/api/x.ts'], documents: docs(structure) });
    assert.deepStrictEqual(withoutArch.elements, [{ category: 'new_dir', path: 'services/api/x.ts' }]);
  });

  test('T5: a modified file under a directory named only in ARCHITECTURE.md is `modified`', () => {
    const withArch = run({
      modifiedFiles: ['services/api/y.ts'],
      documents: docs(structure, { 'ARCHITECTURE.md': architecture }),
    });
    assert.deepStrictEqual(withArch.elements, [{ category: 'modified', path: 'services/api/y.ts' }]);
    const withoutArch = run({ modifiedFiles: ['services/api/y.ts'], documents: docs(structure) });
    assert.deepStrictEqual(withoutArch.elements, []);
  });

  test('T5: every one of the seven document names contributes territory', () => {
    for (const name of SEVEN_DOCS) {
      const r = run({
        modifiedFiles: ['owned/by/doc.ts'],
        documents: docs(name === 'STRUCTURE.md' ? '# owned/by/' : '# nothing', name === 'STRUCTURE.md' ? {} : { [name]: '# owned/by/' }),
      });
      assert.deepStrictEqual(
        r.elements,
        [{ category: 'modified', path: 'owned/by/doc.ts' }],
        `${name} must count as mapped territory`,
      );
    }
  });
});

// ─── T6 / T7: the `documents` input contract ─────────────────────────────────

describe('detectDrift — documents input contract (#5134)', () => {
  const base = { addedFiles: ['foo/bar.ts'], modifiedFiles: [], deletedFiles: [] };

  test('T6: a missing STRUCTURE.md document skips with missing-structure-md', () => {
    for (const documents of [{}, undefined, null, { 'ARCHITECTURE.md': '# a' }]) {
      const r = detectDrift({ ...base, documents });
      assert.strictEqual(r.skipped, true, JSON.stringify(documents));
      assert.strictEqual(r.reason, 'missing-structure-md');
      assert.strictEqual(r.actionRequired, false);
      assert.deepStrictEqual(r.elements, []);
    }
  });

  test('T6: a non-string STRUCTURE.md document skips with invalid-structure-md', () => {
    for (const bad of [42, {}, ['# x'], true]) {
      const r = detectDrift({ ...base, documents: { 'STRUCTURE.md': bad } });
      assert.strictEqual(r.skipped, true, JSON.stringify(bad));
      assert.strictEqual(r.reason, 'invalid-structure-md');
      assert.strictEqual(r.actionRequired, false);
    }
  });

  test('T6: other documents that are absent or non-string are ignored, not fatal', () => {
    const r = detectDrift({
      ...base,
      threshold: 1,
      documents: {
        'STRUCTURE.md': '# nothing',
        'STACK.md': 5,
        'ARCHITECTURE.md': null,
        'CONCERNS.md': {},
        'TESTING.md': ['foo/'],
      },
    });
    assert.strictEqual(r.skipped, false);
    // A corrupt document contributes no territory: `foo/` is still unmapped.
    assert.deepStrictEqual(r.elements, [{ category: 'new_dir', path: 'foo/bar.ts' }]);
  });

  test('T6: malformed input never throws', () => {
    assert.doesNotThrow(() => detectDrift({ ...base, documents: 'STRUCTURE.md' }));
    assert.doesNotThrow(() => detectDrift({ ...base, documents: [] }));
    assert.doesNotThrow(() => detectDrift({ ...base, documents: { 'STRUCTURE.md': undefined } }));
  });

  test('T7: `structureMd` is no longer read', () => {
    const alone = detectDrift({ ...base, structureMd: '# foo/ is mapped' });
    assert.strictEqual(alone.skipped, true);
    assert.strictEqual(alone.reason, 'missing-structure-md');
  });

  test('T7: `structureMd` beside `documents` adds no territory', () => {
    const r = detectDrift({
      ...base,
      threshold: 1,
      structureMd: '# foo/ is mapped',
      documents: { 'STRUCTURE.md': '# nothing' },
    });
    assert.deepStrictEqual(r.elements, [{ category: 'new_dir', path: 'foo/bar.ts' }]);
  });
});

// ─── T9 / T10: categories ────────────────────────────────────────────────────

describe('detectDrift — categories (#5134)', () => {
  test('T9: added-file categories are unchanged (migration > route > barrel > new_dir)', () => {
    const r = run({
      addedFiles: [
        'supabase/migrations/1.sql',
        'apps/web/src/routes/j.ts',
        'packages/ui/src/index.ts',
        'newpkg/thing.ts',
        'src/lib/ordinary.ts',
      ],
      documents: docs('# Structure\n\n- `src/lib/`\n- `supabase/`\n'),
    });
    assert.deepStrictEqual(
      r.elements.map((e) => `${e.category}:${e.path}`),
      [
        'barrel:packages/ui/src/index.ts',
        'migration:supabase/migrations/1.sql',
        'new_dir:newpkg/thing.ts',
        'route:apps/web/src/routes/j.ts',
      ],
    );
  });

  test('T10: DRIFT_CATEGORIES lists the six categories in priority order', () => {
    assert.deepStrictEqual(
      [...DRIFT_CATEGORIES],
      ['new_dir', 'barrel', 'migration', 'route', 'modified', 'deleted'],
    );
  });

  test('T10: the message labels modified and deleted files', () => {
    const r = run({
      modifiedFiles: ['src/lib/a.ts'],
      deletedFiles: ['src/lib/b.ts'],
      documents: docs('# Structure\n\n- `src/lib/`\n'),
      threshold: 2,
    });
    const lines = r.message.split('\n');
    const mod = lines.indexOf('Modified files in mapped directories:');
    const del = lines.indexOf('Deleted files in mapped directories:');
    assert.ok(mod >= 0, `missing modified label in ${JSON.stringify(r.message)}`);
    assert.ok(del >= 0, `missing deleted label in ${JSON.stringify(r.message)}`);
    assert.strictEqual(lines[mod + 1], '  - src/lib/a.ts');
    assert.strictEqual(lines[del + 1], '  - src/lib/b.ts');
  });
});

// ─── T11-T14: the output seam ────────────────────────────────────────────────

describe('detectDrift — output is sanitized (#4923, #5134)', () => {
  const structure = '# Structure\n\nnothing mapped\n';
  const hostile = ['foo bar/x.js', 'a;rm -rf/x.js', '-rf/x', '$(id)/x'];

  for (const action of ['warn', 'auto-remap']) {
    test(`T11: hostile added paths never reach affectedPaths or the message (${action})`, () => {
      const r = run({
        addedFiles: [...hostile, 'goodpkg/y.js'],
        documents: docs(structure),
        action,
      });
      assert.strictEqual(r.actionRequired, true);
      assert.deepStrictEqual(r.affectedPaths, ['goodpkg']);
      for (const needle of ['foo bar', 'rm -rf', '-rf/x', '$(id)']) {
        assert.ok(!r.message.includes(needle), `${JSON.stringify(needle)} leaked into ${JSON.stringify(r.message)}`);
      }
      assert.ok(r.message.includes('  - goodpkg/y.js'), 'the safe path is still listed');
      assertWithheldCovers(r.withheldPaths, hostile);
      const stated = new RegExp(`(\\d+) ${WITHHELD_STATEMENT.replace(/[()]/g, '\\$&')}`).exec(r.message);
      assert.ok(stated, `message must state the withheld count: ${JSON.stringify(r.message)}`);
      assert.strictEqual(Number(stated[1]), r.withheldPaths.length, 'the message states the count of withheldPaths only');
    });
  }

  test('T11: a top-level hostile file is withheld exactly once, by name, as data', () => {
    const r = run({
      addedFiles: ['bad name.js', 'ok.js'],
      documents: docs(structure),
    });
    assert.deepStrictEqual([...new Set(r.withheldPaths)], ['bad name.js']);
    assert.deepStrictEqual(r.affectedPaths, ['ok.js']);
    assert.ok(!r.message.includes('bad name'), JSON.stringify(r.message));
  });

  test('T11: a result with nothing to withhold reports an empty withheldPaths and no count line', () => {
    const r = run({ addedFiles: ['goodpkg/y.js'], documents: docs(structure) });
    assert.deepStrictEqual(r.withheldPaths, []);
    assert.ok(!r.message.includes('withheld'), JSON.stringify(r.message));
  });

  test('T11: a non-ASCII directory name is withheld and counted, not silently dropped', () => {
    const r = run({ addedFiles: ['设计/x.md'], documents: docs(structure) });
    assert.deepStrictEqual(r.affectedPaths, []);
    assertWithheldCovers(r.withheldPaths, ['设计/x.md']);
    assert.ok(!r.message.includes('设计'), JSON.stringify(r.message));
    const stated = /(\d+) path\(s\) withheld/.exec(r.message);
    assert.ok(stated, `message must state the withheld count: ${JSON.stringify(r.message)}`);
    assert.strictEqual(Number(stated[1]), r.withheldPaths.length);
    assert.ok(r.withheldPaths.length >= 1);
  });

  test('T11: hostile modified paths inside mapped territory are withheld too', () => {
    const r = run({
      modifiedFiles: ['odd dir/x.js', 'src/ok.js'],
      documents: docs('# Structure\n\n- `odd dir/`\n- `src/`\n'),
    });
    assert.deepStrictEqual(r.elements.map((e) => e.path), ['odd dir/x.js', 'src/ok.js']);
    assert.deepStrictEqual(r.affectedPaths, ['src']);
    assert.ok(!r.message.includes('odd dir'), JSON.stringify(r.message));
    assertWithheldCovers(r.withheldPaths, ['odd dir/x.js']);
  });

  test('T12: a newline in a path never adds a message line', () => {
    const baseline = run({
      addedFiles: ['newpkg/a.ts', 'other/b.ts'],
      documents: docs(structure),
    });
    const injected = run({
      addedFiles: ['newpkg/a.ts', 'other/b.ts', 'evil\n  - injected/x.js'],
      documents: docs(structure),
    });
    const lines = injected.message.split('\n');
    assert.ok(!injected.message.includes('injected'), JSON.stringify(injected.message));
    assert.ok(!injected.message.includes('evil'), JSON.stringify(injected.message));
    assert.ok(!lines.some((l) => l.startsWith('  - injected')), 'no forged bullet line');
    const bullets = (m) => m.split('\n').filter((l) => l.startsWith('  - '));
    assert.deepStrictEqual(bullets(injected.message), bullets(baseline.message), 'the bullet list is exactly the safe paths');
  });

  test('T12: carriage returns and control characters are withheld from bullets', () => {
    const r = run({
      addedFiles: ['okpkg/a.ts', 'ctl\r\u0007/x.ts'],
      documents: docs(structure),
    });
    assert.ok(!r.message.includes('ctl'), JSON.stringify(r.message));
    assert.ok(!r.message.includes('\r'));
    assert.ok(!r.message.includes('\u0007'));
  });

  for (const action of ['warn', 'auto-remap']) {
    test(`T13: every affected path withheld → no mapper spawn and no empty --paths (${action})`, () => {
      const r = run({
        addedFiles: ['foo bar/x.js', '$(id)/x'],
        documents: docs(structure),
        action,
      });
      assert.strictEqual(r.actionRequired, true);
      assert.strictEqual(r.directive, action, 'directive is unchanged');
      assert.deepStrictEqual(r.affectedPaths, []);
      assert.strictEqual(r.spawnMapper, false, 'an empty --paths would remap the whole repo (#3418)');
      assert.doesNotMatch(r.message, /--paths\s+to refresh/);
      assert.doesNotMatch(r.message, /--paths\s*$/m);
      assert.doesNotMatch(r.message, /scheduled for paths:\s*$/m);
    });
  }

  test('T14: safe paths are unchanged in affectedPaths and in --paths', () => {
    const warn = run({
      addedFiles: ['src/a.ts', 'apps/web/b.ts'],
      documents: docs('# nothing'),
      action: 'warn',
    });
    assert.deepStrictEqual(warn.affectedPaths, ['apps/web', 'src']);
    assert.deepStrictEqual(warn.withheldPaths, []);
    assert.ok(warn.message.includes('--paths apps/web,src to refresh planning context.'), JSON.stringify(warn.message));
    assert.strictEqual(warn.spawnMapper, false);

    const auto = run({
      addedFiles: ['src/a.ts', 'apps/web/b.ts'],
      documents: docs('# nothing'),
      action: 'auto-remap',
    });
    assert.deepStrictEqual(auto.affectedPaths, ['apps/web', 'src']);
    assert.strictEqual(auto.spawnMapper, true);
    assert.ok(auto.message.includes('Auto-remap scheduled for paths: apps/web, src'), JSON.stringify(auto.message));
  });
});

// ─── P1 / P1c: every mapped edit is exactly one element ──────────────────────

const lower = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split(''));
const word = (min, max) => fc.array(lower, { minLength: min, maxLength: max }).map((a) => a.join(''));

const mappedEditArb = fc.record({
  kind: fc.constantFrom('modified', 'deleted'),
  dirs: fc.uniqueArray(word(2, 6), { minLength: 1, maxLength: 3 }),
  files: fc.uniqueArray(word(1, 6), { minLength: 1, maxLength: 5 }),
  mappedBy: fc.constantFrom('STRUCTURE.md', 'ARCHITECTURE.md'),
}).map((x) => {
  const listing = x.dirs.map((d) => `- \`${d}/\``).join('\n');
  return {
    kind: x.kind,
    paths: x.files.map((f, i) => `${x.dirs[i % x.dirs.length]}/${f}.ts`),
    documents: x.mappedBy === 'STRUCTURE.md'
      ? { 'STRUCTURE.md': `# Structure\n${listing}\n` }
      : { 'STRUCTURE.md': '# Structure', 'ARCHITECTURE.md': `# Architecture\n${listing}\n` },
  };
});

function p1Holds(detector, x) {
  const r = detector({
    addedFiles: [],
    modifiedFiles: x.kind === 'modified' ? x.paths : [],
    deletedFiles: x.kind === 'deleted' ? x.paths : [],
    documents: x.documents,
    threshold: 1,
  });
  if (r.skipped) return false;
  const got = r.elements.map((e) => `${e.category}:${e.path}`).sort();
  const want = x.paths.map((p) => `${x.kind}:${p}`).sort();
  return got.length === want.length && got.every((g, i) => g === want[i]);
}

describe('properties — mapped edits are never invisible (#5134)', () => {
  test('P1: every mapped modified / deleted path yields exactly one element of its category', () => {
    fc.assert(fc.property(mappedEditArb, (x) => p1Holds(detectDrift, x)));
  });

  test('P1c: the P1 predicate fails against a detector that drops modifiedFiles', () => {
    const dropModified = (input) => detectDrift({ ...input, modifiedFiles: [] });
    const outcome = fc.check(fc.property(
      mappedEditArb.map((x) => ({ ...x, kind: 'modified' })),
      (x) => p1Holds(dropModified, x),
    ));
    assert.strictEqual(outcome.failed, true, 'the predicate must not pass vacuously');
  });

  test('P1c: the P1 predicate fails against a detector that drops deletedFiles', () => {
    const dropDeleted = (input) => detectDrift({ ...input, deletedFiles: [] });
    const outcome = fc.check(fc.property(
      mappedEditArb.map((x) => ({ ...x, kind: 'deleted' })),
      (x) => p1Holds(dropDeleted, x),
    ));
    assert.strictEqual(outcome.failed, true, 'the predicate must not pass vacuously');
  });
});

// ─── P2 / P2c: every egress value is allowlisted text ────────────────────────

const META = [' ', ';', '|', '&', '$', '`', '(', ')', '<', '>', '"', "'", '*', '?', '!', '{', '}', '#', '~', '%', ',', ':', '=', '+', '@', '[', ']', '^', 'é', '设'];
const CTRL = [...Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)), String.fromCharCode(127)];
// The hostile character always sits in the FIRST path component, so the
// top-level prefix `chooseAffectedPaths` derives is itself hostile.
const NON_ABSOLUTE_FORMS = [
  (m) => `../${m}/f.js`,
  (m, n) => `${m}${META[n % META.length]}y/f.js`,
  (m, n) => `${m}${CTRL[n % CTRL.length]}y/f.js`,
  (m) => `${m}\n  - ${m}z/f.js`,
];
const ABSOLUTE_FORM = (m) => `/${m}/f.js`;

const hostileArb = fc.record({
  entries: fc.uniqueArray(
    fc.tuple(word(3, 7).map((w) => `zq${w}`), fc.nat(1000)),
    { selector: (t) => t[0], minLength: 1, maxLength: 5 },
  ),
  action: fc.constantFrom('warn', 'auto-remap'),
}).map((x) => {
  const paths = x.entries.map(([marker, n], i) => {
    // The first entry is never absolute: an absolute path has an empty first
    // component, which the mapped-territory check treats as mapped, so it
    // would produce no element to sanitize.
    const forms = i === 0 ? NON_ABSOLUTE_FORMS : [...NON_ABSOLUTE_FORMS, ABSOLUTE_FORM];
    return forms[n % forms.length](marker, n);
  });
  return { paths, markers: x.entries.map(([m]) => m), action: x.action };
});

function egressIsAllowlisted(result, markers) {
  if (result.skipped) return false;
  if (!result.affectedPaths.every(isSafe)) return false;
  const message = String(result.message);
  if (markers.some((m) => message.includes(m))) return false;
  for (const line of message.split('\n')) {
    const bullet = /^ {2}- (.*)$/.exec(line);
    if (bullet && !isSafe(bullet[1])) return false;
  }
  const arg = /--paths ([^\n]*?) to refresh planning context\./.exec(message);
  if (arg && arg[1] !== '' && !arg[1].split(',').every(isSafe)) return false;
  const scheduled = /Auto-remap scheduled for paths:([^\n]*)/.exec(message);
  if (scheduled) {
    const listed = scheduled[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (!listed.every(isSafe)) return false;
  }
  return true;
}

function detectInput(x) {
  return {
    addedFiles: x.paths,
    modifiedFiles: [],
    deletedFiles: [],
    documents: { 'STRUCTURE.md': '# nothing mapped' },
    threshold: 1,
    action: x.action,
  };
}

// An egress that skips the sanitizer: the real elements, unsanitized paths
// and bullets. It exists only to prove the predicate can fail.
function unsanitizedEgress(input) {
  const real = detectDrift(input);
  const paths = real.elements.map((e) => e.path);
  const affectedPaths = chooseAffectedPaths(paths);
  const message = [
    `Codebase drift detected: ${paths.length} structural element(s) since last mapping.`,
    '',
    'New directories:',
    ...paths.map((p) => `  - ${p}`),
    '',
    `Run /gsd-map-codebase --paths ${affectedPaths.join(',')} to refresh planning context.`,
  ].join('\n');
  return { ...real, affectedPaths, message };
}

describe('properties — the output seam admits only allowlisted path text (#4923, #5134)', () => {
  test('P2: hostile paths never reach affectedPaths or the message', () => {
    fc.assert(fc.property(hostileArb, (x) => egressIsAllowlisted(detectDrift(detectInput(x)), x.markers)));
  });

  test('P2: every hostile path is accounted for in withheldPaths', () => {
    fc.assert(fc.property(hostileArb, (x) => {
      const r = detectDrift(detectInput(x));
      return r.withheldPaths.every((w) => !isSafe(w)) && r.withheldPaths.length > 0;
    }));
  });

  test('P2c: the P2 predicate fails against an egress that skips sanitizePaths', () => {
    const outcome = fc.check(fc.property(
      hostileArb,
      (x) => egressIsAllowlisted(unsanitizedEgress(detectInput(x)), x.markers),
    ));
    assert.strictEqual(outcome.failed, true, 'the predicate must not pass vacuously');
  });
});

// ─── C1-C3, T8: the CLI layer ────────────────────────────────────────────────

describe('verify codebase-drift CLI — whole change set (#5134)', () => {
  let tmp;
  let codebaseDir;

  beforeEach(() => {
    tmp = createTempGitProject('gsd-drift-5134-');
    codebaseDir = path.join(tmp, '.planning', 'codebase');
    fs.mkdirSync(codebaseDir, { recursive: true });
  });
  afterEach(() => cleanup(tmp));

  function write(rel, text) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }

  function commitAll(message) {
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', message);
  }

  // Writes the map documents, stamps STRUCTURE.md at the current HEAD and
  // commits, so everything committed afterwards is drift against the map.
  function mapCodebase(structureBody, otherDocs = SEVEN_DOCS.filter((d) => d !== 'STRUCTURE.md')) {
    const structure = path.join(codebaseDir, 'STRUCTURE.md');
    fs.writeFileSync(structure, structureBody);
    for (const doc of otherDocs) {
      fs.writeFileSync(path.join(codebaseDir, doc), `# ${doc}\n\nBody.\n`);
    }
    writeMappedCommit(structure, git(tmp, 'rev-parse', 'HEAD'), '2026-09-30');
    commitAll('map codebase');
  }

  function configure(workflow) {
    write('.planning/config.json', JSON.stringify({ workflow }, null, 2));
  }

  function drift() {
    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    return JSON.parse(r.output);
  }

  function seedEditable(count) {
    for (let i = 0; i < count; i++) write(`src/f${i}.js`, 'one\n');
    commitAll('seed');
  }

  function editAll(count) {
    for (let i = 0; i < count; i++) write(`src/f${i}.js`, 'two\n');
    commitAll('edit');
  }

  test('C1: edits inside a mapped directory past the stamp are reported', () => {
    seedEditable(3);
    mapCodebase('# Codebase Structure\n\n- `src/`\n');
    editAll(3);

    const data = drift();
    assert.strictEqual(data.skipped, false);
    assert.strictEqual(data.action_required, true);
    assert.strictEqual(data.block, true);
    assert.deepStrictEqual(data.elements, [
      { category: 'modified', path: 'src/f0.js' },
      { category: 'modified', path: 'src/f1.js' },
      { category: 'modified', path: 'src/f2.js' },
    ]);
    assert.deepStrictEqual(data.affected_paths, ['src']);
    assert.deepStrictEqual([...data.documents_read].sort(), [...SEVEN_DOCS].sort());
    assert.deepStrictEqual(data.documents_unreadable, []);
    assert.deepStrictEqual(data.withheld_paths, []);
  });

  for (const edits of [2, 3, 4]) {
    test(`C1: ${edits} edits against the default threshold of 3 → action_required ${edits >= 3}`, () => {
      seedEditable(edits);
      mapCodebase('# Codebase Structure\n\n- `src/`\n');
      editAll(edits);
      const data = drift();
      assert.strictEqual(data.elements.length, edits);
      assert.strictEqual(data.action_required, edits >= 3);
    });
  }

  test('C1: deletions inside a mapped directory are reported as `deleted`', () => {
    seedEditable(3);
    mapCodebase('# Codebase Structure\n\n- `src/`\n');
    for (let i = 0; i < 3; i++) fs.unlinkSync(path.join(tmp, `src/f${i}.js`));
    commitAll('delete');

    const data = drift();
    assert.strictEqual(data.action_required, true);
    assert.deepStrictEqual(data.elements, [
      { category: 'deleted', path: 'src/f0.js' },
      { category: 'deleted', path: 'src/f1.js' },
      { category: 'deleted', path: 'src/f2.js' },
    ]);
  });

  test('C1: a directory named only in a non-STRUCTURE document is mapped territory', () => {
    seedEditable(1);
    mapCodebase('# Codebase Structure\n\nnothing\n', SEVEN_DOCS.filter((d) => d !== 'STRUCTURE.md' && d !== 'ARCHITECTURE.md'));
    fs.writeFileSync(path.join(codebaseDir, 'ARCHITECTURE.md'), '# Architecture\n\n- `src/`\n');
    commitAll('architecture names src');
    editAll(1);

    const data = drift();
    assert.deepStrictEqual(data.elements, [{ category: 'modified', path: 'src/f0.js' }]);
  });

  test('C2: an unreadable non-STRUCTURE document is omitted, named, and the result still computed', () => {
    seedEditable(3);
    mapCodebase('# Codebase Structure\n\n- `src/`\n', ['ARCHITECTURE.md']);
    fs.mkdirSync(path.join(codebaseDir, 'STACK.md'));
    editAll(3);

    const data = drift();
    assert.strictEqual(data.skipped, false);
    assert.strictEqual(data.action_required, true);
    assert.deepStrictEqual(data.documents_unreadable, ['STACK.md']);
    assert.deepStrictEqual([...data.documents_read].sort(), ['ARCHITECTURE.md', 'STRUCTURE.md']);
    assert.strictEqual(data.elements.length, 3);
  });

  test('T8: a rename is a deletion of the old path plus an addition of the new path', () => {
    write('src/old.js', Array.from({ length: 30 }, (_, i) => `line ${i} of the file`).join('\n') + '\n');
    commitAll('seed');
    mapCodebase('# Codebase Structure\n\n- `src/`\n');
    fs.mkdirSync(path.join(tmp, 'newdir'));
    git(tmp, 'mv', 'src/old.js', 'newdir/new.js');
    commitAll('rename out of the mapped directory');

    const data = drift();
    assert.deepStrictEqual(data.elements, [
      { category: 'deleted', path: 'src/old.js' },
      { category: 'new_dir', path: 'newdir/new.js' },
    ]);
  });

  test('T8: a copy is an addition of the new path only', () => {
    git(tmp, 'config', 'diff.renames', 'copies');
    const body = Array.from({ length: 30 }, (_, i) => `line ${i} of the file`).join('\n') + '\n';
    write('src/a.js', body);
    commitAll('seed');
    mapCodebase('# Codebase Structure\n\n- `src/`\n');
    const base = git(tmp, 'rev-parse', 'HEAD');
    write('src/a.js', body + 'appended\n');
    write('newdir/b.js', body + 'appended\n');
    commitAll('modify a source and copy it out of the mapped directory');
    assert.match(
      git(tmp, 'diff', '--name-status', base, 'HEAD'),
      /^C\d+\tsrc\/a\.js\tnewdir\/b\.js$/m,
      'precondition: git reported a copy line',
    );

    const data = drift();
    assert.deepStrictEqual(data.elements, [
      { category: 'modified', path: 'src/a.js' },
      { category: 'new_dir', path: 'newdir/b.js' },
    ]);
  });

  test('C3: a hostile added path is withheld from affected_paths and message, and named in withheld_paths', () => {
    seedEditable(1);
    mapCodebase('# Codebase Structure\n\n- `src/`\n');
    configure({ drift_threshold: 1, drift_action: 'auto-remap' });
    const hostile = ['qq zz/x.js', 'qq;yy/x.js', '$(qq)/x.js'];
    for (const p of hostile) write(p, 'x\n');
    write('goodpkg/x.js', 'x\n');
    commitAll('add hostile and safe directories');

    const data = drift();
    assert.strictEqual(data.action_required, true);
    assert.deepStrictEqual(data.affected_paths, ['goodpkg']);
    assert.strictEqual(data.spawn_mapper, true);
    assert.ok(!data.message.includes('qq'), JSON.stringify(data.message));
    assert.ok(!data.message.includes('$(qq)'), JSON.stringify(data.message));
    assertWithheldCovers(data.withheld_paths, hostile);
    for (const p of hostile) {
      assert.ok(data.elements.some((e) => e.path === p), `the element for ${p} is still reported`);
    }
  });

  test('C3: every affected path withheld → spawn_mapper is false even under auto-remap', () => {
    seedEditable(1);
    mapCodebase('# Codebase Structure\n\n- `src/`\n');
    configure({ drift_threshold: 1, drift_action: 'auto-remap' });
    const hostile = ['qq zz/x.js', 'qq;yy/x.js'];
    for (const p of hostile) write(p, 'x\n');
    commitAll('add hostile directories');

    const data = drift();
    assert.strictEqual(data.action_required, true);
    assert.strictEqual(data.directive, 'auto-remap');
    assert.deepStrictEqual(data.affected_paths, []);
    assert.strictEqual(data.spawn_mapper, false);
    assert.doesNotMatch(data.message, /scheduled for paths:\s*$/m);
    assertWithheldCovers(data.withheld_paths, hostile);
  });
});
