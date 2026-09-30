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
  sanitizePaths,
  displaySafePath,
  writeMappedCommit,
  DRIFT_CATEGORIES,
} = require('../gsd-core/bin/lib/drift.cjs');

const SEVEN_DOCS = [
  'STACK.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md',
  'TESTING.md', 'INTEGRATIONS.md', 'CONCERNS.md',
];

const WITHHELD_STATEMENT = 'path(s) withheld: not passed to the mapper or listed (absolute, traversal, whitespace, non-ASCII or shell-metacharacter characters)';

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
      const statedLine = r.message.split('\n').find((l) => l.endsWith(WITHHELD_STATEMENT));
      const stated = statedLine === undefined ? null : /^(\d+) /.exec(statedLine);
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

// ─── Review findings: display safety, boundaries, one-component rules ────────

const escapeOf = (cp) => '\\u' + cp.toString(16).padStart(4, '0');

describe('displaySafePath — escapes what can rewrite a terminal, keeps the rest', () => {
  const escaped = [
    0x0000, 0x0007, 0x001b, 0x001f, // C0
    0x007f, // DEL
    0x0080, 0x008d, 0x009f, // C1
    0x061c, // Arabic letter mark
    0x200e, 0x200f, // LRM / RLM
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // embeddings and overrides
    0x2066, 0x2067, 0x2068, 0x2069, // isolates
    0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, // zero-width
    0x2028, 0x2029, // line / paragraph separators
  ];
  for (const cp of escaped) {
    test(`U+${cp.toString(16).toUpperCase().padStart(4, '0')} becomes its \\u escape`, () => {
      assert.strictEqual(displaySafePath(`a${String.fromCodePoint(cp)}b`), `a${escapeOf(cp)}b`);
    });
  }

  const untouched = [
    ['space', 'docs/My Notes.md'],
    ['ordinary ASCII', 'src/lib/a-b_c.d.ts'],
    ['CJK', 'docs/设计.md'],
    ['astral emoji (surrogate pair)', 'docs/😀.md'],
    ['NBSP U+00A0 (first char after C1)', 'a\u00a0b'],
    ['U+202F narrow no-break space', 'a\u202fb'],
    ['U+2065 (unassigned, inside the isolate gap)', 'a\u2065b'],
    ['U+200A hair space (just below zero-width)', 'a\u200ab'],
    ['U+2061 (just above word joiner)', 'a\u2061b'],
    ['U+FFFE', 'a\ufffeb'],
    ['backslash', 'a\\u0000b'],
  ];
  for (const [label, input] of untouched) {
    test(`${label} is left untouched`, () => {
      assert.strictEqual(displaySafePath(input), input);
    });
  }

  test('a hostile path renders as one inert line', () => {
    assert.strictEqual(
      displaySafePath('x\r\n  - injected/\u001b[31mred\u202eevil'),
      'x\\u000d\\u000a  - injected/\\u001b[31mred\\u202eevil',
    );
  });

  for (const [units, label] of [[199, 'limit-1'], [200, 'limit']]) {
    test(`${units} code units (${label}) pass through unchanged`, () => {
      const input = 'a'.repeat(units);
      assert.strictEqual(displaySafePath(input), input);
    });
  }

  test('201 code units (limit+1) are cut to 199 + ellipsis = 200', () => {
    const out = displaySafePath('a'.repeat(201));
    assert.strictEqual(out, 'a'.repeat(199) + '…');
    assert.strictEqual(out.length, 200);
  });

  test('an astral character ending exactly at the limit is kept whole', () => {
    const input = 'a'.repeat(198) + '😀';
    assert.strictEqual(input.length, 200);
    assert.strictEqual(displaySafePath(input), input);
  });

  test('a surrogate pair straddling the cut is dropped whole, never split', () => {
    assert.strictEqual(displaySafePath('a'.repeat(199) + '😀'), 'a'.repeat(199) + '…');
    assert.strictEqual(displaySafePath('a'.repeat(198) + '😀b'), 'a'.repeat(198) + '…');
  });

  test('an escape is never cut in half', () => {
    const out = displaySafePath('a'.repeat(195) + '\u0000' + 'b'.repeat(10));
    assert.strictEqual(out, 'a'.repeat(195) + '…');
  });

  test('the cap applies to the escaped text, not the raw text', () => {
    const out = displaySafePath('\u0000'.repeat(40));
    assert.strictEqual(out, '\\u0000'.repeat(33) + '…');
    assert.strictEqual(out.length, 199);
  });

  const codePointArb = fc.oneof(
    fc.integer({ min: 0, max: 0x2100 }),
    fc.integer({ min: 0, max: 0x10ffff }).filter((cp) => cp < 0xd800 || cp > 0xdfff),
  );
  const textArb = fc
    .array(codePointArb, { maxLength: 300 })
    .map((cps) => String.fromCodePoint(...cps));
  const UNSAFE_RANGES = [
    [0x0000, 0x001f], [0x007f, 0x009f], [0x061c, 0x061c], [0x200b, 0x200f], [0x2028, 0x2029],
    [0x202a, 0x202e], [0x2060, 0x2060], [0x2066, 0x2069], [0xfeff, 0xfeff],
  ];
  const hasUnsafe = (t) => [...t].some((ch) => {
    const cp = ch.codePointAt(0);
    return UNSAFE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
  });
  const hasLoneSurrogate = (t) => /[\ud800-\udfff]/.test(t.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''));

  test('property: output has no unsafe character, no split surrogate, is at most 200 units and is idempotent', () => {
    fc.assert(fc.property(textArb, (t) => {
      const out = displaySafePath(t);
      return !hasUnsafe(out)
        && !hasLoneSurrogate(out)
        && out.length <= 200
        && displaySafePath(out) === out;
    }));
  });

  test('property: safe text within the cap is returned unchanged', () => {
    const safeArb = fc
      .array(fc.constantFrom(...'ab/._- 设计😀'), { maxLength: 200 })
      .map((chars) => chars.join(''))
      .filter((t) => t.length <= 200);
    fc.assert(fc.property(safeArb, (t) => displaySafePath(t) === t));
  });
});

describe('isPathMapped boundaries — a mapped prefix matches at path-component boundaries', () => {
  const structureOnly = (text) => ({ 'STRUCTURE.md': text });
  const edited = (file, text) => run({ modifiedFiles: [file], documents: structureOnly(text) }).elements;

  const mapped = [
    ['`api/` on its own', 'api/x.js', '- `api/`'],
    ['`src/lib/` names src/lib', 'src/lib/a.ts', 'See `src/lib/` for helpers'],
    ['backticked `src/lib`', 'src/lib/a.ts', 'See `src/lib` for helpers'],
    ['prefix at the start of the corpus', 'src/lib/a.ts', 'src/lib holds helpers'],
    ['prefix at the end of the corpus', 'src/lib/a.ts', 'helpers live in src/lib'],
    ['sentence-final dot after the prefix', 'lib/a.ts', 'helpers live in lib.'],
    ['a comma after the prefix', 'lib/a.ts', 'lib, bin'],
    ['a slash before the prefix (nested mention)', 'lib/a.ts', 'see packages/x/lib/ here'],
    ['a parenthesis before the prefix', 'lib/a.ts', '(lib/)'],
    ['a deeper prefix maps a deeper file', 'src/lib/deep/a.ts', 'src/lib/deep/'],
    ['a single-component file via `name/`', 'Makefile', 'the Makefile/ entry'],
    ['a single-component file via backticks', 'Makefile', 'the `Makefile` entry'],
  ];
  for (const [label, file, text] of mapped) {
    test(`mapped: ${label}`, () => {
      assert.deepStrictEqual(edited(file, text), [{ category: 'modified', path: file }]);
    });
  }

  const unmapped = [
    ['`api` is not mapped by the word capital', 'api/x.js', 'the capital city'],
    ['`api` is not mapped by the word therapist', 'api/x.js', 'a therapist'],
    ['`lib` is not mapped by the word library', 'lib/a.ts', 'the library of things'],
    ['`lib` is not mapped by `sublib`', 'lib/a.ts', 'the sublib module'],
    ['`app/lib` is not mapped by `applib`', 'app/lib/a.ts', 'the applib module'],
    ['`lib` is not mapped by `lib2`', 'lib/a.ts', 'see lib2 here'],
    ['`lib` is not mapped by `lib_old`', 'lib/a.ts', 'see lib_old here'],
    ['`lib` is not mapped by `lib-old`', 'lib/a.ts', 'see lib-old here'],
    ['a dot before the prefix continues a name', 'lib/a.ts', 'see x.lib here'],
    ['a digit before the prefix continues a name', 'lib/a.ts', 'see 2lib here'],
    ['an underscore before the prefix continues a name', 'lib/a.ts', 'see my_lib here'],
    ['a dash before the prefix continues a name', 'lib/a.ts', 'see my-lib here'],
    ['a root-level file is not mapped by a longer word', 'Makefile', 'the Makefiles/ entry'],
  ];
  for (const [label, file, text] of unmapped) {
    test(`unmapped: ${label}`, () => {
      assert.deepStrictEqual(edited(file, text), []);
    });
  }

  test('an added file under a word-only mention is still new_dir', () => {
    const r = run({ addedFiles: ['api/x.js'], documents: structureOnly('the capital city') });
    assert.deepStrictEqual(r.elements, [{ category: 'new_dir', path: 'api/x.js' }]);
  });

  test('a regex-special prefix is matched literally', () => {
    const r = run({ modifiedFiles: ['a.b/x.js'], documents: structureOnly('the a-b/ directory and aXb/') });
    assert.deepStrictEqual(r.elements, []);
    const r2 = run({ modifiedFiles: ['a.b/x.js'], documents: structureOnly('the `a.b/` directory') });
    assert.deepStrictEqual(r2.elements, [{ category: 'modified', path: 'a.b/x.js' }]);
  });

  test('a corpus of 200000 near-miss occurrences is scanned to a definite answer', () => {
    const r = run({ modifiedFiles: ['lib/a.ts'], documents: structureOnly('lib'.repeat(200000)) });
    assert.deepStrictEqual(r.elements, []);
  });
});

describe('withheld-path accounting is neutral about why a path was withheld (#5134 review)', () => {
  const structure = '# Structure\n\n- `docs/`\n';

  test('ordinary modified files inside a mapped directory are elements and withheld, described neutrally', () => {
    const r = run({
      modifiedFiles: ['docs/My Notes.md', 'docs/设计.md', 'docs/plain.md'],
      documents: docs(structure),
    });
    assert.deepStrictEqual(r.elements.map((e) => e.path), ['docs/My Notes.md', 'docs/plain.md', 'docs/设计.md']);
    assert.deepStrictEqual(r.withheldPaths, ['docs/My Notes.md', 'docs/设计.md']);
    assert.deepStrictEqual(r.affectedPaths, ['docs']);
    assert.ok(
      r.message.split('\n').includes(`2 ${WITHHELD_STATEMENT}`),
      `the withheld line is exactly the neutral wording: ${JSON.stringify(r.message)}`,
    );
    assert.ok(!r.message.includes('My Notes') && !r.message.includes('设计'));
  });
});

describe('chooseAffectedPaths and sanitizePaths — never produce the whole repo', () => {
  test('a path with an empty first component yields no affected path', () => {
    assert.deepStrictEqual(chooseAffectedPaths(['/x']), []);
    assert.deepStrictEqual(chooseAffectedPaths(['/x', 'src/a.ts']), ['src']);
    assert.deepStrictEqual(chooseAffectedPaths(['/x/apps/y', 'apps/web/z.ts']), ['apps/web']);
  });

  for (const action of ['warn', 'auto-remap']) {
    test(`a run whose only path is absolute spawns no mapper and lists no empty --paths (${action})`, () => {
      const r = run({ addedFiles: ['/x/a.js'], documents: docs('# nothing'), action });
      assert.strictEqual(r.actionRequired, true);
      assert.deepStrictEqual(r.affectedPaths, []);
      assert.strictEqual(r.spawnMapper, false);
      assert.deepStrictEqual(r.withheldPaths, ['/x/a.js']);
    });
  }

  const rejected = ['.', './', './src', 'src/.', 'src/./lib', 'a/./b/.', '..', '.hidden/../x', '...x'];
  for (const p of rejected) {
    test(`sanitizePaths rejects ${JSON.stringify(p)}`, () => {
      assert.deepStrictEqual(sanitizePaths([p]), []);
    });
  }

  const kept = ['.github', '.github/workflows', 'src/.hidden', 'a.b', 'src'];
  for (const p of kept) {
    test(`sanitizePaths keeps ${JSON.stringify(p)}`, () => {
      assert.deepStrictEqual(sanitizePaths([p]), [p]);
    });
  }

  test('a `.` root file can never become `--paths .`', () => {
    const r = run({ addedFiles: ['.'], documents: docs('# nothing') });
    assert.deepStrictEqual(r.affectedPaths, []);
    assert.doesNotMatch(r.message, /--paths\s+\./);
  });
});

describe('verify codebase-drift CLI — display safety and document reads (#5134 review)', () => {
  let tmp;
  let codebaseDir;
  const win = process.platform === 'win32';

  beforeEach(() => {
    tmp = createTempGitProject('gsd-drift-5134r-');
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
    return { data: JSON.parse(r.output), raw: r.output };
  }

  // Grows `file` to exactly `size` bytes.
  function padTo(file, size) {
    const current = fs.statSync(file).size;
    assert.ok(current <= size, 'precondition: file not already larger than the target');
    fs.appendFileSync(file, Buffer.alloc(size - current, 0x78));
    assert.strictEqual(fs.statSync(file).size, size);
  }

  const LIMIT = 1048576;

  // A stamped map with one edited mapped file past the stamp; `arrange`
  // reshapes the documents in the working tree before the check runs.
  function mappedRepo(arrange) {
    write('src/f0.js', 'one\n');
    commitAll('seed');
    mapCodebase('# Codebase Structure\n\n- `src/`\n');
    write('src/f0.js', 'two\n');
    commitAll('edit');
    arrange();
    configure({ drift_threshold: 1 });
  }

  test('STRUCTURE.md at exactly 1048576 bytes is read', () => {
    mappedRepo(() => padTo(path.join(codebaseDir, 'STRUCTURE.md'), LIMIT));
    const { data } = drift();
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.elements, [{ category: 'modified', path: 'src/f0.js' }]);
  });

  test('STRUCTURE.md at 1048577 bytes is skipped, naming the size limit', () => {
    mappedRepo(() => padTo(path.join(codebaseDir, 'STRUCTURE.md'), LIMIT + 1));
    const { data } = drift();
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'cannot-read-structure-md: larger than 1048576 bytes');
    assert.strictEqual(data.action_required, false);
    assert.strictEqual(data.block, false);
    assert.deepStrictEqual(data.elements, []);
  });

  test('STRUCTURE.md that is a directory is skipped as not a regular file', () => {
    mappedRepo(() => {
      fs.unlinkSync(path.join(codebaseDir, 'STRUCTURE.md'));
      fs.mkdirSync(path.join(codebaseDir, 'STRUCTURE.md'));
    });
    const { data } = drift();
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'cannot-read-structure-md: not a regular file');
  });

  test('a missing STRUCTURE.md keeps its own skip reason', () => {
    mappedRepo(() => fs.unlinkSync(path.join(codebaseDir, 'STRUCTURE.md')));
    const { data } = drift();
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'no-structure-md');
  });

  test('another document at exactly 1048576 bytes is read', () => {
    mappedRepo(() => padTo(path.join(codebaseDir, 'STACK.md'), LIMIT));
    const { data } = drift();
    assert.ok(data.documents_read.includes('STACK.md'));
    assert.deepStrictEqual(data.documents_unreadable, []);
  });

  test('another document at 1048577 bytes is named unreadable and the result is still computed', () => {
    mappedRepo(() => padTo(path.join(codebaseDir, 'STACK.md'), LIMIT + 1));
    const { data } = drift();
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.documents_unreadable, ['STACK.md']);
    assert.ok(!data.documents_read.includes('STACK.md'));
    assert.deepStrictEqual(data.elements, [{ category: 'modified', path: 'src/f0.js' }]);
  });

  test('another document that is a directory is named unreadable; an absent one is silently omitted', () => {
    mappedRepo(() => {
      fs.unlinkSync(path.join(codebaseDir, 'STACK.md'));
      fs.mkdirSync(path.join(codebaseDir, 'STACK.md'));
      fs.unlinkSync(path.join(codebaseDir, 'CONCERNS.md'));
    });
    const { data } = drift();
    assert.deepStrictEqual(data.documents_unreadable, ['STACK.md']);
    assert.ok(!data.documents_read.includes('CONCERNS.md'));
  });

  test('a document that is a symlink to a regular file is followed and read', { skip: win }, () => {
    mappedRepo(() => {
      fs.writeFileSync(path.join(tmp, 'real-conventions.md'), '# Conventions\n\n`tools/`\n');
      fs.unlinkSync(path.join(codebaseDir, 'CONVENTIONS.md'));
      fs.symlinkSync(path.join(tmp, 'real-conventions.md'), path.join(codebaseDir, 'CONVENTIONS.md'));
    });
    const { data } = drift();
    assert.ok(data.documents_read.includes('CONVENTIONS.md'));
    assert.deepStrictEqual(data.documents_unreadable, []);
  });

  test('a document that is a symlink to a directory is named unreadable', { skip: win }, () => {
    mappedRepo(() => {
      fs.unlinkSync(path.join(codebaseDir, 'CONVENTIONS.md'));
      fs.symlinkSync(tmp, path.join(codebaseDir, 'CONVENTIONS.md'));
    });
    const { data } = drift();
    assert.deepStrictEqual(data.documents_unreadable, ['CONVENTIONS.md']);
  });

  test('control and bidi characters in a path are escaped in elements and withheld_paths, never raw in the output', { skip: win }, () => {
    write('src/f0.js', 'one\n');
    commitAll('seed');
    mapCodebase('# Codebase Structure\n\n- `src/`\n');
    configure({ drift_threshold: 1 });
    write('ev\u001b[2Jil\u202efdp.js', 'x\n');
    commitAll('add a hostile top-level file');

    const { data, raw } = drift();
    const shown = 'ev\\u001b[2Jil\\u202efdp.js';
    assert.deepStrictEqual(data.elements, [{ category: 'new_dir', path: shown }]);
    assert.deepStrictEqual(data.withheld_paths, [shown]);
    assert.strictEqual(data.withheld_count, 1);
    assert.deepStrictEqual(data.affected_paths, []);
    assert.ok(!raw.includes('\u001b'), 'no raw ESC in the CLI output');
    assert.ok(!raw.includes('\u202e'), 'no raw bidi override in the CLI output');
  });

  test('a path over 200 code units is cut with an ellipsis in elements', { skip: win }, () => {
    write('src/f0.js', 'one\n');
    commitAll('seed');
    mapCodebase('# Codebase Structure\n\n- `src/`\n');
    configure({ drift_threshold: 1 });
    write('n'.repeat(210) + '.js', 'x\n');
    commitAll('add a long name');
    const { data } = drift();
    assert.deepStrictEqual(data.elements, [{ category: 'new_dir', path: 'n'.repeat(199) + '…' }]);
  });

  for (const total of [49, 50, 51]) {
    test(`withheld_paths is capped at 50 with the true total in withheld_count (${total} withheld)`, () => {
      write('src/f0.js', 'one\n');
      commitAll('seed');
      mapCodebase('# Codebase Structure\n\n- `src/`\n');
      configure({ drift_threshold: 1 });
      const names = Array.from({ length: total }, (_, i) => `w ${String(i).padStart(2, '0')}.js`);
      for (const n of names) write(n, 'x\n');
      commitAll('add withheld files');

      const { data } = drift();
      assert.strictEqual(data.withheld_count, total);
      assert.deepStrictEqual(data.withheld_paths, names.slice(0, Math.min(total, 50)));
      assert.strictEqual(data.elements.length, total, 'elements are not capped');
    });
  }

  test('withheld_count is 0 and withheld_paths empty when nothing is withheld', () => {
    write('src/f0.js', 'one\n');
    commitAll('seed');
    mapCodebase('# Codebase Structure\n\n- `src/`\n');
    write('src/f0.js', 'two\n');
    commitAll('edit');
    configure({ drift_threshold: 1 });
    const { data } = drift();
    assert.strictEqual(data.withheld_count, 0);
    assert.deepStrictEqual(data.withheld_paths, []);
  });

  test('a mapped file that becomes a symlink (typechange) is a modified element', { skip: win }, () => {
    for (let i = 0; i < 3; i++) write(`src/f${i}.js`, 'one\n');
    commitAll('seed');
    mapCodebase('# Codebase Structure\n\n- `src/`\n');
    const base = git(tmp, 'rev-parse', 'HEAD');
    for (let i = 0; i < 3; i++) {
      fs.unlinkSync(path.join(tmp, `src/f${i}.js`));
      fs.symlinkSync('elsewhere.js', path.join(tmp, `src/f${i}.js`));
    }
    commitAll('turn the files into symlinks');
    const status = git(tmp, 'diff', '--name-status', base, 'HEAD');
    assert.match(status, /^T\tsrc\/f0\.js$/m, `precondition: git reported typechange lines, got ${JSON.stringify(status)}`);

    const { data } = drift();
    assert.strictEqual(data.action_required, true);
    assert.deepStrictEqual(data.elements, [
      { category: 'modified', path: 'src/f0.js' },
      { category: 'modified', path: 'src/f1.js' },
      { category: 'modified', path: 'src/f2.js' },
    ]);
  });
});
