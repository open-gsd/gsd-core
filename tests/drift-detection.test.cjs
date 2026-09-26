// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests — Codebase Drift Detection (#2003)
 *
 * Unit tests for bin/lib/drift.cjs plus CLI surface via verify codebase-drift.
 * Exercises the six drift categories (new dir, barrel, migration, route,
 * modified, deleted — the last two since #4886),
 * threshold gating, warn vs. auto-remap, last_mapped_commit round-trip,
 * config validation, mapper --paths passthrough, and graceful failure paths.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createTempProject,
  createTempGitProject,
  cleanup,
  runGsdTools,
} = require('./helpers.cjs');
const { gitOrThrow, throwIfFailed } = require('./helpers/git-fixture.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const DRIFT_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'bin',
  'lib',
  'drift.cjs',
);
const CONFIG_SCHEMA_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'bin',
  'lib',
  'config-schema.cjs',
);

const {
  detectDrift,
  classifyFile,
  readMappedCommit,
  writeMappedCommit,
  chooseAffectedPaths,
  sanitizePaths,
  DRIFT_CATEGORIES,
} = require(DRIFT_PATH);

// Small wrapper so tests don't sprinkle shell=true calls. Routed through
// gitOrThrow (bounded, throw-on-failure) rather than bare `runGit` — this
// helper's 16 callers all rely on the throw-on-failure contract.
function git(cwd, ...args) {
  return gitOrThrow(args, { cwd }).trim();
}

// ─── Unit: classifyFile ──────────────────────────────────────────────────────

describe('classifyFile', () => {
  test('classifies packages barrel export', () => {
    assert.strictEqual(classifyFile('packages/foo/src/index.ts'), 'barrel');
  });

  test('classifies apps barrel export', () => {
    assert.strictEqual(classifyFile('apps/web/src/index.tsx'), 'barrel');
  });

  test('classifies supabase migration', () => {
    assert.strictEqual(
      classifyFile('supabase/migrations/20240101_init.sql'),
      'migration',
    );
  });

  test('classifies prisma migration folder', () => {
    assert.strictEqual(
      classifyFile('prisma/migrations/20240101_init/migration.sql'),
      'migration',
    );
  });

  test('classifies drizzle meta migration', () => {
    assert.strictEqual(classifyFile('drizzle/meta/_journal.json'), 'migration');
  });

  test('classifies route module', () => {
    assert.strictEqual(
      classifyFile('apps/web/src/routes/journal.ts'),
      'route',
    );
    assert.strictEqual(
      classifyFile('src/api/users.ts'),
      'route',
    );
  });

  test('returns null for ordinary source file', () => {
    assert.strictEqual(classifyFile('src/lib/util.ts'), null);
  });
});

// ─── Unit: detectDrift categories ────────────────────────────────────────────

describe('detectDrift — categories', () => {
  const baseStructure = [
    '# Codebase Structure',
    '',
    '- `src/lib/` — helpers',
    '- `bin/` — CLIs',
    '',
  ].join('\n');

  test('identifies new directory outside mapped paths', () => {
    const result = detectDrift({
      addedFiles: ['newpkg/src/thing.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: baseStructure,
    });
    const newDirs = result.elements.filter((e) => e.category === 'new_dir');
    assert.ok(newDirs.length >= 1, 'should find at least one new directory');
    assert.ok(
      newDirs.some((e) => e.path.startsWith('newpkg')),
      'should flag newpkg as new',
    );
  });

  test('does not flag files in already-mapped paths', () => {
    const result = detectDrift({
      addedFiles: ['src/lib/newhelper.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: baseStructure,
    });
    const newDirs = result.elements.filter((e) => e.category === 'new_dir');
    assert.strictEqual(
      newDirs.length,
      0,
      'src/lib is mapped — no new_dir drift',
    );
  });

  test('identifies new barrel export', () => {
    const result = detectDrift({
      addedFiles: ['packages/widgets/src/index.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: baseStructure,
    });
    assert.ok(result.elements.some((e) => e.category === 'barrel'));
  });

  test('identifies new migration', () => {
    const result = detectDrift({
      addedFiles: ['supabase/migrations/20240501_add_accounts.sql'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: baseStructure,
    });
    assert.ok(result.elements.some((e) => e.category === 'migration'));
  });

  test('identifies new route module', () => {
    const result = detectDrift({
      addedFiles: ['apps/accounting/src/routes/journal.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: baseStructure,
    });
    assert.ok(result.elements.some((e) => e.category === 'route'));
  });

  test('prioritizes higher-specificity category per file', () => {
    const result = detectDrift({
      addedFiles: ['supabase/migrations/20240101_init.sql'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: baseStructure,
    });
    const perFile = result.elements.filter(
      (e) => e.path === 'supabase/migrations/20240101_init.sql',
    );
    assert.strictEqual(perFile.length, 1, 'file counted once');
    assert.strictEqual(perFile[0].category, 'migration');
  });
});

// ─── Unit: threshold gating ──────────────────────────────────────────────────

describe('detectDrift — threshold gating', () => {
  test('2 elements under default threshold → no action', () => {
    const result = detectDrift({
      addedFiles: [
        'packages/a/src/index.ts',
        'packages/b/src/index.ts',
      ],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: '# only src/ mapped',
      threshold: 3,
    });
    assert.strictEqual(result.elements.length >= 2, true);
    assert.strictEqual(result.actionRequired, false);
  });

  test('3 elements at threshold → action required', () => {
    const result = detectDrift({
      addedFiles: [
        'packages/a/src/index.ts',
        'packages/b/src/index.ts',
        'packages/c/src/index.ts',
      ],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: '# only src/ mapped',
      threshold: 3,
    });
    assert.strictEqual(result.actionRequired, true);
  });

  test('4 elements exceeds threshold → action required', () => {
    const result = detectDrift({
      addedFiles: [
        'packages/a/src/index.ts',
        'packages/b/src/index.ts',
        'packages/c/src/index.ts',
        'supabase/migrations/1.sql',
      ],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: '# only src/ mapped',
      threshold: 3,
    });
    assert.strictEqual(result.actionRequired, true);
  });

  test('respects custom threshold value', () => {
    const result = detectDrift({
      addedFiles: ['packages/a/src/index.ts', 'packages/b/src/index.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: '# only src/ mapped',
      threshold: 2,
    });
    assert.strictEqual(result.actionRequired, true);
  });
});

// ─── Unit: modified / deleted files in mapped territory (#4886) ──────────────
//
// Before #4886 the only element-producing loop in detectDrift iterated
// `addedFiles`; `modifiedFiles` and `deletedFiles` reached the `counts` object
// and nothing else. A map could go arbitrarily stale through edits — the common
// change class on a mature repo — and the gate reported `actionRequired: false`
// at every threshold. Every test below except the over-reach guard ("a change
// in territory the map never described is not drift") fails on the pre-fix
// module; that one passes both ways by design and pins the boundary.

describe('detectDrift — modified and deleted files in mapped territory (#4886)', () => {
  // The normal state of a mapped repo: STRUCTURE.md lists the directories the
  // changes land in. Verbatim from the issue's reproduction.
  const structureMd = [
    '# Structure',
    '',
    '- `src/app/` — application modules',
    '- `src/lib/` — shared helpers',
    '- `docs/` — documentation',
    '',
  ].join('\n');

  test('modified files inside a mapped directory register as drift', () => {
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: ['src/app/main.py', 'src/lib/util.py'],
      deletedFiles: [],
      structureMd,
      threshold: 1,
    });
    assert.strictEqual(result.skipped, false);
    assert.deepStrictEqual(result.elements, [
      { category: 'modified', path: 'src/app/main.py' },
      { category: 'modified', path: 'src/lib/util.py' },
    ]);
    assert.strictEqual(result.actionRequired, true);
    assert.strictEqual(result.directive, 'warn');
    assert.deepStrictEqual(result.affectedPaths, ['src'],
      'the remap hint must point the mapper at the subtree the edits landed in');
  });

  test('deleted files inside a mapped directory register as drift', () => {
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: [],
      deletedFiles: ['src/app/old.py'],
      structureMd,
      threshold: 1,
    });
    assert.deepStrictEqual(result.elements, [{ category: 'deleted', path: 'src/app/old.py' }]);
    assert.strictEqual(result.actionRequired, true);
    assert.deepStrictEqual(result.affectedPaths, ['src']);
  });

  test("the issue's scenario A: three edits and one deletion in mapped dirs at threshold 1", () => {
    // Reported: elements [] / actionRequired false. `.planning/codebase/…` is
    // not in the map's territory (the CLI caller filters planning artifacts
    // before the library ever sees them), so it must not count either way.
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: ['src/app/main.py', 'src/lib/util.py', '.planning/codebase/ARCHITECTURE.md'],
      deletedFiles: ['src/app/old.py'],
      structureMd,
      threshold: 1,
    });
    assert.deepStrictEqual(
      result.elements.map((e) => `${e.category}:${e.path}`).sort(),
      ['deleted:src/app/old.py', 'modified:src/app/main.py', 'modified:src/lib/util.py'],
    );
    assert.strictEqual(result.actionRequired, true);
    assert.deepStrictEqual(result.counts, { added: 0, modified: 3, deleted: 1 },
      'counts stay per-list and unfiltered — they report the diff, not the drift');
  });

  test("the issue's scenario D: 100 edits and 50 additions inside mapped dirs at the default threshold", () => {
    // Reported: elements [] / actionRequired false with counts {50, 100, 0}.
    // The 50 ordinary additions land in mapped directories, so they are still
    // not drift — the added-file rule is untouched. The 100 edits now are.
    const modifiedFiles = Array.from({ length: 100 }, (_, i) => `src/app/m${i}.py`);
    const addedFiles = Array.from({ length: 50 }, (_, i) => `src/lib/a${i}.py`);
    const result = detectDrift({ addedFiles, modifiedFiles, deletedFiles: [], structureMd, threshold: 3 });
    assert.strictEqual(result.elements.length, 100);
    assert.ok(result.elements.every((e) => e.category === 'modified'));
    assert.strictEqual(result.actionRequired, true);
    assert.deepStrictEqual(result.counts, { added: 50, modified: 100, deleted: 0 });
  });

  test('a change in territory the map never described is not drift', () => {
    // The map never covered these directories, so their edits are not a
    // divergence from the map. Symmetric with the added-file rule: an
    // addition is drift OUTSIDE mapped territory, an edit is drift INSIDE it.
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: ['scratch/notes.txt', 'tools/gen.py'],
      deletedFiles: ['tools/old.py'],
      structureMd,
      threshold: 1,
    });
    assert.deepStrictEqual(result.elements, []);
    assert.strictEqual(result.actionRequired, false);
    assert.deepStrictEqual(result.counts, { added: 0, modified: 2, deleted: 1 });
  });

  test('the threshold gates modified elements like any other', () => {
    const under = detectDrift({
      addedFiles: [],
      modifiedFiles: ['src/app/a.py', 'src/app/b.py'],
      deletedFiles: [],
      structureMd,
      threshold: 3,
    });
    assert.strictEqual(under.elements.length, 2);
    assert.strictEqual(under.actionRequired, false, '2 < 3: reported, not actioned');
    assert.strictEqual(under.directive, 'none');

    const at = detectDrift({
      addedFiles: [],
      modifiedFiles: ['src/app/a.py', 'src/app/b.py'],
      deletedFiles: ['src/lib/c.py'],
      structureMd,
      threshold: 3,
    });
    assert.strictEqual(at.actionRequired, true, '2 modified + 1 deleted = 3 ≥ 3');
  });

  test('added-file classification is unchanged when edits are present in the same diff', () => {
    const result = detectDrift({
      addedFiles: ['newpkg/thing.py', 'src/lib/added.py', 'prisma/migrations/0001_init/migration.sql'],
      modifiedFiles: ['src/app/main.py'],
      deletedFiles: [],
      structureMd,
      threshold: 1,
    });
    assert.deepStrictEqual(
      result.elements.map((e) => `${e.category}:${e.path}`).sort(),
      [
        'migration:prisma/migrations/0001_init/migration.sql',
        'modified:src/app/main.py',
        'new_dir:newpkg/thing.py',
      ],
      'src/lib/added.py is an ordinary addition in mapped territory and stays out, as before',
    );
  });

  test('the warn message lists modified and deleted files under their own headings and names the affected paths', () => {
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: ['src/app/main.py'],
      deletedFiles: ['src/lib/gone.py'],
      structureMd,
      threshold: 1,
      action: 'warn',
    });
    assert.match(result.message, /^Codebase drift detected: 2 structural element\(s\) since last mapping\./);
    assert.match(result.message, /Modified mapped files:\n {2}- src\/app\/main\.py/);
    assert.match(result.message, /Deleted mapped files:\n {2}- src\/lib\/gone\.py/);
    assert.match(result.message, /--paths src /);
  });

  test('auto-remap scopes the mapper to the subtrees the edits landed in', () => {
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: ['src/app/main.py', 'docs/guide.md'],
      deletedFiles: [],
      structureMd,
      threshold: 1,
      action: 'auto-remap',
    });
    assert.strictEqual(result.spawnMapper, true);
    assert.deepStrictEqual(result.affectedPaths, ['docs', 'src']);
    assert.deepStrictEqual(sanitizePaths(result.affectedPaths), ['docs', 'src']);
  });

  test('non-string entries in modifiedFiles / deletedFiles are ignored, never thrown on', () => {
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: [null, 42, 'src/app/main.py', undefined],
      deletedFiles: [{}, 'src/lib/gone.py'],
      structureMd,
      threshold: 1,
    });
    assert.strictEqual(result.skipped, false);
    assert.deepStrictEqual(
      result.elements.map((e) => `${e.category}:${e.path}`).sort(),
      ['deleted:src/lib/gone.py', 'modified:src/app/main.py'],
    );
    assert.deepStrictEqual(result.counts, { added: 0, modified: 1, deleted: 1 });
  });
});

// ─── Unit: action routing ────────────────────────────────────────────────────

describe('detectDrift — action routing', () => {
  const over = {
    addedFiles: [
      'packages/a/src/index.ts',
      'packages/b/src/index.ts',
      'packages/c/src/index.ts',
    ],
    modifiedFiles: [],
    deletedFiles: [],
    structureMd: '# only src/ mapped',
    threshold: 3,
  };

  test('warn action yields warn directive and no mapper spawn request', () => {
    const result = detectDrift({ ...over, action: 'warn' });
    assert.strictEqual(result.directive, 'warn');
    assert.strictEqual(result.spawnMapper, false);
    assert.ok(result.message.includes('drift'), 'message mentions drift');
  });

  test('auto-remap action yields spawn directive with affected paths', () => {
    const result = detectDrift({ ...over, action: 'auto-remap' });
    assert.strictEqual(result.directive, 'auto-remap');
    assert.strictEqual(result.spawnMapper, true);
    assert.ok(Array.isArray(result.affectedPaths));
    assert.ok(result.affectedPaths.length > 0);
    for (const p of result.affectedPaths) {
      assert.ok(!p.startsWith('/'), 'no absolute paths');
      assert.ok(!p.includes('..'), 'no traversal');
    }
  });

  test('below-threshold inputs produce no directive', () => {
    const result = detectDrift({
      addedFiles: ['packages/a/src/index.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: '# only src/ mapped',
      threshold: 3,
      action: 'auto-remap',
    });
    assert.strictEqual(result.actionRequired, false);
    assert.strictEqual(result.spawnMapper, false);
    assert.strictEqual(result.directive, 'none');
  });
});

// ─── Unit: affected-paths scoping ────────────────────────────────────────────

describe('chooseAffectedPaths', () => {
  test('collapses files into top-level prefixes', () => {
    const paths = chooseAffectedPaths([
      'apps/accounting/src/routes/a.ts',
      'apps/accounting/src/routes/b.ts',
      'packages/ui/src/index.ts',
    ]);
    assert.ok(paths.includes('apps/accounting'));
    assert.ok(paths.includes('packages/ui'));
  });

  test('deduplicates and sorts', () => {
    const paths = chooseAffectedPaths([
      'zzz/a.ts',
      'aaa/b.ts',
      'zzz/c.ts',
    ]);
    assert.deepStrictEqual(paths, ['aaa', 'zzz']);
  });

  test('returns [] for empty input', () => {
    assert.deepStrictEqual(chooseAffectedPaths([]), []);
  });
});

// ─── Unit: sanitizePaths ─────────────────────────────────────────────────────

describe('sanitizePaths', () => {
  test('rejects traversal', () => {
    assert.deepStrictEqual(sanitizePaths(['../evil']), []);
    assert.deepStrictEqual(sanitizePaths(['foo/../evil']), []);
  });

  test('rejects absolute paths', () => {
    assert.deepStrictEqual(sanitizePaths(['/etc/passwd']), []);
  });

  test('rejects shell metacharacters', () => {
    assert.deepStrictEqual(sanitizePaths(['foo;rm -rf /']), []);
    assert.deepStrictEqual(sanitizePaths(['foo`id`']), []);
    assert.deepStrictEqual(sanitizePaths(['foo$(id)']), []);
  });

  test('accepts normal repo-relative paths', () => {
    assert.deepStrictEqual(
      sanitizePaths(['apps/web', 'packages/ui']),
      ['apps/web', 'packages/ui'],
    );
  });

  // `.` is shell-safe and carries no traversal, so the allowlist regex admits it — but it
  // names the whole repository, and a mapper scoped to `.` is the unscoped remap the
  // filter exists to prevent. It is reachable: chooseAffectedPaths takes the first
  // component, so any `./x` input derives the prefix `.`.
  test('rejects the repo-root scope, however it is spelled', () => {
    // Tested component-wise, not against the literal: `./.` and `././.` are the same
    // request and an exact compare against '.' admits both.
    assert.deepStrictEqual(sanitizePaths(['.']), []);
    assert.deepStrictEqual(sanitizePaths(['./.']), []);
    assert.deepStrictEqual(sanitizePaths(['././.']), []);
  });

  test('still accepts paths that merely CONTAIN dots', () => {
    assert.deepStrictEqual(
      sanitizePaths(['.github', 'a.b', 'src/app.config.js', './src']),
      ['.github', 'a.b', 'src/app.config.js', './src'],
    );
  });
});

// ─── Regression #4922 review: affectedPaths is sanitized at the producer ─────
//
// `sanitizePaths` shipped with zero production callers, so `affectedPaths`
// reached BOTH of its consumers unfiltered: `cmdVerifyCodebaseDrift`'s
// `affected_paths` field and the `--paths <list>` command `buildMessage`
// splices into the warn text. #4886 widened the reachable input set — a mapped
// directory whose name carries a shell metacharacter previously reached that
// list only via an ADDED file, and now reaches it via an edit or deletion
// inside it too. Both tests below fail on the pre-fix module.

describe('detectDrift — affectedPaths is sanitized before it reaches a command', () => {
  // The unsafe top-level directory is named in STRUCTURE.md, so a file edited
  // or deleted inside it is "mapped territory" and takes the #4886 loop.
  const structureMd = [
    '# Structure',
    '',
    '- `we;rm -rf /` — a directory whose name is a shell metacharacter',
    '- `src/` — ordinary modules',
    '',
  ].join('\n');

  test('an unsafe prefix reached via a MODIFIED file is dropped from affectedPaths and from the warn command', () => {
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: ['we;rm -rf /main.py', 'src/app/main.py'],
      deletedFiles: [],
      structureMd,
      threshold: 1,
      action: 'warn',
    });
    assert.strictEqual(result.skipped, false);
    assert.deepStrictEqual(result.affectedPaths, ['src'],
      'the unsafe prefix must not reach affected_paths');
    // Scope the assertion to the SPLICE SITE. The message also lists the drifted
    // elements under their category headings; that is a report of what changed,
    // not a command, and it must keep naming the path verbatim.
    const pathsLine = result.message.split('\n').find((l) => l.includes('--paths'));
    assert.ok(pathsLine, 'the warn message carries a --paths remediation command');
    assert.ok(!pathsLine.includes('rm -rf'),
      'the unsafe prefix must not be spliced into the --paths argument');
    assert.match(pathsLine, /--paths src /);
    assert.ok(
      result.elements.some((e) => e.category === 'modified' && e.path.startsWith('we;')),
      'the element list still names the drifted path verbatim',
    );
  });

  // Under auto-remap an unsafe prefix no longer reaches a SHORTER remap: any withheld
  // prefix degrades the directive (#4923), so what must hold is that it reaches neither
  // the mapper's path list nor the command the degraded warn prints.
  test('an unsafe prefix reached via a DELETED file reaches no mapper path list', () => {
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: [],
      deletedFiles: ['we;rm -rf /gone.py', 'src/lib/gone.py'],
      structureMd,
      threshold: 1,
      action: 'auto-remap',
    });
    assert.deepStrictEqual(result.affectedPaths, ['src']);
    assert.deepStrictEqual(result.droppedPaths, ['we;rm -rf ']);
    assert.strictEqual(result.directive, 'warn');
    assert.strictEqual(result.spawnMapper, false);
    assert.ok(!result.message.includes('Auto-remap scheduled'));
    const pathsLine = result.message.split('\n').find((l) => l.includes('--paths'));
    assert.ok(!pathsLine.includes('rm -rf'),
      'the unsafe prefix must not reach the --paths argument');
    assert.match(pathsLine, /--paths src /);
  });

  // Filtering made an EMPTY affectedPaths reachable for the first time: before it was
  // wired in, chooseAffectedPaths returned at least one prefix per element and nothing
  // removed any. The execute-phase gate branches on `directive` and splices
  // `affected_paths` into the mapper's `--paths`, so an undegraded auto-remap here
  // would spawn an UNSCOPED mapper.
  const allUnsafeMd = ['# Structure', '', '- `we;rm -rf /` — a hostile directory name', ''].join('\n');

  test('auto-remap degrades to warn when every affected prefix is filtered', () => {
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: ['we;rm -rf /a.py', 'we;rm -rf /b.py'],
      deletedFiles: [],
      structureMd: allUnsafeMd,
      threshold: 1,
      action: 'auto-remap',
    });
    assert.strictEqual(result.actionRequired, true, 'the drift is still reported');
    assert.deepStrictEqual(result.affectedPaths, []);
    assert.strictEqual(result.directive, 'warn',
      'the gate branches on directive — leaving it auto-remap spawns an unscoped mapper');
    assert.strictEqual(result.spawnMapper, false);
    assert.strictEqual(result.action, 'auto-remap',
      'the REQUESTED action is still reported; only the resolved directive degrades');
    assert.ok(!result.message.includes('--paths'),
      'no mapper command is emitted when no path can be passed safely');
    assert.ok(!result.message.includes('Auto-remap scheduled'));
    assert.deepStrictEqual(result.droppedPaths, ['we;rm -rf '],
      'the withheld prefix is reported on the result, not subtracted silently (#4923)');
    assert.ok(
      result.message.split('\n').includes(
        'Withheld from the mapper as unsafe to pass: "we;rm -rf ". Refresh planning context for it by hand.',
      ),
      'the explanation must name the cause that actually applies, and the prefix it applies to',
    );
    assert.ok(!result.message.includes('could be derived'),
      'the no-derivable-prefix explanation must not be used for the filtered route');
    assert.ok(
      result.message.split('\n').includes(
        'Auto-remap was not run: no affected path can be passed to the mapper.',
      ),
      'a degraded auto-remap says so, rather than reading as auto-remap being broken',
    );
    assert.strictEqual(result.elements.length, 2, 'the drifted paths are still enumerated');
  });

  test('warn with every affected prefix filtered emits no empty --paths command', () => {
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: ['we;rm -rf /a.py'],
      deletedFiles: ['we;rm -rf /b.py'],
      structureMd: allUnsafeMd,
      threshold: 1,
      action: 'warn',
    });
    assert.strictEqual(result.directive, 'warn');
    assert.deepStrictEqual(result.affectedPaths, []);
    assert.ok(!result.message.includes('--paths'));
    assert.match(result.message, /Refresh planning context for it by hand/);
  });

  // The SAME degraded state is reachable without any filtering at all: an empty-string
  // entry is skipped by chooseAffectedPaths, so it yields an element with no prefix.
  // That route predates the filter — `cmdVerifyCodebaseDrift` cannot produce it, because
  // it drops blank `git diff --name-status` lines, but `detectDrift` is exported and the
  // pre-filter module answered it with directive 'auto-remap' and spawnMapper true.
  test('an element with no usable prefix degrades too — the pre-existing empty-path route', () => {
    const result = detectDrift({
      addedFiles: [''],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: '',
      threshold: 1,
      action: 'auto-remap',
    });
    assert.strictEqual(result.actionRequired, true);
    assert.deepStrictEqual(result.affectedPaths, []);
    assert.strictEqual(result.directive, 'warn');
    assert.strictEqual(result.spawnMapper, false);
    assert.ok(!result.message.includes('Auto-remap scheduled'));
    // The two empty-list causes get DIFFERENT explanations. Nothing was filtered here —
    // chooseAffectedPaths discarded the empty path before the allowlist saw it — so
    // telling the operator a prefix was "withheld as unsafe" would send them hunting
    // for a hostile directory name that does not exist.
    assert.match(result.message, /No affected path could be derived for the mapper/);
    assert.deepStrictEqual(result.droppedPaths, []);
    assert.ok(!result.message.includes('Withheld from the mapper'));
  });

  test('a repo-root prefix degrades rather than remapping the whole tree', () => {
    const result = detectDrift({
      addedFiles: ['./evil.js'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: 'x',
      threshold: 1,
      action: 'auto-remap',
    });
    assert.strictEqual(result.actionRequired, true);
    assert.deepStrictEqual(result.affectedPaths, [],
      'chooseAffectedPaths derives "." from a ./ path; it must not survive filtering');
    assert.strictEqual(result.directive, 'warn');
    assert.strictEqual(result.spawnMapper, false);
  });

  // The boundary: the degrade keys on a WITHHELD prefix, never on drift as such. When
  // every derived prefix survives, auto-remap is scheduled exactly as before.
  test('nothing withheld keeps auto-remap intact — the degrade is not a blanket', () => {
    const structureMd = [
      '# Structure', '', '- `docs/` — documentation', '- `src/` — ordinary modules', '',
    ].join('\n');
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: ['docs/guide.md', 'src/app/main.py'],
      deletedFiles: [],
      structureMd,
      threshold: 1,
      action: 'auto-remap',
    });
    assert.strictEqual(result.directive, 'auto-remap');
    assert.strictEqual(result.spawnMapper, true);
    assert.deepStrictEqual(result.affectedPaths, ['docs', 'src']);
    assert.deepStrictEqual(result.droppedPaths, []);
    assert.ok(result.message.split('\n').includes('Auto-remap scheduled for paths: docs, src'));
    assert.ok(!result.message.includes('Auto-remap was not run'));
  });
});

// ─── Regression #4923: a withheld prefix is named, never silently subtracted ─
//
// Filtering at the producer closed the splice, but when SOME prefixes survived and
// some were dropped, nothing said which were dropped: no field carried them, and the
// remediation line simply got shorter. The element list above it prints the drifted
// files, not which directories the command leaves out, so a partial `--paths` read as
// the whole of it.

describe('detectDrift — a withheld prefix is named in the result and the message (#4923)', () => {
  const structureMd = '# S\n- `src/`\n';
  const withheldLine = (msg) => msg.split('\n').find((l) => l.startsWith('Withheld from the mapper'));

  test('warn with one prefix withheld and one surviving names the withheld one', () => {
    const result = detectDrift({
      addedFiles: ['bad name/x.ts', 'lib2/a.ts', 'lib2/b.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd,
      threshold: 1,
      action: 'warn',
    });
    assert.deepStrictEqual(result.affectedPaths, ['lib2']);
    assert.deepStrictEqual(result.droppedPaths, ['bad name']);
    const runLine = result.message.split('\n').find((l) => l.includes('--paths'));
    assert.match(runLine, /--paths lib2 /);
    assert.ok(!runLine.includes('bad name'), 'the withheld prefix never reaches the command');
    assert.strictEqual(
      withheldLine(result.message),
      'Withheld from the mapper as unsafe to pass: "bad name". Refresh planning context for it by hand.',
    );
  });

  test('every withheld prefix is quoted, so a control character cannot break the line', () => {
    const result = detectDrift({
      addedFiles: ['a\nb/x.ts', 'c;d/y.ts', 'lib2/a.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd,
      threshold: 1,
      action: 'warn',
    });
    assert.deepStrictEqual(result.droppedPaths, ['a\nb', 'c;d']);
    assert.strictEqual(
      withheldLine(result.message),
      'Withheld from the mapper as unsafe to pass: "a\\nb", "c;d". Refresh planning context for them by hand.',
    );
  });

  // JSON.stringify alone leaves U+2028/U+2029 literal, along with the other control,
  // format and separator code points: C1 controls (NEL), zero-width and soft-hyphen break
  // opportunities, bidi marks and overrides, the BOM, non-ASCII spaces, and astral format
  // characters. Each Cc/Cf/Z* code point other than the ASCII space must render as an
  // escape, and every token must read back. Combining marks are out of scope by design.
  test('control, format and non-ASCII separator code points are escaped, and each token reads back', () => {
    const result = detectDrift({
      addedFiles: [
        'a\u2028b/x.ts', 'c\u2029d/x.ts', 'e\u0085f/x.ts', 'g\u202eh/x.ts',
        'i\u200bj/x.ts', 'k\u00adl/x.ts', 'm\u061cn/x.ts', 'o\ufeffp/x.ts', 'q\u2060r/x.ts',
        's\u3000t/x.ts', 'u\u00a0v/x.ts', 'w\u{e0001}x/x.ts', 'y z/x.ts',
        'lib2/a.ts',
      ],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd,
      threshold: 1,
      action: 'warn',
    });
    assert.strictEqual(result.droppedPaths.length, 13);
    const line = withheldLine(result.message);
    assert.ok(!/(?! )[\p{Cc}\p{Cf}\p{Z}]/u.test(line), 'no raw Cc, Cf or non-ASCII Z* code point survives');
    // Every quoted token is valid JSON and parses back to exactly the withheld prefix,
    // astral code points included (a `\u{...}` escape would not parse).
    const tokens = line.match(/"(?:[^"\\]|\\.)*"/g).map((tok) => JSON.parse(tok));
    assert.deepStrictEqual(tokens, result.droppedPaths);
    assert.ok(line.includes('"y z"'), 'an ASCII space stays a plain space');
    for (const esc of [
      '"a\\u2028b"', '"c\\u2029d"', '"e\\u0085f"', '"g\\u202eh"',
      '"i\\u200bj"', '"k\\u00adl"', '"m\\u061cn"', '"o\\ufeffp"', '"q\\u2060r"',
      '"s\\u3000t"', '"u\\u00a0v"', '"w\\udb40\\udc01x"',
    ]) {
      assert.ok(line.includes(esc), `the line carries ${esc}`);
    }
  });

  // The element list used to print every drifted path raw. A modified file under a mapped
  // directory whose name carries a newline reached it only through the #4886 categories,
  // and printed raw it injected a line of its own into the message the gate prints
  // verbatim. A path carrying any Cc, Cf or non-ASCII Z* code point is now quoted and
  // escaped; a path without one, a plain space included, still prints raw.
  test('an element path carrying a newline is escaped in the message; ordinary paths are not', () => {
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: ['src/evil\nInjected line/b.py', 'src/bad name/c.py', 'src/app/main.py'],
      deletedFiles: [],
      structureMd,
      threshold: 1,
      action: 'warn',
    });
    const lines = result.message.split('\n');
    assert.ok(!lines.some((l) => l.startsWith('Injected line')), 'no path injects a line of its own');
    assert.ok(lines.includes('  - "src/evil\\nInjected line/b.py"'), 'the unsafe path is quoted and escaped');
    assert.ok(lines.includes('  - src/bad name/c.py'), 'a space alone does not trigger quoting');
    assert.ok(lines.includes('  - src/app/main.py'), 'an ordinary path prints unchanged');
    assert.ok(result.elements.some((e) => e.path === 'src/evil\nInjected line/b.py'),
      'the elements data keeps the raw path; only the printed message escapes it');
  });

  test('nothing withheld: droppedPaths is empty and no withheld line is emitted', () => {
    const result = detectDrift({
      addedFiles: ['lib2/a.ts', 'lib3/b.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd,
      threshold: 1,
      action: 'warn',
    });
    assert.deepStrictEqual(result.droppedPaths, []);
    assert.strictEqual(withheldLine(result.message), undefined);
  });

  // The half that is not cosmetic. On a successful remap the execute-phase gate stamps
  // STRUCTURE.md and ARCHITECTURE.md at HEAD, and the next check diffs from that stamp.
  // Remapping only `lib2` would therefore record `bad name/` as mapped without remapping
  // it, and its drift would never be reported again. The gate never prints `message` on
  // this branch, so naming the drop there would not reach anyone either.
  test('auto-remap with one prefix withheld degrades to warn rather than remapping the rest', () => {
    const result = detectDrift({
      addedFiles: ['bad name/x.ts', 'lib2/a.ts', 'lib2/b.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd,
      threshold: 1,
      action: 'auto-remap',
    });
    assert.strictEqual(result.actionRequired, true);
    assert.strictEqual(result.directive, 'warn',
      'a partial auto-remap would be stamped as covering the withheld directory');
    assert.strictEqual(result.spawnMapper, false);
    assert.strictEqual(result.action, 'auto-remap', 'the requested action is still reported');
    assert.deepStrictEqual(result.affectedPaths, ['lib2']);
    assert.deepStrictEqual(result.droppedPaths, ['bad name']);
    assert.ok(!result.message.includes('Auto-remap scheduled'));
    assert.strictEqual(
      withheldLine(result.message),
      'Withheld from the mapper as unsafe to pass: "bad name". Refresh planning context for it by hand.',
    );
    assert.ok(result.message.split('\n').includes(
      'Auto-remap was not run: remapping only the other paths would record the map as '
        + 'current past the withheld ones.',
    ));
  });

  test('a skipped result carries an empty droppedPaths', () => {
    assert.deepStrictEqual(detectDrift({ structureMd: null }).droppedPaths, []);
  });
});

// ─── Unit: last_mapped_commit frontmatter round-trip ─────────────────────────

describe('last_mapped_commit frontmatter', () => {
  let tmp;
  beforeEach(() => {
    tmp = createTempProject('gsd-drift-');
    fs.mkdirSync(path.join(tmp, '.planning', 'codebase'), { recursive: true });
  });
  afterEach(() => cleanup(tmp));

  test('writeMappedCommit creates frontmatter on fresh file', () => {
    const file = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(file, '# Codebase Structure\n\nBody\n');
    writeMappedCommit(file, 'deadbeef00000000000000000000000000000000', '2026-04-22');
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.startsWith('---\n'));
    assert.ok(content.includes('last_mapped_commit: deadbeef00000000000000000000000000000000'));
    assert.ok(content.includes('# Codebase Structure'));
  });

  test('writeMappedCommit updates existing frontmatter', () => {
    const file = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(
      file,
      '---\nlast_mapped_commit: aaaa\nother: keep-me\n---\n# body\n',
    );
    writeMappedCommit(file, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-04-22');
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('last_mapped_commit: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
    assert.ok(content.includes('other: keep-me'), 'preserves other keys');
    assert.ok(content.includes('# body'));
  });

  test('readMappedCommit round-trips via write', () => {
    const file = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(file, '# body\n');
    writeMappedCommit(file, 'cafebabe00000000000000000000000000000000', '2026-04-22');
    assert.strictEqual(
      readMappedCommit(file),
      'cafebabe00000000000000000000000000000000',
    );
  });

  test('readMappedCommit returns null when file missing', () => {
    assert.strictEqual(readMappedCommit('/nonexistent/path.md'), null);
  });

  test('readMappedCommit returns null when frontmatter absent', () => {
    const file = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(file, '# No frontmatter\n');
    assert.strictEqual(readMappedCommit(file), null);
  });

  test('writeMappedCommit creates the file when it does not exist (symmetry with readMappedCommit)', () => {
    const file = path.join(tmp, '.planning', 'codebase', 'NEW-DOC.md');
    assert.strictEqual(fs.existsSync(file), false, 'precondition: file absent');
    // Must not throw — readMappedCommit returns null for missing files,
    // writeMappedCommit must defensively create them.
    writeMappedCommit(file, 'feedface00000000000000000000000000000000', '2026-04-22');
    assert.strictEqual(fs.existsSync(file), true, 'file created');
    assert.strictEqual(
      readMappedCommit(file),
      'feedface00000000000000000000000000000000',
    );
  });
});

// ─── Unit: negative / defensive ──────────────────────────────────────────────

describe('detectDrift — defensive paths', () => {
  test('missing structureMd → skipped result, no throw', () => {
    const result = detectDrift({
      addedFiles: ['foo/bar.ts'],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: null,
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.actionRequired, false);
    assert.ok(result.reason);
  });

  test('empty inputs → no drift', () => {
    const result = detectDrift({
      addedFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: '# structure',
    });
    assert.strictEqual(result.elements.length, 0);
    assert.strictEqual(result.actionRequired, false);
  });

  test('categories constant is exposed and stable', () => {
    assert.ok(Array.isArray(DRIFT_CATEGORIES));
    assert.deepStrictEqual(
      [...DRIFT_CATEGORIES].sort(),
      ['barrel', 'deleted', 'migration', 'modified', 'new_dir', 'route'],
    );
  });
});

// ─── Unit: non-blocking guarantee ────────────────────────────────────────────

describe('detectDrift — non-blocking guarantee', () => {
  test('never throws on malformed input', () => {
    assert.doesNotThrow(() => detectDrift({}));
    assert.doesNotThrow(() => detectDrift({ addedFiles: null }));
    assert.doesNotThrow(() => detectDrift({ addedFiles: ['x'], structureMd: undefined }));
  });

  test('malformed input returns a skipped result (never crashes the phase)', () => {
    const r = detectDrift({});
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.actionRequired, false);
  });
});

// ─── Config validation: drift keys owned by the drift capability ──────────────
//
// After ADR-857 phase-6 migration, workflow.drift_threshold and workflow.drift_action
// are no longer in the central config schema manifest (VALID_CONFIG_KEYS). They are
// federated config keys owned exclusively by the `drift` capability in the registry.
// VALID_CONFIG_KEYS covers central-only keys; capability-owned keys resolve through
// the federated config overlay (loadConfig still returns them at their defaults).

const CAPABILITY_REGISTRY_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'bin',
  'lib',
  'capability-registry.cjs',
);

describe('config-schema — drift keys', () => {
  test('workflow.drift_threshold owned by drift capability (not central)', () => {
    const { isCentralConfigKey } = require(CONFIG_SCHEMA_PATH);
    const registry = require(CAPABILITY_REGISTRY_PATH);
    // Must be owned by the drift capability
    assert.strictEqual(registry.configKeys['workflow.drift_threshold'], 'drift',
      'workflow.drift_threshold must be owned by the drift capability');
    // Must NOT be in central schema (migration complete)
    assert.strictEqual(isCentralConfigKey('workflow.drift_threshold'), false,
      'workflow.drift_threshold must not be a central config key after capability migration');
  });

  test('workflow.drift_action owned by drift capability (not central)', () => {
    const { isCentralConfigKey } = require(CONFIG_SCHEMA_PATH);
    const registry = require(CAPABILITY_REGISTRY_PATH);
    // Must be owned by the drift capability
    assert.strictEqual(registry.configKeys['workflow.drift_action'], 'drift',
      'workflow.drift_action must be owned by the drift capability');
    // Must NOT be in central schema (migration complete)
    assert.strictEqual(isCentralConfigKey('workflow.drift_action'), false,
      'workflow.drift_action must not be a central config key after capability migration');
  });
});

describe('config-set drift validation via CLI', () => {
  let tmp;
  beforeEach(() => {
    tmp = createTempGitProject('gsd-drift-cfg-');
  });
  afterEach(() => cleanup(tmp));

  test('accepts warn', () => {
    const r = runGsdTools(['config-set', 'workflow.drift_action', 'warn'], tmp);
    assert.strictEqual(r.success, true, r.error);
  });

  test('accepts auto-remap', () => {
    const r = runGsdTools(['config-set', 'workflow.drift_action', 'auto-remap'], tmp);
    assert.strictEqual(r.success, true, r.error);
  });

  test('rejects bogus drift_action value', () => {
    const r = runGsdTools(['config-set', 'workflow.drift_action', 'sometimes'], tmp);
    assert.strictEqual(r.success, false);
  });

  test('drift_threshold accepts integer', () => {
    const r = runGsdTools(['config-set', 'workflow.drift_threshold', '5'], tmp);
    assert.strictEqual(r.success, true, r.error);
  });

  test('drift_threshold rejects non-numeric', () => {
    const r = runGsdTools(['config-set', 'workflow.drift_threshold', 'many'], tmp);
    assert.strictEqual(r.success, false);
  });
});

// ─── Docs parity for CONFIGURATION.md ────────────────────────────────────────

describe('docs parity', () => {
  test('workflow.drift_threshold mentioned in docs/CONFIGURATION.md', () => {
    const md = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'CONFIGURATION.md'),
      'utf8',
    );
    assert.ok(md.includes('`workflow.drift_threshold`'));
  });

  test('workflow.drift_action mentioned in docs/CONFIGURATION.md', () => {
    const md = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'CONFIGURATION.md'),
      'utf8',
    );
    assert.ok(md.includes('`workflow.drift_action`'));
  });
});

// ─── Mapper --paths flag documented ──────────────────────────────────────────

describe('gsd-codebase-mapper --paths flag', () => {
  test('agent doc mentions --paths', () => {
    const doc = fs.readFileSync(
      path.join(__dirname, '..', 'agents', 'gsd-codebase-mapper.md'),
      'utf8',
    );
    assert.ok(/--paths/.test(doc));
  });

  test('AGENTS.md mentions --paths for mapper', () => {
    const doc = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'AGENTS.md'),
      'utf8',
    );
    assert.ok(/--paths/.test(doc));
  });

  test('map-codebase workflow documents --paths passthrough', () => {
    const doc = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'gsd-core',
        'workflows',
        'map-codebase.md',
      ),
      'utf8',
    );
    assert.ok(/--paths/.test(doc));
  });
});

// ─── Execute-phase workflow integration ──────────────────────────────────────
//
// After ADR-857 phase-6 migration, codebase_drift_gate is no longer an inline
// step in execute-phase.md. Instead, it is declared as a gate in the `drift`
// capability at the `execute:wave:post` hook point. The execute-phase.md
// dispatches capability gates via `gsd_run loop render-hooks execute:wave:post`,
// which fires the drift gates automatically.

describe('execute-phase integrates codebase_drift_gate', () => {
  test('workflow references a codebase drift step', () => {
    // After capability migration: the drift gate fires via execute:wave:post
    // render-hooks dispatch. Verify two things:
    // 1. execute-phase.md has the execute:wave:post render-hooks call site.
    // 2. The drift capability declares a codebase-drift gate at execute:wave:post.
    const doc = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'gsd-core',
        'workflows',
        'execute-phase.md',
      ),
      'utf8',
    );
    // execute-phase.md must dispatch execute:wave:post hooks (the call site that fires drift gates)
    assert.ok(
      /loop render-hooks execute:wave:post/.test(doc),
      'execute-phase.md must dispatch execute:wave:post hooks (drift capability gate call site)',
    );
    // The drift capability must declare a codebase-drift gate at execute:wave:post
    const registry = require(CAPABILITY_REGISTRY_PATH);
    const driftCap = registry.capabilities['drift'];
    assert.ok(driftCap, 'drift capability must be registered');
    const codebaseDriftGate = (driftCap.gates || []).find(
      (g) => g.check && /codebase.drift/i.test(g.check.query),
    );
    assert.ok(
      codebaseDriftGate,
      'drift capability must declare a codebase-drift gate at execute:wave:post',
    );
    assert.strictEqual(codebaseDriftGate.point, 'execute:wave:post');
    assert.strictEqual(codebaseDriftGate.blocking, false,
      'codebase-drift gate must be non-blocking by contract');
  });

  test('workflow documents non-blocking guarantee for drift', () => {
    const doc = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'gsd-core',
        'workflows',
        'execute-phase.md',
      ),
      'utf8',
    );
    assert.ok(/non[- ]blocking/i.test(doc) || /continue on (error|failure)/i.test(doc));
  });
});

// ─── CLI: verify codebase-drift subcommand ───────────────────────────────────

describe('verify codebase-drift CLI', () => {
  let tmp;
  beforeEach(() => {
    tmp = createTempGitProject('gsd-drift-cli-');
    fs.mkdirSync(path.join(tmp, '.planning', 'codebase'), { recursive: true });
  });
  afterEach(() => cleanup(tmp));

  test('returns skipped JSON when STRUCTURE.md missing', () => {
    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.action_required, false);
  });

  test('returns no-drift result when STRUCTURE.md is fresh', () => {
    const structure = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(structure, '# Codebase Structure\n\n- `src/`\n');
    const head = git(tmp, 'rev-parse', 'HEAD');
    writeMappedCommit(structure, head, '2026-04-22');
    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action_required, false);
  });

  test('detects drift when new files added after last_mapped_commit', () => {
    const structure = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(structure, '# Codebase Structure\n\n- `src/`\n');
    const head = git(tmp, 'rev-parse', 'HEAD');
    writeMappedCommit(structure, head, '2026-04-22');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'map codebase');
    for (const pkg of ['alpha', 'beta', 'gamma']) {
      const dir = path.join(tmp, 'packages', pkg, 'src');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.ts'), 'export {};\n');
    }
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'add packages');
    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action_required, true);
    assert.strictEqual(data.directive, 'warn');
    assert.ok(data.elements.length >= 3);
  });

  // ─── Regression #4081 — core.quotepath C-quoted non-ASCII paths ──────────
  //
  // With git's default core.quotepath=true, `diff --name-status` C-quotes any
  // path containing non-ASCII bytes: `docs/设计说明/overview.md` arrives as the
  // literal `"docs/\350\256\276…/overview.md"`. The gate's line parser used to
  // capture that quoted string verbatim, so (1) `isPathMapped` compared the
  // quoted prefix `"docs` against STRUCTURE.md and misclassified DOCUMENTED
  // directories as new_dir, and (2) the garbled string flowed into
  // elements[].path / affected_paths. Paths must be decoded before use.

  test('non-ASCII path under documented dir is not new_dir and paths decode (#4081)', () => {
    const structure = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(structure, '# Codebase Structure\n\n- `docs/`\n');
    writeMappedCommit(structure, git(tmp, 'rev-parse', 'HEAD'), '2026-09-04');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'map codebase');

    // Non-ASCII directory + file name under the documented `docs/` prefix.
    const dir = path.join(tmp, 'docs', '设计说明');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'overview.md'), '# overview\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'add non-ascii doc');

    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    // The file lives under a DOCUMENTED directory — it is mapped, not drift:
    // no element may exist for it, under any path spelling.
    const garbled = data.elements.filter((el) => String(el.path).includes('docs'));
    assert.strictEqual(
      garbled.length, 0,
      `docs/ file must classify as mapped (no element); got ${JSON.stringify(data.elements)}`,
    );
    // And nothing anywhere in the output may carry git's C-quoting artifacts
    // (a literal leading quote or backslash-octal escapes).
    const serialized = JSON.stringify([data.affected_paths, data.elements]);
    assert.ok(!/\\\\3[0-9]{2}/.test(serialized) && !serialized.includes('\\"docs'),
      `garbled C-quoted path leaked into output: ${serialized}`);
  });

  test('elements and affected_paths contain decoded repo-relative paths (#4081)', () => {
    // Threshold 1 so a single drift element flips action_required — the
    // assertion below depends on the gate triggering, not staying latent
    // below the default threshold of 3.
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ workflow: { drift_threshold: 1 } }, null, 2),
    );
    const structure = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(structure, '# Codebase Structure\n\n- `src/`\n');
    writeMappedCommit(structure, git(tmp, 'rev-parse', 'HEAD'), '2026-09-04');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'map codebase');

    // Undocumented non-ASCII top-level dir: legitimately drift, but the
    // reported path must be the real repo-relative UTF-8 path — git's
    // C-quoted form must be decoded, never passed through.
    const dir = path.join(tmp, '设计资料');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '文件.md'), '# doc\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'add non-ascii dir');

    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action_required, true, 'undocumented dir must stay drift');
    const paths = [
      ...data.elements.map((el) => el.path),
      ...(data.affected_paths || []),
    ];
    assert.ok(paths.length > 0, 'expected at least one drift element');
    for (const p of paths) {
      assert.ok(!p.startsWith('"'),
        `path must be decoded, not C-quoted: ${JSON.stringify(p)}`);
      assert.ok(!/\\[0-9]{3}/.test(p),
        `path must not contain octal escapes: ${JSON.stringify(p)}`);
    }
    assert.ok(paths.includes('设计资料/文件.md'),
      `expected the real UTF-8 path in output; got ${JSON.stringify(paths)}`);
  });

  test('rename (R100) with non-ASCII target parses and decodes both fields (#4081)', () => {
    const structure = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(structure, '# Codebase Structure\n\n- `docs/`\n');
    const seed = path.join(tmp, 'docs', 'old.md');
    fs.mkdirSync(path.dirname(seed), { recursive: true });
    fs.writeFileSync(seed, '# seed\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'seed ascii file');
    writeMappedCommit(structure, git(tmp, 'rev-parse', 'HEAD'), '2026-09-04');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'map codebase');

    // Rename into a non-ASCII name — diff emits R100\t"docs/\350…" (quoted
    // second field). The new path must decode and classify as mapped, and no
    // quoted path may leak into the output.
    const renamed = path.join(tmp, 'docs', '新名称.md');
    fs.renameSync(seed, renamed);
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'rename to non-ascii');

    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    const leaked = JSON.stringify(data.elements.map((el) => el.path));
    assert.ok(!/\\[0-9]{3}/.test(leaked),
      `quoted path leaked from rename entry: ${leaked}`);
  });

  test('never exits non-zero when git repo is missing (non-blocking)', () => {
    const nonGit = createTempProject('gsd-drift-nongit-');
    try {
      const r = runGsdTools(['verify', 'codebase-drift'], nonGit);
      assert.strictEqual(r.success, true, 'must exit 0 even without git');
      const data = JSON.parse(r.output);
      assert.strictEqual(data.skipped, true);
    } finally {
      cleanup(nonGit);
    }
  });
});

// ─── Regression #1493 — workflow.drift_action / drift_threshold read from nested config shape ───
//
// loadConfig() returns a flattened object; config?.workflow was always undefined,
// making drift_action permanently 'warn' and drift_threshold always 3 regardless
// of .planning/config.json contents. Fix reads the raw nested JSON directly.

describe('verify codebase-drift — workflow config read from nested shape (#1493)', () => {
  let tmp;
  beforeEach(() => {
    tmp = createTempGitProject('gsd-drift-1493-');
    fs.mkdirSync(path.join(tmp, '.planning', 'codebase'), { recursive: true });
  });
  afterEach(() => cleanup(tmp));

  test('workflow.drift_action=auto-remap in config.json is honored (not always warn) (#1493)', () => {
    // Write config with nested workflow shape — the flat loadConfig() path would
    // have silently dropped this, leaving action === 'warn'.
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ workflow: { drift_action: 'auto-remap', drift_threshold: 1 } }, null, 2),
    );

    // Map codebase to current HEAD so anything committed next is "new" drift.
    const structure = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(structure, '# Codebase Structure\n\n- `src/`\n');
    writeMappedCommit(structure, git(tmp, 'rev-parse', 'HEAD'), '2026-04-22');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'map codebase');

    // Add one structural barrel file — enough to exceed drift_threshold of 1.
    const dir = path.join(tmp, 'packages', 'ui', 'src');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export {};\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'add package barrel');

    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(
      data.action, 'auto-remap',
      'workflow.drift_action=auto-remap must flow through from nested config; "warn" means the flat-shape bug is still active',
    );
  });

  test('workflow.drift_threshold in config.json gates triggering (#1493)', () => {
    // Threshold of 100 — 1 structural file should not trigger action_required.
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ workflow: { drift_action: 'auto-remap', drift_threshold: 100 } }, null, 2),
    );

    const structure = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(structure, '# Codebase Structure\n\n- `src/`\n');
    writeMappedCommit(structure, git(tmp, 'rev-parse', 'HEAD'), '2026-04-22');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'map codebase');

    const dir = path.join(tmp, 'packages', 'ui', 'src');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export {};\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'add one package barrel');

    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.threshold, 100,
      'workflow.drift_threshold=100 must be read from nested config; 3 means the flat-shape bug is still active');
    assert.strictEqual(data.action_required, false,
      '1 structural file must not exceed threshold of 100');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-619-codebase-drift-gate-shim.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-619-codebase-drift-gate-shim (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #619)
// codebase-drift-gate.md is the shipped orchestration step contract. Bug #619:
// the initial drift check ran the bare PATH binary `gsd-tools verify codebase-drift`.
// On a shim-only install (gsd-tools.cjs present, `gsd-tools` not on PATH) that exits
// 127, `2>/dev/null` hides it, and the `|| echo` fallback marks the gate skipped —
// so post-execution drift detection silently never runs. The fix resolves gsd-tools
// through the runtime shim launcher (gsd_run), defining the canonical preamble once in
// this always-run block so the file stays compliant with the single-preamble parity
// invariant (the conditional auto-remap block reuses the launcher via shared shell scope).
//
// This file locks the source contract AND behaviorally proves the shim resolves: it runs
// the exact shipped drift-check block against a shim-only topology and asserts the shim
// actually executes, where the old bare-binary form would have skipped.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup, readFileNormalized } = require('./helpers.cjs');

const GATE_MD = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'codebase-drift-gate.md',
);
const SNIPPET_FILE = path.join(__dirname, '..', 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh');

// readFileNormalized() strips \r\n -> \n before bashBlock() slices a fence
// out of the result and hands it to runHook('-c', ..., {interpreter:'bash'})
// below — an un-normalized read on a Windows checkout would break bash
// mid-script (DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE, #2650).
function readGate() {
  return readFileNormalized(GATE_MD);
}

// Extract the Nth (0-based) ```bash fenced block body from the file.
function bashBlock(content, n) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  for (const block of scanFencedBlocks(lines)) {
    if (block.closeLineIdx === -1) continue;
    if ((block.infoString || '').trim().toLowerCase() !== 'bash') continue;
    blocks.push(lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n'));
  }
  assert.ok(blocks.length > n, `expected at least ${n + 1} bash blocks, found ${blocks.length}`);
  return blocks[n];
}

describe('bug #619 — codebase-drift-gate resolves gsd-tools via the runtime shim, not the bare PATH binary', () => {
  test('codebase-drift-gate.md is readable', () => {
    assert.ok(readGate().length > 0, 'codebase-drift-gate.md must not be empty');
  });

  // ── Source contract (the .md is the product) ──────────────────────────────

  test('the drift check resolves gsd-tools via the shim launcher (gsd_run), not the bare binary (#619)', () => {
    const content = readGate();
    assert.match(
      content,
      /DRIFT=\$\(gsd_run verify codebase-drift 2>\/dev\/null \|\| echo '\{"skipped":true,"reason":"sdk-failed"\}'\)/,
      'drift check must call `gsd_run verify codebase-drift` with the non-blocking skip fallback',
    );
    assert.doesNotMatch(
      content,
      /\bgsd-tools verify codebase-drift\b/,
      'the bare `gsd-tools verify codebase-drift` PATH-binary call (the #619 bug) must be gone',
    );
  });

  test('non-blocking contract preserved: the skip JSON fallback is intact (#619)', () => {
    const content = readGate();
    assert.match(
      content,
      /\|\| echo '\{"skipped":true,"reason":"sdk-failed"\}'/,
      'an internal drift-command failure must still fall through to the skip JSON',
    );
  });

  test('exactly one canonical launcher preamble, in the drift-check block, before any launcher call (#619)', () => {
    const content = readGate();
    const snippet = readFileNormalized(SNIPPET_FILE).replace(/\n$/, '');

    // Count canonical preamble occurrences across the whole file (parity: exactly one).
    let count = 0;
    let pos = 0;
    for (;;) {
      const idx = content.indexOf(snippet, pos);
      if (idx === -1) break;
      count++;
      pos = idx + snippet.length;
    }
    assert.equal(count, 1, `expected exactly one canonical preamble; found ${count}`);

    // The preamble must live in the first (drift-check) bash block, before the DRIFT call.
    const block0 = bashBlock(content, 0);
    assert.ok(block0.includes(snippet), 'the canonical preamble must be in the drift-check block');
    assert.ok(
      block0.indexOf(snippet) < block0.indexOf('gsd_run verify codebase-drift'),
      'the preamble must precede the gsd_run drift call in the same block',
    );

    // The auto-remap block reuses gsd_run but must NOT carry its own preamble.
    const content2 = content.slice(content.indexOf('AGENT_SKILLS_MAPPER'));
    assert.ok(!content2.includes(snippet), 'the auto-remap block must not re-declare the preamble (single-preamble parity)');
  });

  // ── Behavioral proof: the shim resolves on a shim-only topology ───────────

  test('shipped drift-check block runs the shim (gsd-tools.cjs), not skip, on a shim-only install (#619)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-619-'));
    try {
      // Shim-only topology: gsd-tools.cjs present under RUNTIME_DIR; no `gsd-tools` on PATH.
      const binDir = path.join(tmp, 'gsd-core', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(binDir, 'gsd-tools.cjs'),
        'if (process.argv[2] === "verify" && process.argv[3] === "codebase-drift") {\n' +
        '  process.stdout.write(JSON.stringify({ action_required: false, sentinel: "SHIM_RAN" }));\n' +
        '}\n',
      );

      const block = bashBlock(readGate(), 0) + '\nprintf "%s" "$DRIFT"\n';
      const shimResult = runHook('-c', [block], {
        interpreter: 'bash',
        env: { ...process.env, RUNTIME_DIR: tmp },
      });
      throwIfFailed(shimResult, 'bash -c <shim-only drift-check block>');
      const out = shimResult.stdout;

      assert.match(out, /SHIM_RAN/, 'the drift check must execute the resolved shim, proving gsd_run resolution');
      assert.doesNotMatch(out, /sdk-failed/, 'the gate must NOT silently skip when the shim is present (#619)');
    } finally {
      cleanup(tmp);
    }
  });

  test('red-proof: the old bare `gsd-tools` form would skip when gsd-tools is not on PATH', () => {
    // Documents the #619 bug: the pre-fix bare-binary call, with no `gsd-tools` on PATH,
    // hits the 127 → `|| echo` skip path even though the shim (gsd-tools.cjs) exists.
    const oldForm =
      'DRIFT=$(gsd-tools verify codebase-drift 2>/dev/null || echo \'{"skipped":true,"reason":"sdk-failed"}\'); printf "%s" "$DRIFT"';
    const oldFormResult = runHook('-c', ['export PATH=/nonexistent-empty-path; ' + oldForm], {
      interpreter: 'bash',
      env: { ...process.env },
    });
    throwIfFailed(oldFormResult, 'bash -c <#619 bare-binary red-proof>');
    const out = oldFormResult.stdout;
    assert.match(out, /sdk-failed/, 'sanity: the bare-binary form skips without gsd-tools on PATH — the bug the fix removes');
  });
});
  });
}

// ─── Regression #3418: the drift baseline is written by code, not by prose ───
//
// `writeMappedCommit` shipped correct and callerless: nothing in the tree
// invoked it, so a full `/gsd:map-codebase` run wrote no `last_mapped_commit`.
// `cmdVerifyCodebaseDrift` then read null and fell back to diffing HEAD against
// the empty tree, so every tracked file read as newly added and the gate
// reported maximum drift identically on every run. Two halves, tested here:
// the `stamp-codebase-map` writer, and the reader's refusal to invent a
// baseline it does not have.

const CODEBASE_MAP_DOCS = [
  'STACK.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md',
  'TESTING.md', 'INTEGRATIONS.md', 'CONCERNS.md',
];

describe('stamp-codebase-map CLI (#3418)', () => {
  let tmp;
  let codebaseDir;

  function writeMap(docs = CODEBASE_MAP_DOCS) {
    for (const doc of docs) {
      fs.writeFileSync(path.join(codebaseDir, doc), `# ${doc}\n\nBody.\n`);
    }
  }

  beforeEach(() => {
    tmp = createTempGitProject('gsd-stamp-3418-');
    codebaseDir = path.join(tmp, '.planning', 'codebase');
    fs.mkdirSync(codebaseDir, { recursive: true });
  });
  afterEach(() => cleanup(tmp));

  test('stamps every codebase-map document with the HEAD sha (#3418)', () => {
    writeMap();
    const head = git(tmp, 'rev-parse', 'HEAD');

    const r = runGsdTools(['stamp-codebase-map'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);

    assert.strictEqual(data.skipped, false);
    assert.strictEqual(data.commit, head);
    assert.deepStrictEqual(data.failed, []);
    assert.strictEqual(data.stamped.length, CODEBASE_MAP_DOCS.length);

    for (const doc of CODEBASE_MAP_DOCS) {
      assert.strictEqual(
        readMappedCommit(path.join(codebaseDir, doc)), head,
        `${doc} must carry the HEAD sha; null means the writer is callerless again (#3418)`,
      );
    }
  });

  test('stamps only documents that exist, never conjures the missing ones (#3418)', () => {
    // The `--fast` map produces four of the seven. Creating the other three as
    // frontmatter-only stubs would make them satisfy the seven-file
    // completeness probe while carrying no analysis at all.
    const fastDocs = ['STACK.md', 'INTEGRATIONS.md', 'ARCHITECTURE.md', 'STRUCTURE.md'];
    writeMap(fastDocs);

    const r = runGsdTools(['stamp-codebase-map'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);

    assert.deepStrictEqual(data.stamped.sort(), [...fastDocs].sort());
    for (const doc of CODEBASE_MAP_DOCS.filter((d) => !fastDocs.includes(d))) {
      assert.strictEqual(
        fs.existsSync(path.join(codebaseDir, doc)), false,
        `${doc} was absent before the stamp and must stay absent after it`,
      );
    }
  });

  test('--files restricts the stamp to the named subset (#3418)', () => {
    // The execute-phase auto-remap path refreshes STRUCTURE.md and
    // ARCHITECTURE.md only. Stamping the other five at HEAD there would claim a
    // currency they do not have.
    writeMap();

    const r = runGsdTools(
      ['stamp-codebase-map', '--files', 'STRUCTURE.md,ARCHITECTURE.md'], tmp,
    );
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);

    assert.deepStrictEqual(data.stamped.sort(), ['ARCHITECTURE.md', 'STRUCTURE.md']);
    assert.strictEqual(readMappedCommit(path.join(codebaseDir, 'CONCERNS.md')), null,
      'a document outside --files must be left unstamped, not stamped at HEAD');
  });

  test('--files with an empty value stamps nothing rather than all seven (#4124 review)', () => {
    writeMap();

    const r = runGsdTools(['stamp-codebase-map', '--files', ''], tmp);
    assert.strictEqual(r.success, true, 'must stay non-blocking');
    const data = JSON.parse(r.output);

    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'empty-codebase-map-file-filter');
    assert.strictEqual(readMappedCommit(path.join(codebaseDir, 'STRUCTURE.md')), null,
      'a caller narrowing the scope must not have it silently widened to the whole map');
  });

  test('a bare --files stamps nothing rather than all seven (#4124 review)', () => {
    writeMap();

    const r = runGsdTools(['stamp-codebase-map', '--files'], tmp);
    assert.strictEqual(r.success, true, 'must stay non-blocking');
    const data = JSON.parse(r.output);

    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'empty-codebase-map-file-filter');
    assert.strictEqual(readMappedCommit(path.join(codebaseDir, 'STRUCTURE.md')), null,
      'an unquoted empty shell variable drops the token, and must not widen the scope');
  });

  test('--files with an unknown name stamps nothing and reports why (#3418)', () => {
    writeMap();

    const r = runGsdTools(['stamp-codebase-map', '--files', '../../etc/passwd'], tmp);
    assert.strictEqual(r.success, true, 'must stay non-blocking');
    const data = JSON.parse(r.output);

    assert.strictEqual(data.skipped, true);
    assert.match(data.reason, /^unknown-codebase-map-file:/);
    assert.deepStrictEqual(data.stamped, []);
    assert.strictEqual(readMappedCommit(path.join(codebaseDir, 'STRUCTURE.md')), null,
      'a rejected --files value must not partially stamp the map');
  });

  test('skips without a git repo instead of failing the run (#3418)', () => {
    const nonGit = createTempProject('gsd-stamp-nongit-');
    try {
      fs.mkdirSync(path.join(nonGit, '.planning', 'codebase'), { recursive: true });
      fs.writeFileSync(
        path.join(nonGit, '.planning', 'codebase', 'STRUCTURE.md'), '# STRUCTURE\n',
      );
      const r = runGsdTools(['stamp-codebase-map'], nonGit);
      assert.strictEqual(r.success, true, 'must exit 0 outside a git repo');
      const data = JSON.parse(r.output);
      assert.strictEqual(data.skipped, true);
      assert.strictEqual(data.reason, 'not-a-git-repo');
    } finally {
      cleanup(nonGit);
    }
  });

  test('skips when no codebase map exists (#3418)', () => {
    const r = runGsdTools(['stamp-codebase-map'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.reason, 'no-codebase-map');
  });

  test('a stamped map gives the drift gate a real base to diff against (#3418)', () => {
    // The end-to-end loop the issue reported broken: map, stamp, commit, then
    // ask the gate. Before the fix this reported every tracked file as drift.
    writeMap();
    const r1 = runGsdTools(['stamp-codebase-map'], tmp);
    assert.strictEqual(r1.success, true, r1.error);
    const stampedAt = JSON.parse(r1.output).commit;

    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'map codebase');

    const r2 = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r2.success, true, r2.error);
    const data = JSON.parse(r2.output);

    assert.strictEqual(data.skipped, false);
    assert.strictEqual(data.last_mapped_commit, stampedAt);
    assert.strictEqual(data.action_required, false);
    assert.deepStrictEqual(data.elements, [],
      'a freshly stamped map must report zero drift; a populated list means the empty-tree fallback is back (#3418)');
  });

  test('the map\'s own commit does not read as drift on the next run (#3418)', () => {
    // The stamp is written before `.planning/codebase/*.md` is committed, so
    // the commit carrying the baseline lands after it. Counting GSD's own
    // planning artifacts as codebase structure would re-poison the gate with
    // seven new directories -- over the default threshold of three -- on the
    // first invocation after a clean map.
    writeMap();
    runGsdTools(['stamp-codebase-map'], tmp);
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'map codebase');

    const data = JSON.parse(runGsdTools(['verify', 'codebase-drift'], tmp).output);
    assert.strictEqual(data.action_required, false,
      'the map documents are planning artifacts, not codebase structure');
    assert.deepStrictEqual(data.affected_paths, []);
  });

  test('the stamp takes the planning lock around its read-modify-write (#4124 review)', () => {
    // Seven frontmatter read-modify-writes with no lock lose an update when the
    // full map run and the execute-phase auto-remap stamp at the same time.
    // A dead holder's lock is stolen and released by withPlanningLock, so its
    // disappearance is the proof the stamp went through the lock at all.
    writeMap();
    const lockPath = path.join(tmp, '.planning', '.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999, cwd: tmp, acquired: new Date(0).toISOString(),
    }));

    const r = runGsdTools(['stamp-codebase-map'], tmp);
    assert.strictEqual(r.success, true, r.error);
    assert.strictEqual(JSON.parse(r.output).skipped, false);
    assert.strictEqual(fs.existsSync(lockPath), false,
      'the stale lock must be consumed and released; a surviving lock means the stamp never took it');
  });

  test('the planning-artifact filter holds when cwd is below the repo root (#4124 review)', () => {
    // `git diff --name-status` prints repo-root-relative paths whatever the
    // cwd, so a prefix computed against cwd would read `.planning/` while git
    // prints `sub/.planning/` and the filter would silently match nothing.
    const sub = path.join(tmp, 'packages', 'app');
    const subCodebase = path.join(sub, '.planning', 'codebase');
    fs.mkdirSync(subCodebase, { recursive: true });
    for (const doc of CODEBASE_MAP_DOCS) {
      fs.writeFileSync(path.join(subCodebase, doc), `# ${doc}\n\nBody.\n`);
    }

    const r1 = runGsdTools(['stamp-codebase-map'], sub);
    assert.strictEqual(r1.success, true, r1.error);
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'map codebase from a subdirectory');

    const data = JSON.parse(runGsdTools(['verify', 'codebase-drift'], sub).output);
    assert.strictEqual(data.skipped, false);
    assert.strictEqual(data.action_required, false,
      'the map documents under sub/.planning are still planning artifacts');
    assert.deepStrictEqual(data.elements, []);
  });
});

describe('verify codebase-drift: an absent baseline is not total drift (#3418)', () => {
  let tmp;
  let structure;

  beforeEach(() => {
    tmp = createTempGitProject('gsd-drift-3418-');
    fs.mkdirSync(path.join(tmp, '.planning', 'codebase'), { recursive: true });
    structure = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');

    // Structural files that the empty-tree fallback would have reported as
    // newly added. Without them the regression would pass for the wrong reason.
    for (const pkg of ['alpha', 'beta', 'gamma', 'delta']) {
      const dir = path.join(tmp, 'packages', pkg, 'src');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.ts'), 'export {};\n');
    }
    fs.writeFileSync(structure, '# Codebase Structure\n\n- `packages/`\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'map codebase without a stamp');
  });
  afterEach(() => cleanup(tmp));

  test('an unstamped STRUCTURE.md skips with no-mapped-commit (#3418)', () => {
    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);

    assert.strictEqual(data.reason, 'no-mapped-commit');
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.block, false,
      'block:true here is the reported bug: the whole repo diffed against the empty tree (#3418)');
    assert.strictEqual(data.action_required, false);
    assert.strictEqual(data.last_mapped_commit, null);
    assert.deepStrictEqual(data.elements, [],
      'no baseline means no comparison, so there is nothing to report as drift');
  });

  test('a stamp git cannot resolve skips with unresolvable-mapped-commit (#3418)', () => {
    // A history rewrite, a GC, or a shallow clone leaves a stamp pointing at a
    // commit this repository cannot see. That is a different operator problem
    // from never having been mapped, and it also used to fall through to the
    // empty tree.
    writeMappedCommit(structure, 'deadbeef'.repeat(5), '2026-04-22');

    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);

    assert.strictEqual(data.reason, 'unresolvable-mapped-commit');
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.block, false);
    assert.strictEqual(data.last_mapped_commit, 'deadbeef'.repeat(5));
    assert.deepStrictEqual(data.elements, []);
  });

  test('a stamp that resolves to a non-commit object skips too (#3418)', () => {
    // A tree sha resolves with exit 0, and `git diff <tree> HEAD` is valid, so
    // an exit-code-only probe would diff against the wrong object and report
    // that as real drift.
    const tree = git(tmp, 'rev-parse', 'HEAD^{tree}');
    writeMappedCommit(structure, tree, '2026-04-22');

    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);

    assert.strictEqual(data.reason, 'unresolvable-mapped-commit');
    assert.strictEqual(data.skipped, true);
    assert.strictEqual(data.block, false);
    assert.strictEqual(data.last_mapped_commit, tree);
    assert.deepStrictEqual(data.elements, []);
  });
});

describe('verify codebase-drift: a map that goes stale through edits is flagged (#4886)', () => {
  let tmp;
  let structure;

  beforeEach(() => {
    tmp = createTempGitProject('gsd-drift-4886-');
    fs.mkdirSync(path.join(tmp, '.planning', 'codebase'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src', 'app'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'app', 'main.py'), 'print(1)\n');
    fs.writeFileSync(path.join(tmp, 'src', 'app', 'old.py'), 'print(0)\n');
    fs.writeFileSync(path.join(tmp, 'src', 'lib', 'util.py'), 'x = 1\n');
    fs.writeFileSync(path.join(tmp, 'src', 'lib', 'more.py'), 'y = 2\n');
    structure = path.join(tmp, '.planning', 'codebase', 'STRUCTURE.md');
    fs.writeFileSync(structure, '# Codebase Structure\n\n- `src/app/` — application modules\n- `src/lib/` — shared helpers\n');
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ workflow: { drift_threshold: 3, drift_action: 'warn' } }),
    );
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'map codebase');
    writeMappedCommit(structure, git(tmp, 'rev-parse', 'HEAD'), '2026-09-20');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'stamp the map');
  });
  afterEach(() => cleanup(tmp));

  test('edits and a deletion inside mapped directories, no additions, reach the threshold', () => {
    // Nothing is added and no directory appears — the change class the
    // detector could not see before #4886.
    fs.writeFileSync(path.join(tmp, 'src', 'app', 'main.py'), 'print(2)\n');
    fs.writeFileSync(path.join(tmp, 'src', 'lib', 'util.py'), 'x = 2\n');
    fs.unlinkSync(path.join(tmp, 'src', 'app', 'old.py'));
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'edit two files, delete one');

    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);

    assert.strictEqual(data.skipped, false);
    assert.strictEqual(data.action_required, true,
      'action_required:false here is the reported bug — a stale map read as current (#4886)');
    assert.strictEqual(data.block, true);
    assert.strictEqual(data.directive, 'warn');
    assert.strictEqual(data.spawn_mapper, false);
    assert.deepStrictEqual(
      data.elements.map((e) => `${e.category}:${e.path}`).sort(),
      ['deleted:src/app/old.py', 'modified:src/app/main.py', 'modified:src/lib/util.py'],
    );
    assert.deepStrictEqual(data.affected_paths, ['src']);
    assert.match(data.message, /Modified mapped files:/);
    assert.match(data.message, /Deleted mapped files:/);
  });

  test('a single edit stays under the default threshold — reported as an element, not actioned', () => {
    fs.writeFileSync(path.join(tmp, 'src', 'lib', 'more.py'), 'y = 3\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'edit one file');

    const data = JSON.parse(runGsdTools(['verify', 'codebase-drift'], tmp).output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.elements, [{ category: 'modified', path: 'src/lib/more.py' }]);
    assert.strictEqual(data.action_required, false);
    assert.strictEqual(data.block, false);
  });

  // `git diff --name-status` reports a moved file as one R line, not D + A, so the
  // old path never reached deletedFiles and a `git mv` inside mapped directories
  // left the map describing files that no longer exist. Rename detection is pinned
  // on for both the precondition diff and the CLI's own diff: a contributor's
  // `diff.renames=false` would otherwise turn these R lines into D + A, and the
  // tests would stop exercising the arm they exist for. GIT_CONFIG_PARAMETERS is
  // cleared too: an outer `git -c diff.renames=false …` exports it, and it outranks
  // GIT_CONFIG_COUNT, so an inherited value would quietly undo the pin.
  const RENAMES_ON = {
    GIT_CONFIG_PARAMETERS: '',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'diff.renames',
    GIT_CONFIG_VALUE_0: 'true',
  };

  test('files renamed inside mapped directories register their old paths as deleted (R100)', () => {
    git(tmp, 'mv', 'src/app/old.py', 'src/app/older.py');
    git(tmp, 'mv', 'src/app/main.py', 'src/app/entry.py');
    git(tmp, 'mv', 'src/lib/util.py', 'src/lib/helpers.py');
    git(tmp, 'commit', '-m', 'rename three mapped files');
    // Precondition: git paired all three as pure renames, so this drives the R arm.
    assert.strictEqual(
      (git(tmp, '-c', 'diff.renames=true', 'diff', '--name-status', 'HEAD~1', 'HEAD').match(/^R100\t/gm) || []).length, 3);

    const r = runGsdTools(['verify', 'codebase-drift'], tmp, RENAMES_ON);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.deepStrictEqual(
      data.elements.map((e) => `${e.category}:${e.path}`).sort(),
      ['deleted:src/app/main.py', 'deleted:src/app/old.py', 'deleted:src/lib/util.py'],
    );
    assert.strictEqual(data.action_required, true,
      'three moved files left STRUCTURE.md naming paths that no longer exist');
    assert.deepStrictEqual(data.affected_paths, ['src']);
  });

  test('a file renamed and edited inside a mapped directory registers its old path as deleted (R<100)', () => {
    const body = Array.from({ length: 20 }, (_, i) => `line_${i} = ${i}\n`).join('');
    fs.writeFileSync(path.join(tmp, 'src', 'lib', 'big.py'), body);
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'add a larger mapped file');
    const stamp = runGsdTools(['stamp-codebase-map', '--files', 'STRUCTURE.md'], tmp);
    assert.strictEqual(stamp.success, true, stamp.error);
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'restamp the map');

    git(tmp, 'mv', 'src/lib/big.py', 'src/lib/large.py');
    fs.writeFileSync(path.join(tmp, 'src', 'lib', 'large.py'), body.replace('line_0 = 0', 'line_0 = 100'));
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'rename and edit');
    // Precondition: a rename with a similarity score below 100, not a pure R100.
    assert.match(git(tmp, '-c', 'diff.renames=true', 'diff', '--name-status', 'HEAD~1', 'HEAD'), /^R0\d\d\tsrc\/lib\/big\.py\tsrc\/lib\/large\.py$/m);

    const data = JSON.parse(runGsdTools(['verify', 'codebase-drift'], tmp, RENAMES_ON).output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.elements, [{ category: 'deleted', path: 'src/lib/big.py' }]);
  });

  // A T line is a type change at the same path — a mapped file replaced by a symlink
  // (or a submodule). The path survives, so it was neither added nor deleted, and
  // the loop dropped it. The symlink is recorded in the index only (mode 120000), so
  // the test needs no symlink privilege on Windows.
  test('a mapped file replaced by a symlink registers as modified (T)', () => {
    const target = path.join(tmp, 'link-target.txt');
    fs.writeFileSync(target, 'util.py');
    const blob = git(tmp, 'hash-object', '-w', target);
    fs.unlinkSync(target);
    git(tmp, 'update-index', '--cacheinfo', `120000,${blob},src/lib/more.py`);
    git(tmp, 'commit', '-m', 'replace a mapped file with a symlink');
    // Precondition: git reports a type change, the arm under test.
    assert.match(git(tmp, 'diff', '--name-status', 'HEAD~1', 'HEAD'), /^T\tsrc\/lib\/more\.py$/m);

    const data = JSON.parse(runGsdTools(['verify', 'codebase-drift'], tmp).output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.elements, [{ category: 'modified', path: 'src/lib/more.py' }]);
  });

  // #4923: cmdVerifyCodebaseDrift builds its payload by naming each field, so a result
  // field it does not name is never emitted. This drives the real CLI over a real tree.
  test('a withheld prefix is emitted as dropped_paths, beside the affected_paths it left', () => {
    fs.mkdirSync(path.join(tmp, 'bad name'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'lib2'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bad name', 'a.py'), 'a = 1\n');
    fs.writeFileSync(path.join(tmp, 'lib2', 'b.py'), 'b = 1\n');
    fs.writeFileSync(path.join(tmp, 'lib2', 'c.py'), 'c = 1\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'add two unmapped directories, one with an unsafe name');

    const r = runGsdTools(['verify', 'codebase-drift'], tmp);
    assert.strictEqual(r.success, true, r.error);
    const data = JSON.parse(r.output);
    assert.strictEqual(data.action_required, true);
    assert.deepStrictEqual(data.affected_paths, ['lib2']);
    assert.deepStrictEqual(data.dropped_paths, ['bad name']);
    assert.match(data.message, /Withheld from the mapper as unsafe to pass: "bad name"\./);
  });

  test('under drift_action auto-remap, a withheld prefix degrades the directive the gate branches on', () => {
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ workflow: { drift_threshold: 3, drift_action: 'auto-remap' } }),
    );
    fs.mkdirSync(path.join(tmp, 'bad name'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'lib2'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bad name', 'a.py'), 'a = 1\n');
    fs.writeFileSync(path.join(tmp, 'lib2', 'b.py'), 'b = 1\n');
    fs.writeFileSync(path.join(tmp, 'lib2', 'c.py'), 'c = 1\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'add two unmapped directories, one with an unsafe name');

    const data = JSON.parse(runGsdTools(['verify', 'codebase-drift'], tmp).output);
    assert.strictEqual(data.action, 'auto-remap');
    // Both keys the two execute-phase consumers spawn on must be off.
    assert.strictEqual(data.directive, 'warn');
    assert.strictEqual(data.spawn_mapper, false);
    assert.deepStrictEqual(data.affected_paths, ['lib2']);
    assert.deepStrictEqual(data.dropped_paths, ['bad name']);
  });

  test('re-stamping the map after a remap returns the gate to quiet', () => {
    fs.writeFileSync(path.join(tmp, 'src', 'app', 'main.py'), 'print(2)\n');
    fs.writeFileSync(path.join(tmp, 'src', 'lib', 'util.py'), 'x = 2\n');
    fs.unlinkSync(path.join(tmp, 'src', 'app', 'old.py'));
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'edit two files, delete one');
    assert.strictEqual(JSON.parse(runGsdTools(['verify', 'codebase-drift'], tmp).output).action_required, true);

    const r = runGsdTools(['stamp-codebase-map', '--files', 'STRUCTURE.md'], tmp);
    assert.strictEqual(r.success, true, r.error);
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'remap');

    const data = JSON.parse(runGsdTools(['verify', 'codebase-drift'], tmp).output);
    assert.strictEqual(data.skipped, false);
    assert.deepStrictEqual(data.elements, []);
    assert.strictEqual(data.action_required, false);
  });
});
