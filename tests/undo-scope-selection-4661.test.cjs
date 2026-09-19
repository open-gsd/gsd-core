'use strict';

/**
 * #4661 — `/gsd:undo` decided scope membership with a regex built from the id.
 *
 * Both selectors in gsd-core/workflows/undo.md interpolated the requested phase
 * or plan id into an unanchored ERE over `git log --oneline` text and handed the
 * result to `git revert --no-commit`. This suite asserts BOTH directions, because
 * the obvious repair for one produces the other:
 *
 *   - no OVER-selection: a mention, a dotted-id wildcard collision, an id that is
 *     a regex operator;
 *   - no UNDER-selection: a `fixup!` / `Revert "` / `!:` subject of the same scope
 *     must come along, or the revert completes at rc=0 with phase work left behind.
 *
 * Each over-selection claim carries a negative control that runs the selector text
 * as it stood on `next` before this change, verbatim, over the same fixture. If the
 * old text did not misbehave here, the passing assertions would prove nothing.
 *
 * The range searched is #4465's concern and is not exercised here: every call
 * passes `HEAD`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { gitOrThrow, throwIfFailed } = require('./helpers/git-fixture.cjs');
const { createTempGitProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const scope = require('../gsd-core/bin/lib/git-scope-commits.cjs');
const { HEADER_RE } = require('../scripts/release-notes/conventional-title.cjs');

const SKIP_WIN32 = process.platform === 'win32'
  ? 'POSIX bash negative controls over a git fixture (see #2352 precedent)'
  : false;

// The two selectors as they stood on `next` (post-#4472) before this change.
const OLD_PHASE = 'git log --oneline --no-merges "${UNDO_RANGE}" | grep -E "\\(0*${TARGET_PHASE}(-[0-9]+)?\\):" || true';
const OLD_PLAN = 'git log --oneline --no-merges "${UNDO_RANGE}" | grep -E "\\(${TARGET_PLAN}\\):" || true';

describe('#4661: scope extraction and comparison (pure)', () => {
  test('the scope is read through the one conventional-header matcher, not a second copy', () => {
    // If this module ever grows its own header regex, this is the assertion that should
    // have been impossible to keep true: the declared scope is exactly HEADER_RE's group 2.
    for (const s of ['feat(03-01): x', 'fix(#12)!: y', 'docs: z', 'not a header', 'Feat(3A-2): w']) {
      const m = HEADER_RE.exec(s);
      const expected = m && m[2] ? m[2].slice(1, -1) : null;
      assert.equal(scope.declaredScope(s), expected, s);
    }
  });

  test('a scope quoted later in the subject is not a declaration', () => {
    assert.equal(scope.declaredScope('docs(99-01): explain feat(03-01): commit convention'), '99-01');
    assert.equal(scope.declaredScope('docs(99-01):feat(03-01): no-space mention'), '99-01');
    assert.equal(scope.declaredScope('docs(99-01):\tfeat(03-01): tab mention'), '99-01');
    assert.equal(scope.declaredScope('chore: bump (03-01) ref in the lockfile'), null);
  });

  test('git wrapper prefixes are unwrapped, including nested ones', () => {
    assert.equal(scope.declaredScope('fixup! feat(03-01): the real work'), '03-01');
    assert.equal(scope.declaredScope('squash! feat(03-01): the real work'), '03-01');
    assert.equal(scope.declaredScope('amend! feat(03-01): the real work'), '03-01');
    assert.equal(scope.declaredScope('Revert "feat(03-01): the real work"'), '03-01');
    assert.equal(scope.declaredScope('fixup! fixup! feat(03-01): the real work'), '03-01');
    assert.equal(scope.declaredScope('Revert "Revert "feat(03-01): the real work""'), '03-01');
    // git >= 2.43 writes `Reapply "…"` when the commit being reverted is itself a revert.
    assert.equal(scope.declaredScope('Reapply "feat(03-01): the real work"'), '03-01');
    assert.equal(scope.declaredScope('Revert "Reapply "feat(03-01): the real work""'), '03-01');
    // A wrapper word is only a wrapper at the START of the subject.
    assert.equal(scope.declaredScope('docs(99-01): mention fixup! feat(03-01): x'), '99-01');
  });

  test('the breaking-change marker is part of the grammar in both modes', () => {
    assert.equal(scope.declaredScope('feat(03-01)!: breaking change to the phase'), '03-01');
  });

  test('numeric ids compare as values: padding- and case-tolerant, never wildcarded', () => {
    const phase = (id) => ({ mode: 'phase', id });
    const plan = (id) => ({ mode: 'plan', id });
    assert.equal(scope.scopeMatchesTarget('03-01', phase('03')), true);
    assert.equal(scope.scopeMatchesTarget('03-01', phase('3')), true);
    assert.equal(scope.scopeMatchesTarget('03', phase('03')), true, 'a bare-phase scope still belongs to the phase');
    assert.equal(scope.scopeMatchesTarget('3a-02', phase('03A')), true);
    assert.equal(scope.scopeMatchesTarget('03-01', plan('3-1')), true);
    assert.equal(scope.scopeMatchesTarget('03-02', plan('03-01')), false);
    assert.equal(scope.scopeMatchesTarget('03', plan('03-01')), false);
    // #4661 §1a — `.` in a dotted id is a literal.
    assert.equal(scope.scopeMatchesTarget('23.1.2-01', phase('23.1.2')), true);
    assert.equal(scope.scopeMatchesTarget('23.112-01', phase('23.1.2')), false);
    assert.equal(scope.scopeMatchesTarget('23x1y2-01', phase('23.1.2')), false);
    // Plans are digit strings, not Numbers: these two differ, and Number() says they do not.
    assert.equal(Number('9007199254740992'), Number('9007199254740993'), 'premise: Number collapses them');
    assert.equal(scope.scopeMatchesTarget('03-9007199254740993', plan('03-9007199254740992')), false);
    assert.equal(scope.scopeMatchesTarget('03-9007199254740992', plan('03-9007199254740992')), true);
    assert.equal(scope.scopeMatchesTarget('03-0', plan('03-00')), true, 'an all-zero plan keeps one digit');
    // Padding is not identity in ANY dotted segment — comparePhaseNum, the equality phase.cts uses.
    assert.equal(scope.scopeMatchesTarget('03.01-1', phase('3.1')), true);
    assert.equal(scope.scopeMatchesTarget('3.1-1', phase('03.01')), true);
    assert.equal(scope.scopeMatchesTarget('3.10-1', phase('3.1')), false);
    assert.equal(scope.scopeMatchesTarget('3A-1', phase('3')), false);
    assert.equal(scope.scopeMatchesTarget('3-1', phase('3A')), false);
    // comparePhaseNum is Number-based and calls these two equal; the selector must not.
    assert.equal(scope.scopeMatchesTarget('9007199254740993-1', phase('9007199254740992')), false);
    assert.equal(scope.scopeMatchesTarget('3.9007199254740993-1', phase('3.9007199254740992')), false);
    assert.equal(scope.scopeMatchesTarget('9007199254740992-1', phase('9007199254740992')), true, 'exact match still selects');
    // A neighbouring phase that merely shares a prefix.
    assert.equal(scope.scopeMatchesTarget('031-01', phase('03')), false);
    assert.equal(scope.scopeMatchesTarget('03.1-01', phase('03')), false);
  });

  test('a malformed id is a literal, never an operator and never a retarget (#4661 §1b)', () => {
    // phaseKeyFromToken('03+') is '03' by design, so key equality ALONE would reintroduce
    // the retarget. The strict shape check in front of it is what this pins.
    assert.equal(scope.scopeMatchesTarget('03-01', { mode: 'phase', id: '03+' }), false);
    assert.equal(scope.scopeMatchesTarget('03-01', { mode: 'phase', id: '03.' }), false);
    assert.equal(scope.scopeMatchesTarget('03-01', { mode: 'phase', id: '0*' }), false);
    assert.equal(scope.scopeMatchesTarget('03-01', { mode: 'phase', id: '.*' }), false);
    assert.equal(scope.scopeMatchesTarget('03+-01', { mode: 'phase', id: '03+' }), true);
    assert.equal(scope.scopeMatchesTarget('03+-01', { mode: 'phase', id: '03' }), false);
  });

  test('a custom (non-numeric) id keeps selecting its own plans, literally', () => {
    assert.equal(scope.scopeMatchesTarget('PROJ-42', { mode: 'phase', id: 'PROJ-42' }), true);
    assert.equal(scope.scopeMatchesTarget('PROJ-42-01', { mode: 'phase', id: 'PROJ-42' }), true);
    assert.equal(scope.scopeMatchesTarget('PROJ-421', { mode: 'phase', id: 'PROJ-42' }), false);
    assert.equal(scope.scopeMatchesTarget('PROJ-42-beta', { mode: 'phase', id: 'PROJ-42' }), false);
    assert.equal(scope.scopeMatchesTarget('proj-42', { mode: 'phase', id: 'PROJ-42' }), false);
    // An id ending in `-` has no plan tail to admit.
    assert.equal(scope.scopeMatchesTarget('foo--01', { mode: 'phase', id: 'foo-' }), false);
    assert.equal(scope.scopeMatchesTarget('--1', { mode: 'phase', id: '-' }), false);
  });

  test('the git record shape is pinned, so display config cannot change what is parsed', () => {
    let seen = null;
    const out = scope.selectScopedCommits('/x', { mode: 'phase', id: '03' }, 'HEAD', {
      execGit: (args) => {
        seen = args;
        return { exitCode: 0, stdout: 'abc1234\tfeat(03-01): a\tb\ndef5678\tdocs(99-01): feat(03-01): c', stderr: '' };
      },
    });
    assert.ok(seen.includes('--no-color') && seen.includes('--no-merges'), seen.join(' '));
    assert.ok(seen.includes('--format=%h%x09%s'), seen.join(' '));
    assert.ok(!seen.includes('--oneline') && !seen.includes('--all'), seen.join(' '));
    assert.equal(seen[seen.length - 2], '--end-of-options', 'the range must not be parseable as a flag');
    // A tab INSIDE a subject belongs to the subject: only the first tab is the separator.
    assert.deepEqual(out, [{ sha: 'abc1234', subject: 'feat(03-01): a\tb' }]);
  });
});

describe('#4661: selection over a git fixture', { skip: SKIP_WIN32 }, () => {
  const mk = (cwd, message) => gitOrThrow(['commit', '-q', '--allow-empty', '-m', message], { cwd });

  // The issue's fixture, subject for subject.
  function issueFixture(t) {
    const cwd = createTempGitProject('gsd-4661-');
    t.after(() => cleanup(cwd));
    for (const m of [
      'feat(03-01): the real work',
      'fixup! feat(03-01): the real work',
      'Revert "feat(03-01): the real work"',
      'docs(99-01): explain feat(03-01): commit convention',
      'docs(99-01):feat(03-01): no-space mention',
      'docs(99-01):\tfeat(03-01): tab mention',
      'feat(03-01)!: breaking change to the phase',
      'feat(23.112-01): a different, legitimately-numbered phase',
      'feat(23x1y2-01): another collision',
      'feat(23.1.2-01): the actual dotted target',
      'chore: bump (03-01) ref in the lockfile',
      'feat(03+-01): a non-canonical id',
    ]) mk(cwd, m);
    return cwd;
  }

  const subjects = (out) => out.split('\n').filter(Boolean).map((l) => l.replace(/^[0-9a-f]+ /, ''));

  function select(cwd, ...args) {
    const r = runGsdTools(['query', 'git', 'scope-commits', ...args, '--range', 'HEAD'], cwd, { HOME: cwd });
    assert.equal(r.success, true, `scope-commits failed: ${r.error}`);
    return subjects(r.output);
  }

  function oldSelector(cwd, seed, line) {
    const script = [seed, 'UNDO_RANGE=HEAD', line].join('\n');
    const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd, env: { ...process.env, HOME: cwd }, timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(r, 'bash <pre-#4661 selector>');
    return subjects(r.stdout);
  }

  const PHASE_03 = [
    'feat(03-01)!: breaking change to the phase',
    'Revert "feat(03-01): the real work"',
    'fixup! feat(03-01): the real work',
    'feat(03-01): the real work',
  ];

  test('negative control: the pre-fix phase selector selected three phase-99 commits and dropped the `!:` one', (t) => {
    const cwd = issueFixture(t);
    const old = oldSelector(cwd, 'TARGET_PHASE=03', OLD_PHASE);
    assert.equal(old.filter((s) => s.startsWith('docs(99-01):')).length, 3, old.join('\n'));
    assert.ok(!old.includes('feat(03-01)!: breaking change to the phase'), old.join('\n'));
  });

  test('--phase selects exactly the commits that declare the phase — mentions out, fixup/Revert/`!:` in', (t) => {
    const cwd = issueFixture(t);
    assert.deepEqual(select(cwd, '--phase', '03'), PHASE_03);
    assert.deepEqual(select(cwd, '--phase', '3'), PHASE_03, 'padding is not identity');
  });

  test('--plan agrees with --phase about every commit both cover', (t) => {
    const cwd = issueFixture(t);
    assert.deepEqual(select(cwd, '--plan', '03-01'), PHASE_03);
    assert.deepEqual(oldSelector(cwd, 'TARGET_PLAN=03-01', OLD_PLAN).includes(PHASE_03[0]), false,
      'negative control: the pre-fix plan selector dropped the `!:` commit too');
  });

  test('a dotted id does not wildcard into a differently-numbered phase', (t) => {
    const cwd = issueFixture(t);
    assert.deepEqual(oldSelector(cwd, 'TARGET_PHASE=23.1.2', OLD_PHASE).sort(), [
      'feat(23.1.2-01): the actual dotted target',
      'feat(23.112-01): a different, legitimately-numbered phase',
      'feat(23x1y2-01): another collision',
    ], 'negative control: the pre-fix selector reverted two other phases');
    assert.deepEqual(select(cwd, '--phase', '23.1.2'), ['feat(23.1.2-01): the actual dotted target']);
  });

  test('an id that is a regex operator does not retarget to another phase', (t) => {
    const cwd = issueFixture(t);
    const old = oldSelector(cwd, "TARGET_PHASE='03+'", OLD_PHASE);
    assert.ok(old.includes('feat(03-01): the real work') && !old.includes('feat(03+-01): a non-canonical id'),
      `negative control: \`03+\` selected phase 03 and nothing named 03+; got:\n${old.join('\n')}`);
    assert.deepEqual(select(cwd, '--phase', '03+'), ['feat(03+-01): a non-canonical id']);
    assert.ok(oldSelector(cwd, "TARGET_PHASE='.*'", OLD_PHASE).length >= 10,
      'negative control: `.*` as an id selected nearly the whole history');
    assert.deepEqual(select(cwd, '--phase', '.*'), []);
  });

  test('the mention commits belong to the phase they open with, and only to it', (t) => {
    const cwd = issueFixture(t);
    assert.deepEqual(select(cwd, '--phase', '99'), [
      'docs(99-01):\tfeat(03-01): tab mention',
      'docs(99-01):feat(03-01): no-space mention',
      'docs(99-01): explain feat(03-01): commit convention',
    ]);
  });

  test('display configuration does not change the selection', (t) => {
    const cwd = issueFixture(t);
    gitOrThrow(['config', 'color.ui', 'always'], { cwd });
    gitOrThrow(['config', 'log.decorate', 'full'], { cwd });
    gitOrThrow(['config', 'core.abbrev', '12'], { cwd });
    assert.deepEqual(select(cwd, '--phase', '03'), PHASE_03);
  });

  test('an empty selection exits 0 and prints nothing', (t) => {
    const cwd = issueFixture(t);
    const r = runGsdTools(['query', 'git', 'scope-commits', '--phase', '77', '--range', 'HEAD'], cwd, { HOME: cwd });
    assert.equal(r.success, true, r.error);
    assert.equal(r.output.trim(), '');
  });

  test('a range git cannot read, and a missing flag, fail loudly rather than selecting nothing', (t) => {
    const cwd = issueFixture(t);
    const bad = runGsdTools(['query', 'git', 'scope-commits', '--phase', '03', '--range', 'nope..nada'], cwd, { HOME: cwd });
    assert.equal(bad.success, false, 'an unreadable range must not read as an empty selection');
    const usage = runGsdTools(['query', 'git', 'scope-commits', '--phase', '03'], cwd, { HOME: cwd });
    assert.equal(usage.success, false);
    const both = runGsdTools(['query', 'git', 'scope-commits', '--phase', '03', '--plan', '03-01', '--range', 'HEAD'], cwd, { HOME: cwd });
    assert.equal(both.success, false);
    // An option-shaped value is a missing value, not an id.
    mk(cwd, 'feat(--plan-01): a scope shaped like a flag');
    const flagAsId = runGsdTools(['query', 'git', 'scope-commits', '--phase', '--plan', '--range', 'HEAD'], cwd, { HOME: cwd });
    assert.equal(flagAsId.success, false, flagAsId.output);
    // …but only for ids: `--phase` is a legal branch name, so it is a legal --range.
    gitOrThrow(['update-ref', 'refs/heads/--phase', 'HEAD~1'], { cwd });
    const flagAsRange = runGsdTools(['query', 'git', 'scope-commits', '--phase', '03', '--range', '--phase'], cwd, { HOME: cwd });
    assert.equal(flagAsRange.success, true, flagAsRange.error);
    assert.deepEqual(subjects(flagAsRange.output), PHASE_03);
  });

  test('a revert-of-a-revert (`Reapply "`) is selected — it is what puts the phase back in the tree', (t) => {
    // Subjects written by git itself, not typed: `git revert` of a revert emits `Reapply "…"`
    // on git >= 2.43 and `Revert "Revert "…""` before it. Either way the commit re-applies
    // phase-03 work, so a selection without it reverts the phase and leaves it applied.
    const cwd = createTempGitProject('gsd-4661-reapply-');
    t.after(() => cleanup(cwd));
    fs.writeFileSync(path.join(cwd, 'feature.txt'), 'feature\n');
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'feat(03-01): the real work'], { cwd });
    gitOrThrow(['revert', '--no-edit', 'HEAD'], { cwd });
    gitOrThrow(['revert', '--no-edit', 'HEAD'], { cwd });
    const written = gitOrThrow(['log', '-1', '--format=%s'], { cwd }).trim();
    assert.match(written, /^(Reapply "|Revert "Revert ")feat\(03-01\)/, `unexpected subject from git: ${written}`);
    const got = select(cwd, '--phase', '03');
    assert.equal(got.length, 3, got.join('\n'));
    assert.equal(got[0], written);
  });

  test('an explicit --cwd names the repository to read, from anywhere', (t) => {
    const a = createTempGitProject('gsd-4661-cwd-a-');
    const b = createTempGitProject('gsd-4661-cwd-b-');
    t.after(() => { cleanup(a); cleanup(b); });
    mk(a, 'feat(03-01): from a');
    mk(b, 'feat(03-01): from b');
    const r = runGsdTools(['query', 'git', 'scope-commits', '--phase', '03', '--range', 'HEAD', '--cwd', a], b, { HOME: b });
    assert.equal(r.success, true, r.error);
    assert.deepEqual(subjects(r.output), ['feat(03-01): from a']);
  });

  test('resolveLogDir: the caller\'s worktree when it is the same repository, the resolved root otherwise', (t) => {
    const a = createTempGitProject('gsd-4661-dir-a-');
    const b = createTempGitProject('gsd-4661-dir-b-');
    t.after(() => { cleanup(a); cleanup(b); });
    mk(a, 'chore: base');
    const linked = path.join(a, '..', `${path.basename(a)}-linked`);
    gitOrThrow(['worktree', 'add', '-q', '-b', 'side', linked], { cwd: a });
    t.after(() => cleanup(linked));
    assert.equal(scope.resolveLogDir(a, linked), linked, 'a linked worktree of the same repository reads its own HEAD');
    assert.equal(scope.resolveLogDir(a, b), a, 'an unrelated caller directory never overrides the resolved root');
    assert.equal(scope.resolveLogDir(a, a), a);
    // Decided by git, never by the host process's arguments.
    process.argv.push('--cwd');
    t.after(() => process.argv.pop());
    assert.equal(scope.resolveLogDir(a, b), a);
    assert.equal(scope.resolveLogDir(a, linked), linked);
  });

  test('reverting the selection leaves NO phase work behind when a fixup touched a different file', (t) => {
    // The under-selection direction, end to end. Anchoring the old pattern at the record
    // start drops the `fixup!` commit; `git revert --no-commit` on what is left exits 0
    // with helper.txt still in the tree.
    const cwd = createTempGitProject('gsd-4661-revert-');
    t.after(() => cleanup(cwd));
    const commitFile = (rel, message) => {
      fs.writeFileSync(path.join(cwd, rel), `${rel}\n`);
      gitOrThrow(['add', '-A'], { cwd });
      gitOrThrow(['commit', '-q', '-m', message], { cwd });
    };
    commitFile('feature.txt', 'feat(03-01): the real work');
    commitFile('helper.txt', 'fixup! feat(03-01): the real work');

    const r = runGsdTools(['query', 'git', 'scope-commits', '--phase', '03', '--range', 'HEAD'], cwd, { HOME: cwd });
    assert.equal(r.success, true, r.error);
    const shas = r.output.split('\n').filter(Boolean).map((l) => l.split(' ')[0]);
    assert.equal(shas.length, 2, r.output);
    for (const sha of shas) gitOrThrow(['revert', '--no-commit', sha], { cwd });
    assert.equal(fs.existsSync(path.join(cwd, 'feature.txt')), false, 'feature.txt must be reverted');
    assert.equal(fs.existsSync(path.join(cwd, 'helper.txt')), false,
      'helper.txt is phase-03 work carried by the fixup — leaving it is the silent partial revert');
  });
});
