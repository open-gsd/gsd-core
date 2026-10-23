// docs-guard-exempt: docs/*.md strings below are path inputs to planWaveScopeConformance and docs/CLI-TOOLS.md is cited in a comment; this file reads no docs/ file.
'use strict';

/**
 * Cleanup-wave manifest normalization, declared-scope matching, SUMMARY rescue
 * and killed-merge residue restore — in-process verdict rows (#5232).
 *
 * Seam: gsd-core/bin/lib/worktree-safety.cjs
 * Interface: normalizeCleanupManifest, planWorktreeWaveCleanup,
 *   executeWorktreeWaveCleanupPlan (deps.execGit / findSummaryFiles / existsSync /
 *   readFileSync / mkdirSync / copyFileSync / statSync), planWaveScopeConformance
 *
 * WHY THIS FILE EXISTS
 * The module's helpers behind the wave gauntlet — `normalizeCleanupManifestEntry`,
 * `partitionDeclaredDeletions`, `declaredScopePrefix`, `normalizeScopePath`,
 * `rescueSummaryArtifacts`, `restoreMergeResidue`, `repoRootStillMidMerge` — are not
 * exported, and the existing rows mostly hand `executeWorktreeWaveCleanupPlan` a
 * pre-normalized plan, so the reader's liberal-input rules and several fail-closed
 * branches of the residue restore were never observed. Every row here drives an
 * exported entry point with an injected git double (or a temp-dir filesystem, where
 * the default fs reader is the thing under test) and asserts the exact verdict the
 * doc comments promise, usually beside a near-miss that must answer the other way.
 *
 * Warning codes are asserted as literal strings, not via WAVE_CLEANUP_WARNING:
 * docs/CLI-TOOLS.md documents them as the JSON wire format operators and
 * orchestrators match on, so a renamed code is a breaking change, not a refactor.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  normalizeCleanupManifest,
  planWorktreeWaveCleanup,
  executeWorktreeWaveCleanupPlan,
  planWaveScopeConformance,
} = require('../gsd-core/bin/lib/worktree-safety.cjs');

// ─── git double ──────────────────────────────────────────────────────────────

const REPO = '/repo/main';
const wtOf = (id) => `/repo/.claude/worktrees/agent-${id}`;
const brOf = (id) => `worktree-agent-${id}`;
const BASE = 'abc123';

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', signal: null, error: null, timedOut: false });
const fail = (exitCode, stderr = '') => ({ exitCode, stdout: '', stderr, signal: null, error: null, timedOut: false });
/** The seam's shape for a spawnSync timeout: status null is normalized to exitCode 1. */
const timedOut = () => ({
  exitCode: 1,
  stdout: '',
  stderr: '',
  signal: 'SIGTERM',
  error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  timedOut: true,
});

function entryFor(id, extra = {}) {
  return { agent_id: id, worktree_path: wtOf(id), branch: brOf(id), expected_base: BASE, ...extra };
}

function planFor(entries) {
  return { ok: true, repoRoot: REPO, action: 'cleanup_wave', discovery: 'manifest', reason: 'manifest_entries_present', entries };
}

/** Every gauntlet call answers as for a clean, mergeable executor branch. */
function happyPath(key) {
  const branchRead = /^-C \/repo\/\.claude\/worktrees\/agent-(\w+) rev-parse --abbrev-ref HEAD$/.exec(key);
  if (branchRead) return ok(brOf(branchRead[1]));
  if (key.startsWith('merge-base HEAD ')) return ok(BASE);
  // #2556: an uncommitted SUMMARY answers 128, not 1.
  if (key.includes(' cat-file -e ')) return fail(128, 'fatal: path does not exist in HEAD');
  if (key === 'rev-parse --verify -q MERGE_HEAD' || key === 'rev-parse --verify -q MERGE_AUTOSTASH') return fail(1);
  return ok('');
}

/**
 * Scripted execGit. `overrides` maps an exact argv key (or a `prefix*`) to a result,
 * or to an array of results consumed in call order (the last one repeats).
 */
function scriptedGit(overrides = {}) {
  const calls = [];
  const table = Object.entries(overrides).map(([pattern, v]) => [pattern, Array.isArray(v) ? [...v] : v]);
  const execGit = (args, opts = {}) => {
    const key = args.join(' ');
    calls.push({ args: [...args], key, cwd: opts.cwd });
    for (const [pattern, v] of table) {
      const hit = pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern;
      if (!hit) continue;
      if (Array.isArray(v)) return v.length > 1 ? v.shift() : v[0];
      return v;
    }
    return happyPath(key);
  };
  execGit.calls = calls;
  execGit.keys = () => calls.map((c) => c.key);
  return execGit;
}

function runWave(entries, overrides = {}, deps = {}) {
  const git = scriptedGit(overrides);
  const result = executeWorktreeWaveCleanupPlan(planFor(entries), {
    execGit: git,
    findSummaryFiles: () => [],
    ...deps,
  });
  return { result, git };
}

// ─── normalizeCleanupManifest / planWorktreeWaveCleanup ─────────────────────

describe('cleanup manifest reader: liberal in what it accepts, exact in what it keeps', () => {
  test('a JSON string is parsed, and every list field drops non-string / blank elements', () => {
    const raw = JSON.stringify({
      orchestrator_root: REPO,
      worktrees: [{
        agent_id: 'a1',
        worktree_path: wtOf('a1'),
        branch: brOf('a1'),
        expected_base: BASE,
        allowed_bases: ['b2', 7, ['b3'], '', BASE, 'b2'],
        files_modified: ['src/a.ts', '   ', 7, ''],
        declared_deletions: ['tests/a.ts', '  ', null, ''],
      }],
    });
    assert.deepEqual(normalizeCleanupManifest(raw), {
      ok: true,
      reason: 'ok',
      entries: [{
        agent_id: 'a1',
        worktree_path: wtOf('a1'),
        branch: brOf('a1'),
        expected_base: BASE,
        // expected_base always leads, duplicates collapse, junk is dropped.
        allowed_bases: [BASE, 'b2'],
        files_modified: ['src/a.ts'],
        declared_deletions: ['tests/a.ts'],
      }],
    });
  });

  test('absent/junk-only optional fields are OMITTED, so "declared nothing" reads as "not recorded"', () => {
    const { entries } = normalizeCleanupManifest([{
      agent_id: 42,
      worktree_path: wtOf('a1'),
      branch: brOf('a1'),
      expected_base: BASE,
      allowed_bases: 'b2',
      files_modified: ['   ', ''],
      declared_deletions: ['\t', 3],
    }]);
    // A key present with [] would make an unrecorded plan look 100% out of scope.
    assert.deepEqual(entries, [{
      agent_id: null,
      worktree_path: wtOf('a1'),
      branch: brOf('a1'),
      expected_base: BASE,
      allowed_bases: [BASE],
    }]);
  });

  test('legacy `path` is honored only as a string fallback for worktree_path', () => {
    const viaAlias = normalizeCleanupManifest([{ path: wtOf('a1'), branch: brOf('a1'), expected_base: BASE }]);
    assert.equal(viaAlias.entries[0].worktree_path, wtOf('a1'));
    const nonStringWorktreePath = normalizeCleanupManifest([{ worktree_path: 9, path: wtOf('a1'), branch: brOf('a1'), expected_base: BASE }]);
    assert.equal(nonStringWorktreePath.entries[0].worktree_path, wtOf('a1'));
    // A non-string alias is not a path: the entry has none and is dropped.
    assert.deepEqual(
      normalizeCleanupManifest([{ path: 5, branch: brOf('a1'), expected_base: BASE }]),
      { ok: false, reason: 'empty_manifest', entries: [] },
    );
  });

  test('an entry missing any one required field, or holding a non-string one, is dropped', () => {
    const good = { worktree_path: wtOf('a1'), branch: brOf('a1'), expected_base: BASE };
    const variants = [
      { ...good, worktree_path: '' },
      { ...good, branch: '' },
      { ...good, expected_base: '' },
      { ...good, expected_base: 42 },
      // String(['worktree-agent-a1']) would pass the branch-namespace regex.
      { ...good, branch: [brOf('a1')] },
      { ...good, branch: 'feature/x' },
    ];
    for (const v of variants) {
      assert.deepEqual(normalizeCleanupManifest([v]), { ok: false, reason: 'empty_manifest', entries: [] }, JSON.stringify(v));
    }
    assert.equal(normalizeCleanupManifest([good]).ok, true, 'the near-miss with every field present is kept');
  });

  test('null and primitive elements are skipped without throwing', () => {
    const good = { worktree_path: wtOf('a1'), branch: brOf('a1'), expected_base: BASE };
    const result = normalizeCleanupManifest([null, 'x', 7, good]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.entries.map((e) => e.worktree_path), [wtOf('a1')]);
  });

  test('(worktree_path, branch) is the dedup key: first wins, a different branch is a different entry', () => {
    const result = normalizeCleanupManifest([
      { worktree_path: wtOf('a1'), branch: brOf('a1'), expected_base: 'first' },
      { worktree_path: wtOf('a1'), branch: brOf('a1'), expected_base: 'second' },
      { worktree_path: wtOf('a1'), branch: brOf('a2'), expected_base: 'third' },
    ]);
    assert.deepEqual(result.entries.map((e) => [e.branch, e.expected_base]), [
      [brOf('a1'), 'first'],
      [brOf('a2'), 'third'],
    ]);
  });

  test('unparseable, null and entry-less manifests each get their own exact verdict', () => {
    assert.deepEqual(normalizeCleanupManifest('{not json'), { ok: false, reason: 'invalid_manifest_json', entries: [] });
    const empty = { ok: false, reason: 'empty_manifest', entries: [] };
    assert.deepEqual(normalizeCleanupManifest(null), empty);
    assert.deepEqual(normalizeCleanupManifest('null'), empty);
    assert.deepEqual(normalizeCleanupManifest({ worktrees: [] }), empty);
    assert.deepEqual(normalizeCleanupManifest({ worktrees: 'nope' }), empty);
  });

  test('planWorktreeWaveCleanup: skip on a bad manifest, cleanup_wave with the entries otherwise', () => {
    assert.deepEqual(planWorktreeWaveCleanup(REPO, '{not json'), {
      ok: false,
      repoRoot: REPO,
      action: 'skip',
      discovery: 'manifest',
      reason: 'invalid_manifest_json',
      entries: [],
    });
    const manifest = [{ agent_id: 'a1', worktree_path: wtOf('a1'), branch: brOf('a1'), expected_base: BASE }];
    assert.deepEqual(planWorktreeWaveCleanup(REPO, manifest), {
      ok: true,
      repoRoot: REPO,
      action: 'cleanup_wave',
      discovery: 'manifest',
      reason: 'manifest_entries_present',
      entries: normalizeCleanupManifest(manifest).entries,
    });
  });
});

// ─── planWaveScopeConformance (declaredScopePrefix + normalizeScopePath) ────

describe('scope advisory: literal-prefix matching after one shared normalizer', () => {
  const outOf = (branch, ...paths) => paths.map((p) => ({ code: 'scope_out_of_declared', branch, path: p }));

  test('a glob covers its literal directory prefix and nothing beside it', () => {
    assert.deepEqual(
      planWaveScopeConformance(['src/lib/a.ts', 'src/lib/deep/b.ts', 'src/libx/c.ts', 'docs/a.md'], ['src/lib/*.ts'], 'b1'),
      outOf('b1', 'src/libx/c.ts', 'docs/a.md'),
    );
  });

  test('only a GLOB-LEADING pattern means "matches everything"', () => {
    assert.deepEqual(planWaveScopeConformance(['docs/a.md', 'x/y.ts'], ['*.md'], 'b1'), []);
  });

  test('a doubled separator before the glob still yields the bare directory prefix', () => {
    assert.deepEqual(
      planWaveScopeConformance(['docs/a.md', 'docsx/a.md'], ['docs//*.md'], 'b1'),
      outOf('b1', 'docsx/a.md'),
    );
  });

  test('every trailing slash is stripped from a declared directory', () => {
    assert.deepEqual(planWaveScopeConformance(['src/a.ts', 'lib/b.ts'], ['src//'], 'b1'), outOf('b1', 'lib/b.ts'));
  });

  test('non-string or blank declarations are "nothing declared", not a scope', () => {
    assert.deepEqual(planWaveScopeConformance(['src/a.ts', '42'], [42, null, '', '  '], 'b1'), []);
    assert.deepEqual(planWaveScopeConformance(['src/a.ts'], 'src', 'b1'), []);
  });

  test('changed paths: non-strings and blanks ignored, spellings of one path reported once', () => {
    assert.deepEqual(planWaveScopeConformance(null, ['src'], 'b1'), []);
    assert.deepEqual(
      planWaveScopeConformance([42, '', '   ', 'docs/x.md', './docs/x.md', 'docs\\x.md', 'docs/x.md/'], ['src'], 'b1'),
      outOf('b1', 'docs/x.md'),
    );
  });
});

// ─── executeWorktreeWaveCleanupPlan: declared deletions (the GATE) ──────────

describe('declared deletions: exact membership after normalization, never wider', () => {
  const deletionsKey = `diff --diff-filter=D --name-only HEAD...${brOf('a1')}`;

  test('a declaration authorizes its path in any normalized spelling', () => {
    const { result } = runWave(
      [entryFor('a1', { declared_deletions: ['./tests/a.ts', 'tests\\b.ts', 'tests/c.ts//'] })],
      { [deletionsKey]: ok('tests/a.ts\ntests/b.ts\ntests/c.ts') },
    );
    assert.equal(result.entries[0].status, 'merged_removed');
  });

  test('a C-quoted path on a CRLF line still meets its decoded declaration', () => {
    const { result } = runWave(
      [entryFor('a1', { declared_deletions: ['tests/é.ts'] })],
      { [deletionsKey]: ok('"tests/\\303\\251.ts"\r\n') },
    );
    assert.equal(result.entries[0].status, 'merged_removed');
  });

  test('a "./" inside a path is part of the name, so it is not a spelling of another path', () => {
    const { result } = runWave(
      [entryFor('a1', { declared_deletions: ['pkga.ts'] })],
      { [deletionsKey]: ok('pkg./a.ts') },
    );
    assert.equal(result.entries[0].reason, 'branch_contains_deletions');
    assert.equal(result.entries[0].stderr, 'pkg./a.ts');
  });

  test('a non-string declaration authorizes nothing', () => {
    const { result } = runWave([entryFor('a1', { declared_deletions: [5] })], { [deletionsKey]: ok('5') });
    assert.equal(result.entries[0].reason, 'branch_contains_deletions');
    assert.equal(result.entries[0].stderr, '5');
  });
});

describe('advisory codes on the wave result', () => {
  test('an uncomputable scope diff is reported as unknown, and the merge still proceeds', () => {
    const { result } = runWave(
      [entryFor('a1', { files_modified: ['src/a.ts'] })],
      { [`diff --name-only HEAD...${brOf('a1')}`]: fail(128, 'fatal: bad revision') },
    );
    assert.equal(result.ok, true);
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.deepEqual(result.warnings, [{ code: 'scope_check_unavailable', branch: brOf('a1'), path: null }]);
  });

  test('a worktree git still binds to the branch but that is gone (ENOENT) merges with an advisory', () => {
    const resolved = path.resolve(REPO, wtOf('a1'));
    const porcelain = `worktree ${REPO}\nHEAD ${BASE}\nbranch refs/heads/main\n\n`
      + `worktree ${resolved}\nHEAD ${BASE}\nbranch refs/heads/${brOf('a1')}\nprunable gitdir file points to non-existent location\n`;
    const statSync = () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); };
    const { result } = runWave(
      [entryFor('a1')],
      {
        [`-C ${wtOf('a1')} rev-parse --abbrev-ref HEAD`]: fail(128, 'fatal: cannot change to directory'),
        'worktree list --porcelain': ok(porcelain),
      },
      { statSync },
    );
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.deepEqual(result.warnings, [{
      code: 'accepted_absent_worktree',
      branch: brOf('a1'),
      path: wtOf('a1'),
      detail: 'gitdir file points to non-existent location',
    }]);
  });
});

// ─── repoRootStillMidMerge (via a refused merge) ────────────────────────────

describe('after a failed merge, only a repoRoot still (or unverifiably) mid-merge halts the wave', () => {
  const refused = {
    [`merge ${brOf('a1')}*`]: fail(1, 'error: Your local changes would be overwritten by merge'),
    'merge --abort': fail(128, 'fatal: There is no merge to abort (MERGE_HEAD missing)?'),
  };

  test('a timed-out MERGE_HEAD probe fails closed even though the seam reports exit 1', () => {
    const { result, git } = runWave([entryFor('a1'), entryFor('a2')], {
      ...refused,
      'rev-parse --verify -q MERGE_HEAD': timedOut(),
    });
    assert.equal(result.entries[0].reason, 'merge_failed');
    assert.deepEqual(result.pending, [entryFor('a2')], 'the rest of the wave is held, not merged');
    const probe = git.calls.find((c) => c.key === 'rev-parse --verify -q MERGE_HEAD');
    assert.equal(probe.cwd, REPO, 'the probe must ask repoRoot, not whatever directory the process is in');
  });

  test('near-miss: an answered "no MERGE_HEAD" isolates the entry, and a refused merge never touches the index', () => {
    const { result, git } = runWave([entryFor('a1'), entryFor('a2')], refused);
    assert.deepEqual(result.pending, []);
    assert.deepEqual(result.entries.map((e) => [e.branch, e.status]), [
      [brOf('a1'), 'blocked'],
      [brOf('a2'), 'merged_removed'],
    ]);
    assert.equal(git.keys().includes('diff --cached --name-only'), false, 'staged work on a refusal is the operator\'s own');
  });
});

// ─── restoreMergeResidue (via a KILLED merge) ───────────────────────────────

describe('a killed merge: restore what it staged, re-apply its autostash, halt only if repoRoot stays dirty', () => {
  const killed = {
    [`merge ${brOf('a1')}*`]: timedOut(),
    'merge --abort': fail(128, 'fatal: There is no merge to abort (MERGE_HEAD missing)?'),
  };
  const BR = brOf('a1');
  const restored = (p) => ({ code: 'merge_residue_restored', branch: BR, path: p });
  const leftStaged = (p) => ({ code: 'merge_residue_left_staged', branch: BR, path: p });
  const autostashUnrestored = { code: 'merge_autostash_unrestored', branch: BR, path: null };

  function killWave(overrides) {
    return runWave([entryFor('a1'), entryFor('a2')], { ...killed, ...overrides });
  }
  const halted = (result) => result.pending.length === 1 && result.pending[0].branch === brOf('a2');
  const continued = (result) => result.pending.length === 0
    && result.entries.find((e) => e.branch === brOf('a2'))?.status === 'merged_removed';

  test('clean index, no autostash: nothing to restore, no reset issued, the wave continues', () => {
    const { result, git } = killWave({ 'diff --cached --name-only': ok('') });
    assert.equal(result.entries[0].reason, 'merge_timed_out');
    assert.deepEqual(result.entries[0].warnings, []);
    assert.ok(continued(result));
    assert.equal(git.keys().includes('reset --merge'), false);
  });

  test('staged residue that the reset clears is reported per path and the wave continues', () => {
    const { result, git } = killWave({
      'diff --cached --name-only': [ok('"tests/\\303\\251.ts"\r\nsrc/a.ts'), ok('')],
    });
    assert.deepEqual(result.entries[0].warnings, [restored('tests/é.ts'), restored('src/a.ts')]);
    assert.ok(continued(result));
    for (const c of git.calls.filter((call) => ['diff --cached --name-only', 'reset --merge', 'rev-parse --verify -q MERGE_AUTOSTASH'].includes(call.key))) {
      assert.equal(c.cwd, REPO, `${c.key} must run in repoRoot`);
    }
  });

  test('an index still dirty after the reset halts with the paths that stayed', () => {
    const { result } = killWave({ 'diff --cached --name-only': [ok('src/a.ts\nsrc/b.ts'), ok('src/b.ts')] });
    assert.deepEqual(result.entries[0].warnings, [leftStaged('src/b.ts')]);
    assert.ok(halted(result));
  });

  test('a reset whose result cannot be re-read halts with the set known to be staged', () => {
    const { result } = killWave({ 'diff --cached --name-only': [ok('src/a.ts'), fail(128, 'fatal: index locked')] });
    assert.deepEqual(result.entries[0].warnings, [leftStaged('src/a.ts')]);
    assert.ok(halted(result));
  });

  test('autostash on a clean index with a failed reset halts with a path-less marker', () => {
    const { result } = killWave({
      'diff --cached --name-only': ok(''),
      'rev-parse --verify -q MERGE_AUTOSTASH': ok('c0ffee'),
      'reset --merge': fail(128, 'fatal: could not reset'),
    });
    assert.deepEqual(result.entries[0].warnings, [leftStaged(null)]);
    assert.ok(halted(result));
  });

  for (const [label, probe] of [['an unexpected exit code', fail(128, 'fatal: bad ref')], ['a timeout', timedOut()]]) {
    test(`autostash state unknown (${label}): reset anyway, never pop blind, say so, continue`, () => {
      const { result, git } = killWave({
        'diff --cached --name-only': ok(''),
        'rev-parse --verify -q MERGE_AUTOSTASH': probe,
      });
      assert.deepEqual(result.entries[0].warnings, [autostashUnrestored]);
      assert.ok(continued(result));
      assert.equal(git.keys().includes('reset --merge'), true, 'the reset moves any autostash into the stash list');
      assert.equal(git.keys().includes('stash pop --index'), false);
    });
  }

  test('a failed autostash pop whose aftermath cannot be read halts', () => {
    const { result, git } = killWave({
      'diff --cached --name-only': [ok(''), ok(''), fail(128, 'fatal: index unreadable')],
      'rev-parse --verify -q MERGE_AUTOSTASH': ok('c0ffee'),
      'stash pop --index': fail(1, 'CONFLICT (content)'),
    });
    assert.deepEqual(result.entries[0].warnings, [autostashUnrestored, leftStaged(null)]);
    assert.ok(halted(result));
    const indexReads = git.calls.filter((c) => c.key === 'diff --cached --name-only');
    assert.equal(indexReads.length, 3, 'before, after the reset, and after the failed pop');
    assert.deepEqual(indexReads.map((c) => c.cwd), [REPO, REPO, REPO]);
  });
});

// ─── rescueSummaryArtifacts (via the wave, injected fs) ─────────────────────

describe('SUMMARY rescue: copy only what is missing or different, and block on a failed copy', () => {
  const REL = '.planning/q1-SUMMARY.md';
  const statusKey = `-C ${wtOf('a1')} status --porcelain --untracked-files=all`;
  const dest = path.join(REPO, '.planning', 'q1-SUMMARY.md');

  function rescueWave({ srcContent = 'S', destContent, readThrows = false, copyThrows = null }) {
    const ops = [];
    let srcAbs = null;
    const deps = {
      findSummaryFiles: (wt) => {
        srcAbs = path.join(wt, '.planning', 'q1-SUMMARY.md');
        return [srcAbs];
      },
      existsSync: (p) => p === dest && destContent !== undefined,
      readFileSync: (p) => {
        if (readThrows) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return p === dest ? destContent : srcContent;
      },
      mkdirSync: (d, o) => { ops.push(['mkdir', d, o]); },
      copyFileSync: (s, d) => {
        if (copyThrows) throw copyThrows;
        ops.push(['copy', s, d]);
      },
    };
    const { result, git } = runWave([entryFor('a1')], { [statusKey]: ok(`?? ${REL}`) }, deps);
    return { result, git, ops, srcAbs: () => srcAbs };
  }

  test('identical content already in the main tree: no copy, and the untracked SUMMARY is not "dirty"', () => {
    const { result, ops, git } = rescueWave({ destContent: 'S' });
    assert.deepEqual(ops, []);
    assert.equal(result.entries[0].status, 'merged_removed');
    const catFile = git.calls.find((c) => c.key.includes(' cat-file -e '));
    assert.deepEqual(catFile.args, ['-C', path.resolve(REPO, wtOf('a1')), 'cat-file', '-e', `HEAD:${REL}`]);
    assert.equal(catFile.cwd, REPO);
  });

  test('different content in the main tree is overwritten into a recursively created directory', () => {
    const { result, ops, srcAbs } = rescueWave({ destContent: 'OLD' });
    assert.deepEqual(ops, [['mkdir', path.dirname(dest), { recursive: true }], ['copy', srcAbs(), dest]]);
    assert.equal(result.entries[0].status, 'merged_removed');
  });

  test('an unreadable comparison is not a failure: it forces the copy', () => {
    const { result, ops } = rescueWave({ destContent: 'S', readThrows: true });
    assert.equal(ops.filter((o) => o[0] === 'copy').length, 1);
    assert.equal(result.entries[0].status, 'merged_removed');
  });

  test('a failed copy blocks the entry with the path and the error, and nothing is merged', () => {
    const { result, git } = rescueWave({ copyThrows: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) });
    assert.equal(result.entries[0].reason, 'summary_rescue_failed');
    assert.equal(result.entries[0].stderr, `${REL}: EACCES: permission denied`);
    assert.equal(git.keys().some((k) => k.startsWith(`merge ${brOf('a1')}`)), false);
  });
});

// ─── rescueSummaryArtifacts (default fs readers, real temp tree) ────────────

describe('SUMMARY rescue with the default fs readers', () => {
  const dirs = [];
  after(() => { for (const d of dirs) cleanup(d); });

  function fixture({ mainContent }) {
    const root = createTempDir('gsd-5232-rescue-');
    dirs.push(root);
    const repo = path.join(root, 'main');
    const wt = path.join(root, 'wt');
    const rel = path.join('.planning', 'quick', 'q1');
    fs.mkdirSync(path.join(wt, rel), { recursive: true });
    fs.writeFileSync(path.join(wt, rel, 'q1-SUMMARY.md'), 'executor summary\n');
    fs.mkdirSync(repo, { recursive: true });
    if (mainContent !== undefined) {
      fs.mkdirSync(path.join(repo, rel), { recursive: true });
      fs.writeFileSync(path.join(repo, rel, 'q1-SUMMARY.md'), mainContent);
    }
    return { repo, wt, mainFile: path.join(repo, rel, 'q1-SUMMARY.md') };
  }

  function realWave({ repo, wt }, deps = {}) {
    const git = scriptedGit({
      [`-C ${wt} rev-parse --abbrev-ref HEAD`]: ok(brOf('a1')),
      [`-C ${wt} status --porcelain --untracked-files=all`]: ok('?? .planning/quick/q1/q1-SUMMARY.md'),
    });
    const plan = { ...planFor([{ ...entryFor('a1'), worktree_path: wt }]), repoRoot: repo };
    return executeWorktreeWaveCleanupPlan(plan, { execGit: git, ...deps });
  }

  test('identical content is compared as text and left alone', () => {
    const fx = fixture({ mainContent: 'executor summary\n' });
    const copies = [];
    const result = realWave(fx, { copyFileSync: (s, d) => { copies.push([s, d]); } });
    assert.deepEqual(copies, []);
    assert.equal(result.entries[0].status, 'merged_removed');
  });

  test('divergent content is replaced with the executor\'s copy', () => {
    const fx = fixture({ mainContent: 'stale\n' });
    const result = realWave(fx);
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.equal(fs.readFileSync(fx.mainFile, 'utf8'), 'executor summary\n');
  });

  test('a missing nested .planning directory in the main tree is created, not a rescue failure', () => {
    const fx = fixture({ mainContent: undefined });
    const result = realWave(fx);
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.equal(fs.readFileSync(fx.mainFile, 'utf8'), 'executor summary\n');
  });
});
