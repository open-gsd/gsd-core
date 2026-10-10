'use strict';

/**
 * Evaluation-scope resolver (#5164, epic #5056, ADR-5057 §4 second bullet).
 *
 * Behavioral tests against real git fixtures: the scope is the UNION of the unit's own commits'
 * file sets (never a range), only branch-reachable commits count, an empty union degrades loudly,
 * and everything the union drops is named by path. Git failure is injected through the resolver's
 * `execGit` seam (never a mode-bit trick).
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const {
  resolveEvaluationScope,
  evaluateEvaluationScope,
  extractTaskCommitRefs,
  planSubjectPattern,
  isSafeRefArgument,
  SCOPE_EXCLUSION_PATHSPECS,
} = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.io',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.io',
};
const PHASE_DIR = '.planning/phases/03-scope';

const dirs = [];
afterEach(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

function write(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-scope-'));
  dirs.push(dir);
  const git = (...args) => gitOrThrow(args, { cwd: dir, env: { ...process.env, ...IDENTITY } }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.io');
  git('config', 'user.name', 'Test');
  write(dir, '.planning/config.json', '{}');
  write(dir, `${PHASE_DIR}/03-CONTEXT.md`, 'context\n');
  git('add', '.');
  git('commit', '-m', 'docs(03): scaffold phase');
  return { dir, git };
}

/** Commit one real file; returns the full sha. */
function commit(repo, rel, message, content = `${rel}\n`) {
  write(repo.dir, rel, content);
  repo.git('add', rel);
  repo.git('commit', '-m', message);
  return repo.git('rev-parse', 'HEAD');
}

/** Write a SUMMARY whose `## Task Commits` rows name `shas`, and commit it. */
function summarize(repo, shas, name = '03-01-SUMMARY.md') {
  const rows = shas.map((sha, i) => `${i + 1}. **Task ${i + 1}: work** - \`${sha}\``).join('\n');
  commit(repo, `${PHASE_DIR}/${name}`, 'docs(03-01): summary', `# Summary\n\n## Task Commits\n\n${rows}\n\n## Next\n`);
}

describe('resolveEvaluationScope — phase unit', () => {
  test('[happy] scope is the union of the task commits\' own file sets', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    summarize(repo, [a, b]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.source, 'task-commits');
    assert.equal(scope.reason, null);
    assert.deepEqual(scope.files, ['src/a.js', 'src/b.js']);
    assert.deepEqual(scope.commits.map((c) => c.sha), [a, b]);
    assert.deepEqual(scope.commits[0].files, ['src/a.js']);
    assert.deepEqual(scope.unreachable, []);
  });

  test('[regression #3926] interleaved non-phase commits stay out of scope and are named', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'other/quick-task.js', 'fix(quick): unrelated work');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    summarize(repo, [a, b]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js', 'src/b.js']);
    assert.deepEqual(scope.outsideUnion, ['other/quick-task.js']);
  });

  test('[regression #3926] post-phase work landed after the last task commit is not in scope', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    commit(repo, 'src/later-phase.js', 'feat(04-01): next phase');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js']);
  });

  test('[hostile] a task commit that lives only on another branch is named and excluded', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    repo.git('checkout', '-b', 'side');
    const side = commit(repo, 'src/side.js', 'feat(03-01): side only');
    repo.git('checkout', 'main');
    summarize(repo, [a, side]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js']);
    assert.deepEqual(scope.unreachable, [side]);
  });

  test('[negative] no SUMMARY degrades to the phase range and says why', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'no-summary');
    assert.equal(scope.source, 'phase-range');
    assert.deepEqual(scope.files, ['src/a.js']);
    assert.notEqual(scope.rangeBase, null);
  });

  test('[negative] a SUMMARY with no task rows degrades', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, `${PHASE_DIR}/03-01-SUMMARY.md`, 'docs(03-01): summary', '# Summary\n\n## Task Commits\n\nnone\n\n## Next\n');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'no-task-commit-rows');
    assert.deepEqual(scope.files, ['src/a.js']);
  });

  test('[negative] ids no object answers to degrade, named, never an empty resolved scope', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const ghost = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    summarize(repo, [ghost]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'no-reachable-task-commits');
    assert.deepEqual(scope.unreachable, [ghost]);
    assert.deepEqual(scope.files, ['src/a.js']);
  });

  test('[negative] a planning-only phase never becomes an empty scope that reviews nothing', () => {
    const repo = makeRepo();
    const planning = commit(repo, `${PHASE_DIR}/03-01-NOTES.md`, 'docs(03-01): notes');
    summarize(repo, [planning]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'empty-after-exclusions');
    assert.equal(scope.source, 'phase-range');
  });

  test('[negative] a phase directory git never saw has no anchor: unresolvable, not empty', () => {
    const repo = makeRepo();
    write(repo.dir, '.planning/phases/04-fresh/04-CONTEXT.md', 'untracked\n');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '4' });
    assert.equal(scope.status, 'unresolvable');
    assert.match(scope.reason, /no-phase-start-anchor$/);
    assert.deepEqual(scope.files, []);
  });

  test('[negative] an unknown phase is unresolvable', () => {
    const repo = makeRepo();
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '9' });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'phase-dir-not-found');
  });

  test('[negative] scoped paths deleted later are named, not silently counted', () => {
    const repo = makeRepo();
    const keep = commit(repo, 'src/keep.js', 'feat(03-01): keep');
    const gone = commit(repo, 'src/gone.js', 'feat(03-01): gone');
    repo.git('rm', 'src/gone.js');
    repo.git('commit', '-m', 'chore: later removal');
    summarize(repo, [keep, gone]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.changedFiles, ['src/gone.js', 'src/keep.js']);
    assert.deepEqual(scope.files, ['src/keep.js']);
    assert.deepEqual(scope.missingOnDisk, ['src/gone.js']);
  });

  test('[boundary] a merge commit contributes its diff against the first parent', () => {
    const repo = makeRepo();
    repo.git('checkout', '-b', 'side');
    commit(repo, 'src/merged.js', 'feat(03-01): on side');
    repo.git('checkout', 'main');
    commit(repo, 'src/main-only.js', 'feat(03-01): on main');
    repo.git('merge', '--no-ff', 'side', '-m', 'feat(03-01): merge side');
    const merge = repo.git('rev-parse', 'HEAD');
    summarize(repo, [merge]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/merged.js']);
  });

  test('[boundary] `since` drops that commit and its ancestors (wave scoping)', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    summarize(repo, [a, b]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, { since: a });
    assert.deepEqual(scope.files, ['src/b.js']);
    assert.equal(scope.rangeBase, a);
  });

  test('[independence] exclusions never reach the scope', () => {
    const repo = makeRepo();
    write(repo.dir, 'package-lock.json', '{}\n');
    repo.git('add', 'package-lock.json');
    write(repo.dir, 'src/a.js', 'a\n');
    repo.git('add', 'src/a.js');
    repo.git('commit', '-m', 'feat(03-01): a and lockfile');
    summarize(repo, [repo.git('rev-parse', 'HEAD')]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js']);
    assert.ok(SCOPE_EXCLUSION_PATHSPECS.includes(':!package-lock.json'));
  });
});

describe('extractTaskCommitRefs', () => {
  test('[hostile] a sha in prose, on the metadata line or outside the section is not a task commit', () => {
    const doc = [
      '`1111111` quoted before the section',
      '## Task Commits',
      '',
      'Prose quoting `2222222` is not a row.',
      '**Plan metadata:** `3333333`',
      '1. **Task 1: real** - `4444444`',
      '- **Task 2: two commits** - `5555555` `6666666`',
      '## Next',
      '1. **Task 3: after the section** - `7777777`',
    ].join('\n');
    assert.deepEqual(extractTaskCommitRefs(doc), ['4444444', '5555555', '6666666']);
  });

  test('[property] only hex tokens on task rows inside the section contribute', () => {
    const hex = fc.stringMatching(/^[0-9a-f]{7,40}$/);
    const line = fc.oneof(
      fc.record({ kind: fc.constant('row'), hashes: fc.array(hex, { minLength: 1, maxLength: 3 }) }),
      fc.record({ kind: fc.constant('prose'), hashes: fc.array(hex, { minLength: 1, maxLength: 2 }) }),
      fc.record({ kind: fc.constant('meta'), hashes: fc.array(hex, { minLength: 1, maxLength: 1 }) }),
    );
    fc.assert(fc.property(fc.array(line, { maxLength: 12 }), fc.array(hex, { maxLength: 3 }), (lines, outside) => {
      const body = lines.map((entry, i) => {
        const ticks = entry.hashes.map((h) => `\`${h}\``).join(' ');
        if (entry.kind === 'row') return `${i + 1}. **Task ${i + 1}: t** - ${ticks}`;
        if (entry.kind === 'prose') return `see ${ticks}`;
        return `**Plan metadata:** ${ticks}`;
      });
      const before = outside.map((h, i) => `${i + 1}. **Task ${i + 1}: before** - \`${h}\``);
      const doc = [...before, '## Task Commits', ...body, '## End'].join('\n');
      const expected = lines.filter((e) => e.kind === 'row').flatMap((e) => e.hashes);
      assert.deepEqual(extractTaskCommitRefs(doc), expected);
    }), { seed: 5164, numRuns: 100 });
  });

  test('[property positive control] a document with only prose shas yields none', () => {
    assert.deepEqual(extractTaskCommitRefs('## Task Commits\nsee `abcdef1`\n## End\n'), []);
  });
});

describe('resolveEvaluationScope — plan and quick units', () => {
  test('[happy] subjects match anchored, tolerant of zero padding, `!` and any type', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'tests/a.test.js', 'test(3-1): red');
    commit(repo, 'src/c.js', 'fix(03-01)!: breaking');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.source, 'plan-subjects');
    assert.deepEqual(scope.commits.map((c) => c.subject).sort(), ['feat(03-01): a', 'fix(03-01)!: breaking', 'test(3-1): red']);
  });

  test('[boundary] the id boundary: 03-010 and 03-02 and a body line do not match 03-01', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'src/b.js', 'feat(03-010): not this plan');
    commit(repo, 'src/c.js', 'feat(03-02): not this plan');
    commit(repo, 'src/d.js', 'chore: body mention\n\nfeat(03-01): quoted in a body line');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    assert.deepEqual(scope.commits.map((c) => c.subject), ['feat(03-01): a']);
  });

  test('[hostile] ERE metacharacters in a plan id cannot widen the pattern', () => {
    // An id that is not `<phase>-<plan>` is matched LITERALLY, never as a pattern.
    const wildcard = new RegExp(planSubjectPattern('x.*'));
    assert.ok(wildcard.test('test(x.*): red'));
    assert.ok(!wildcard.test('test(xyz): red'), 'a plan named `x.*` is not satisfied by unrelated commits');
    const bracket = new RegExp(planSubjectPattern('a[b]'));
    assert.ok(bracket.test('feat(a[b]): g'));
    assert.ok(!bracket.test('feat(ab): g'));
    const dotted = new RegExp(planSubjectPattern('3.1-2'));
    assert.ok(dotted.test('feat(3.1-2): x'));
    assert.ok(!dotted.test('feat(3x1-2): x'));
    // An empty, over-long or whitespace-bearing id is refused outright.
    assert.equal(planSubjectPattern(''), null);
    assert.equal(planSubjectPattern('a b'), null);
    assert.equal(planSubjectPattern('x'.repeat(201)), null);
    assert.notEqual(planSubjectPattern('x'.repeat(200)), null);
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(abc-1): unrelated');
    const literal = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '.*-1' });
    assert.equal(literal.status, 'resolved');
    assert.deepEqual(literal.commits, [], '`.*-1` must not match feat(abc-1)');
    assert.equal(resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '' }).reason, 'invalid-plan-id');
  });

  test('[regression] a project-coded plan id resolves the plan\'s own commits (#5271)', () => {
    // `init.execute-phase` hands out `PRJ-01` where `init.plan-phase` hands out `01`, so the
    // gates' `--plan PRJ-01-01` used to resolve "no-matching-commits" at exit 0 — the honest
    // answer for a plan that has NOT started — for a plan that has.
    const repo = makeRepo();
    write(repo.dir, '.planning/config.json', JSON.stringify({ project_code: 'PRJ' }));
    repo.git('add', '.planning/config.json');
    repo.git('commit', '-m', 'docs(config): set project_code');
    commit(repo, 'src/a.js', 'feat(01-01): a');
    commit(repo, 'src/b.js', 'fix(01-01)!: breaking');
    commit(repo, 'src/c.js', 'feat(01-02): another plan');
    commit(repo, 'src/d.js', 'feat(01-010): not this plan');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: 'PRJ-01-01' });
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.source, 'plan-subjects');
    assert.notEqual(scope.reason, 'no-matching-commits', 'the plan HAS commits, so an empty scope is not the answer');
    assert.deepEqual(
      scope.commits.map((c) => c.subject).sort(),
      ['feat(01-01): a', 'fix(01-01)!: breaking'],
      'the coded id resolves the plan\'s commits, and only its own',
    );
    const bare = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '01-01' });
    assert.deepEqual(
      scope.commits.map((c) => c.sha).sort(),
      bare.commits.map((c) => c.sha).sort(),
      'the coded and bare ids name ONE plan, so they resolve the same commits (#5177 grammar)',
    );
  });

  test('[regression] a coded plan id matches a commit spelled either way (#5271)', () => {
    const matches = (planId, subject, code) => new RegExp(planSubjectPattern(planId, code)).test(subject);
    assert.ok(matches('PRJ-01-01', 'feat(01-01): a', 'PRJ'), 'the executor writes the BARE phase token');
    assert.ok(matches('PRJ-01-01', 'feat(PRJ-01-01): a', 'PRJ'), 'and the coded spelling still resolves');
    assert.ok(matches('PRJ-01-01', 'fix(PRJ-1-1)!: breaking', 'PRJ'), 'zero padding stays tolerant under the code');
    assert.ok(!matches('PRJ-01-01', 'feat(OTHER-01-01): a', 'PRJ'), 'a DIFFERENT project code is a different plan');
    assert.ok(!matches('PRJ-01-01', 'feat(01-010): a', 'PRJ'), 'and the id boundary is unchanged');
    assert.ok(matches('PROJ_V2-03-01', 'feat(03-01): a', 'PROJ_V2'), 'an underscore-bearing code is the project_code grammar');
    assert.ok(!matches('PRJ-01-01', 'feat(01-01): a', null), 'with NO configured code the coded id stays literal (#5271 Major 1)');
  });

  test('[regression] only the CONFIGURED code is stripped; a lookalike id stays literal (#5271)', () => {
    // The phase-id grammar `^[A-Z][A-Z0-9_]*-(?=\d)`/`i` recognises ANY letter prefix. Stripping it
    // here made `AUTH-01-02` and `setup-1-2` resolve ANOTHER plan's commits (#5271 Major 1).
    const matches = (planId, subject) => new RegExp(planSubjectPattern(planId, 'PRJ')).test(subject);
    assert.ok(matches('AUTH-01-02', 'feat(AUTH-01-02): its own'), 'a different code matches its own commit');
    assert.ok(!matches('AUTH-01-02', 'feat(01-02): unrelated'), 'and NOT another plan\'s bare commits');
    assert.ok(!matches('AUTH-01-02', 'feat(1-2):'), 'nor the unpadded spelling');
    assert.ok(matches('setup-1-2', 'feat(setup-1-2): its own'), 'a hyphenated plan-file id stays literal');
    assert.ok(!matches('setup-1-2', 'feat(1-2): unrelated'), 'and does not resolve a numbered plan either');
    assert.ok(!matches('setup-1-2', 'feat(01-02): unrelated'), 'nor a padded one');
    assert.ok(!matches('prj-01-01', 'feat(01-01): a'), 'the code match is CASE-SENSITIVE');
    assert.ok(matches('prj-01-01', 'feat(prj-01-01): a'), 'so a lowercase code is matched literally');
    assert.ok(!matches('PRJ-01', 'feat(01): a'), 'a code WITHOUT a plan segment stays literal');
  });

  test('[regression] the milestone-prefixed coded shape resolves both spellings (#5271 Major 3)', () => {
    // `PRJ-01-02-03` strips to `01-02-03`, whose plan half still carries a dash, so the literal
    // fall-through previously emitted `PRJ-01-02-03` alone and never the bare spelling.
    const matches = (planId, subject) => new RegExp(planSubjectPattern(planId, 'PRJ')).test(subject);
    assert.equal(planSubjectPattern('PRJ-01-02-03', 'PRJ'), '^[a-z]+\\((PRJ-)?01-02-03\\)!?:',
      'the fall-through literal keeps the OPTIONAL code group, so it is not bare `PRJ-01-02-03`');
    assert.ok(matches('PRJ-01-02-03', 'feat(PRJ-01-02-03): a'), 'the coded spelling resolves');
    assert.ok(matches('PRJ-01-02-03', 'feat(01-02-03): a'), 'and so does the BARE spelling, as for every other shape');
    assert.ok(!matches('PRJ-01-02-03', 'feat(01-02-04): a'), 'but a different sub-phase does not');
    assert.ok(matches('PRJ-01-01-extra', 'feat(PRJ-01-01-extra): a'), 'a trailing suffix is still literal, and resolves');
  });

  test('[regression] the coded id matches through REAL git, not only a JS RegExp (#5271 Minor 3)', () => {
    // git's ERE has no `(?:…)`; the JS-side RegExp accepts it, so only a real `git log` proves the
    // pattern is well-formed on the side that actually runs it.
    const repo = makeRepo();
    write(repo.dir, '.planning/config.json', JSON.stringify({ project_code: 'PRJ' }));
    repo.git('add', '.planning/config.json');
    repo.git('commit', '-m', 'docs(config): set project_code');
    commit(repo, 'src/coded.js', 'feat(PRJ-01-01): coded spelling');
    commit(repo, 'src/other.js', 'feat(02-01): another phase');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: 'PRJ-01-01' });
    assert.equal(scope.source, 'plan-subjects', 'the ERE reached git and matched, so it is not a syntax error');
    assert.deepEqual(
      scope.commits.map((c) => c.subject),
      ['feat(PRJ-01-01): coded spelling'],
      'the coded commit is found through real git',
    );
  });

  test('[regression] a coded id with no commits resolves empty at exit 0 (#5271 Minor 1)', () => {
    const repo = makeRepo();
    write(repo.dir, '.planning/config.json', JSON.stringify({ project_code: 'PRJ' }));
    repo.git('add', '.planning/config.json');
    repo.git('commit', '-m', 'docs(config): set project_code');
    commit(repo, 'src/other.js', 'feat(02-01): another phase');
    for (const planId of ['PRJ-01-09', 'PRJ-1-1', 'PRJ-01-02-03']) {
      const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId });
      assert.equal(scope.status, 'resolved', `${planId} resolves`);
      assert.deepEqual(scope.commits, [], `${planId} has no commits of its own`);
    }
  });

  // #5271 Minor 2: the OPTIONAL code group rode on the bare literal fall-through, so a remainder
  // that is not a plan number kept it and the pattern widened past the pre-#5271 literal.
  test('[regression] a coded id whose remainder is not a plan number stays literal (#5271 Minor 2)', () => {
    assert.equal(planSubjectPattern('PRJ-', 'PRJ'), '^[a-z]+\\(PRJ-\\)!?:',
      '`PRJ-` strips to an empty remainder, so the OPTIONAL group would match a bare `feat():`');
    assert.equal(planSubjectPattern('PRJ-a.b', 'PRJ'), '^[a-z]+\\(PRJ-a\\.b\\\)!?:',
      'a non-numeric remainder keeps the whole id literal, not `(PRJ-)?a\\.b`');
    for (const [planId, subject] of [
      ['PRJ-', 'feat(): a subject no plan assigns'],
      ['PRJ-a.b', 'feat(a.b): another plan\'s literal id'],
    ]) {
      const pattern = planSubjectPattern(planId, 'PRJ');
      assert.ok(!new RegExp(pattern).test(subject), `${planId} must not match ${subject}`);
    }
    // The shapes that legitimately take the group are unchanged by the narrowing.
    assert.equal(planSubjectPattern('PRJ-01-01', 'PRJ'), '^[a-z]+\\((PRJ-)?0*1-0*1\\)!?:');
    assert.equal(planSubjectPattern('PRJ-01-02-03', 'PRJ'), '^[a-z]+\\((PRJ-)?01-02-03\\)!?:',
      'the milestone-prefixed coded shape still takes the group: its remainder starts with the phase number');
  });

  // #5271 Nit 4 / Minor 3: `configuredProjectCode` treats an unsupported grammar as ABSENT. Both
  // that degradation and an unreadable config must be pinned, not assumed.
  test('[regression] an unsupported or unreadable project_code leaves coded ids literal (#5271 Nit 4, Minor 3)', () => {
    const configured = (value) => {
      const repo = makeRepo();
      write(repo.dir, '.planning/config.json', typeof value === 'string' ? value : JSON.stringify({ project_code: value }));
      repo.git('add', '.planning/config.json');
      repo.git('commit', '-m', 'docs(config): set project_code');
      return repo;
    };
    const codedCommit = (repo) => commit(repo, 'src/coded.js', 'feat(01-01): the bare spelling');
    for (const [label, value] of [['a lowercase code', 'prj'], ['a hyphenated code', 'AUTH-X'], ['an empty code', '']]) {
      const repo = configured(value);
      codedCommit(repo);
      const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: 'PRJ-01-01' });
      assert.deepEqual(scope.commits, [], `${label} is outside the supported grammar, so the id stays literal`);
      assert.equal(scope.status, 'resolved', `${label} still resolves (empty), it never widens`);
    }
    const unparseable = configured('{ not json');
    codedCommit(unparseable);
    const scope = resolveEvaluationScope(unparseable.dir, { kind: 'plan', planId: 'PRJ-01-01' });
    assert.deepEqual(scope.commits, [], 'an unparseable config reads as absent, never as a wider pattern');
    // A supported code still resolves the coded id, so the rows above are the grammar and not a
    // broken reader (the positive path itself is covered end-to-end by the real-git row above).
    for (const code of ['PRJ', 'PROJ_V2']) {
      const codedId = `${code}-01-01`;
      const supported = planSubjectPattern(codedId, code);
      assert.ok(new RegExp(supported).test('feat(01-01): the bare spelling'), `${codedId} resolves the bare spelling`);
      assert.ok(new RegExp(supported).test(`feat(${codedId}): the coded spelling`), `${codedId} resolves the coded spelling`);
    }
  });

  // #5271 Minor 1: hand-picked ids over a fixed fixture read as coverage. The transform's own
  // invariant is the property: whatever the code and the id, the coded spelling adds exactly the
  // CREDITS of its own commits, and a NON-configured prefix is never a substitute for one.
  test('[property] a coded id resolves the same subjects as its bare id, plus the coded spelling (#5271 Minor 1)', () => {
    const pad = (n) => String(n).padStart(2, '0');
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z][A-Z0-9_]{0,6}$/),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        fc.stringMatching(/^[A-Z][A-Z0-9_]{0,6}$/),
        (code, phase, plan, otherCode) => {
          const bareId = `${pad(phase)}-${pad(plan)}`;
          const codedId = `${code}-${bareId}`;
          const corpus = [
            `feat(${bareId}): padded spelling`,
            `fix(${bareId})!: padded with the breaking marker`,
            `test(${phase}-${plan}): unpadded spelling`,
            `feat(${codedId}): the coded spelling`,
            `fix(${codedId})!: the coded spelling with the breaking marker`,
            `feat(${otherCode}-${bareId}): another project's code`,
            `feat(${otherCode}-${phase}-${plan}): another project's code, unpadded`,
          ];
          const matched = (pattern) => corpus.filter((subject) => new RegExp(pattern).test(subject));
          const bareMatches = matched(planSubjectPattern(bareId));
          const codedMatches = matched(planSubjectPattern(codedId, code));
          assert.ok(
            bareMatches.every((subject) => codedMatches.includes(subject)),
            `${codedId} must match every subject ${bareId} matches`,
          );
          for (const subject of codedMatches) {
            assert.ok(
              bareMatches.includes(subject) || subject.startsWith(`feat(${codedId})`) || subject.startsWith(`fix(${codedId})`),
              `${codedId} may add only its OWN coded spelling, but it also matched ${subject}`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test('[regression] a plan commit that lives only on another branch is not returned', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): green');
    repo.git('checkout', '-b', 'side');
    commit(repo, 'tests/red.test.js', 'test(03-01): red on a side branch');
    repo.git('checkout', 'main');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    assert.deepEqual(scope.commits.map((c) => c.subject), ['feat(03-01): green']);
  });

  test('[boundary] maxCommits at limit-1, limit and limit+1', () => {
    const repo = makeRepo();
    for (const n of ['a', 'b', 'c']) commit(repo, `src/${n}.js`, `feat(03-01): ${n}`);
    const count = (maxCommits) => resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { maxCommits }).commits.length;
    assert.deepEqual([count(2), count(3), count(4)], [2, 3, 3]);
  });

  test('[happy] pathspecs restrict to commits touching them (the RED-commit lookup)', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): impl');
    commit(repo, 'tests/a.test.js', 'test(03-01): red');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { pathspecs: ['tests/'] });
    assert.deepEqual(scope.commits.map((c) => c.subject), ['test(03-01): red']);
  });

  test('[boundary] milestoneBound drops commits older than the latest tag', () => {
    const repo = makeRepo();
    commit(repo, 'src/old.js', 'feat(03-01): before the tag');
    repo.git('tag', 'v1.0.0');
    commit(repo, 'src/new.js', 'feat(03-01): after the tag');
    const unbounded = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    const bounded = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { milestoneBound: true });
    assert.equal(unbounded.commits.length, 2);
    assert.deepEqual(bounded.commits.map((c) => c.subject), ['feat(03-01): after the tag']);
  });

  test('[happy] a quick unit is the union of the commits naming its id', () => {
    const repo = makeRepo();
    commit(repo, 'src/q1.js', 'fix(quick-260101-abc): one');
    commit(repo, 'other/n.js', 'fix: unrelated');
    commit(repo, 'src/q2.js', 'docs(quick-260101-abc): two');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'quick', id: '260101-abc' });
    assert.equal(scope.source, 'quick-subjects');
    assert.deepEqual(scope.files, ['src/q1.js', 'src/q2.js']);
  });
});

describe('resolveEvaluationScope — failure is never an empty scope', () => {
  const fail = (result) => () => result;

  test('[negative] git missing is unresolvable, with the reason', () => {
    const scope = resolveEvaluationScope('/nonexistent', { kind: 'plan', planId: '03-01' },
      { execGit: fail({ exitCode: 127, stdout: '', stderr: 'git: not found', signal: null, error: null, timedOut: false }) });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-unavailable');
    assert.deepEqual(scope.files, []);
  });

  test('[negative] a git timeout is unresolvable, not a throw', () => {
    const scope = resolveEvaluationScope('/nonexistent', { kind: 'plan', planId: '03-01' },
      { execGit: fail({ exitCode: 1, stdout: '', stderr: '', signal: 'SIGTERM', error: null, timedOut: true }) });
    assert.equal(scope.reason, 'git-timeout');
  });

  test('[negative] a directory that is not a repository is unresolvable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-scope-nogit-'));
    dirs.push(dir);
    const scope = resolveEvaluationScope(dir, { kind: 'plan', planId: '03-01' });
    assert.equal(scope.status, 'unresolvable');
    assert.match(scope.reason, /^git-failed:/);
  });

  test('[hostile] option-shaped or whitespace refs are refused before any git call', () => {
    const calls = [];
    const spy = (args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null, timedOut: false }; };
    assert.equal(resolveEvaluationScope('/x', { kind: 'plan', planId: '03-01' }, { ref: '--output=x', execGit: spy }).reason, 'unsafe-ref');
    assert.equal(resolveEvaluationScope('/x', { kind: 'plan', planId: '03-01' }, { since: 'a b', execGit: spy }).reason, 'unsafe-since');
    assert.deepEqual(calls, []);
    assert.ok(!isSafeRefArgument('-x'));
    assert.ok(isSafeRefArgument('HEAD~2'));
  });
});

describe('evaluateEvaluationScope — the check verb', () => {
  test('[negative] argv validation returns a usage failure naming the problem', () => {
    const messageOf = (args) => evaluateEvaluationScope({ projectDir: '/x', args }).failure.message;
    assert.match(messageOf([]), /exactly one of --phase/);
    assert.match(messageOf(['--phase', '3', '--plan', '03-01']), /exactly one of --phase/);
    assert.match(messageOf(['--bogus']), /unknown argument: --bogus/);
    assert.match(messageOf(['--phase']), /--phase requires a value/);
  });

  test('[happy] a verdict carries the scope payload in a pinned key order; outcome follows status', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    const resolved = evaluateEvaluationScope({ projectDir: repo.dir, args: ['--phase', '3'] });
    assert.deepEqual(Object.keys(resolved.payload), [
      'unit', 'status', 'source', 'reason', 'commits', 'changedFiles', 'files',
      'missingOnDisk', 'outsideUnion', 'unreachable', 'rangeBase',
    ]);
    assert.equal(resolved.outcome, 'pass');
    assert.equal(resolved.block, false);
    // "Could not look" (an unresolvable scope) is outcome `unreadable`, never a pass-shaped `skip`; the
    // resolver never blocks, and the payload still carries the reason (#5170).
    const unresolvable = evaluateEvaluationScope({ projectDir: repo.dir, args: ['--phase', '9'] });
    assert.equal(unresolvable.outcome, 'unreadable');
    assert.equal(unresolvable.block, false);
    assert.equal(unresolvable.payload.status, 'unresolvable');
    const bare = makeRepo();
    commit(bare, 'src/z.js', 'feat(03-01): z');
    assert.equal(evaluateEvaluationScope({ projectDir: bare.dir, args: ['--phase', '3'] }).outcome, 'advisory');
    // An empty-but-resolved plan scope carries a reason and is advisory, never a clean pass.
    assert.equal(evaluateEvaluationScope({ projectDir: bare.dir, args: ['--plan', '09-09'] }).outcome, 'advisory');
  });

  test('[boundary] --max-commits accepts 1 and the 1000 ceiling, refuses 0 and 1001', () => {
    const verdict = (value) => evaluateEvaluationScope({ projectDir: '/x', args: ['--plan', '03-01', '--max-commits', value] });
    assert.match(verdict('0').failure.message, /--max-commits must be an integer from 1 to 1000/);
    assert.match(verdict('1001').failure.message, /--max-commits must be an integer from 1 to 1000/);
    assert.equal(verdict('1').failure, undefined);
    assert.equal(verdict('1000').failure, undefined);
  });
});

// ─── Seams driven through an injected git runner ──────────────────────────────

const { execGit: realExecGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const TIMED_OUT = { exitCode: 1, stdout: '', stderr: '', signal: 'SIGTERM', error: null, timedOut: true };

/** A git runner that records every argv and delegates to the real git unless `force` answers. */
function spyGit(force) {
  const calls = [];
  const run = (args, opts) => {
    calls.push(args);
    const forced = force ? force(args) : undefined;
    return forced ?? realExecGit(args, opts);
  };
  run.calls = calls;
  return run;
}

describe('resolveEvaluationScope — limits at limit-1, limit and limit+1', () => {
  test('[boundary] the sha chunk size never changes the answer (chunk 2/3/4 over 3 task commits; 1 is clamped to 2)', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'other/noise.js', 'fix: noise');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    const c = commit(repo, 'src/c.js', 'feat(03-01): c');
    summarize(repo, [a, b, c]);
    const at = (shaChunk) => {
      const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, { shaChunk });
      return { files: scope.files, outside: scope.outsideUnion, shas: scope.commits.map((x) => x.sha) };
    };
    const expected = { files: ['src/a.js', 'src/b.js', 'src/c.js'], outside: ['other/noise.js'], shas: [a, b, c] };
    assert.deepEqual(at(2), expected, 'limit-1: the task commits span two chunks');
    assert.deepEqual(at(3), expected, 'limit: exactly one chunk');
    assert.deepEqual(at(4), expected, 'limit+1: one chunk with room to spare');
    assert.deepEqual(at(1), expected, 'a chunk of one is clamped to two — it would never shrink the tip reduction');
  });

  test('[boundary] the pathspec cap: 19 and 20 pass through; 21 is refused, not truncated', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const run = (count) => {
      const git = spyGit();
      const specs = Array.from({ length: count }, (_, i) => `src/p${i}/`);
      const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { pathspecs: specs, commitsOnly: true, execGit: git });
      const log = git.calls.find((args) => args[0] === 'log');
      return { scope, sent: log ? log.length - 1 - log.indexOf('--') : null };
    };
    assert.equal(run(19).sent, 19);
    assert.equal(run(20).sent, 20);
    const over = run(21);
    assert.equal(over.scope.status, 'unresolvable');
    assert.equal(over.scope.reason, 'too-many-pathspecs');
    assert.equal(over.sent, null, 'no git log was issued with a truncated pathspec list');
  });

  test('[boundary] maxCommits is clamped at the 1000 ceiling by one helper (git is asked for twice that many)', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const asked = (maxCommits) => {
      const git = spyGit();
      resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { maxCommits, commitsOnly: true, execGit: git });
      const log = git.calls.find((args) => args[0] === 'log');
      return Number(log[log.indexOf('-n') + 1]);
    };
    assert.deepEqual([asked(999), asked(1000), asked(1001), asked(5000), asked(0)], [1998, 2000, 2000, 2000, 2]);
  });
});

describe('resolveEvaluationScope — a hung git is unresolvable on EVERY call path, never "unreachable"', () => {
  test('[negative] a timeout in the ancestor check', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, {
      execGit: spyGit((args) => (args[0] === 'merge-base' ? TIMED_OUT : undefined)),
    });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-timeout');
    assert.deepEqual(scope.unreachable, []);
  });

  test('[negative] a timeout resolving a task commit id', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, {
      execGit: spyGit((args) => (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith(a)) ? TIMED_OUT : undefined)),
    });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-timeout');
    assert.deepEqual(scope.unreachable, []);
  });

  test('[negative] a timeout finding the milestone tag', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, {
      milestoneBound: true,
      execGit: spyGit((args) => (args[0] === 'describe' ? TIMED_OUT : undefined)),
    });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-timeout');
  });

  test('[control] a plain "not an ancestor" is still named unreachable, so the distinction can fail', () => {
    const repo = makeRepo();
    repo.git('checkout', '-b', 'side');
    const side = commit(repo, 'src/side.js', 'feat(03-01): side only');
    repo.git('checkout', 'main');
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a, side]);
    assert.deepEqual(resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }).unreachable, [side]);
  });

  test('[negative] an ambiguous short id is named unreachable, and does not poison the phase', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    const ambiguous = 'abcdef0'; // git answers `rev-parse --verify` with exit 128 for an ambiguous or malformed short id
    const git = spyGit((args) => (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith(ambiguous))
      ? { exitCode: 128, stdout: '', stderr: 'fatal: ambiguous argument', signal: null, error: null, timedOut: false }
      : undefined));
    write(repo.dir, `${PHASE_DIR}/03-02-SUMMARY.md`, `## Task Commits\n\n1. **Task 1: x** - \`${ambiguous}\`\n\n## Next\n`);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, { execGit: git });
    assert.equal(scope.status, 'resolved');
    assert.deepEqual(scope.unreachable, [ambiguous]);
    assert.deepEqual(scope.files, ['src/a.js']);
  });
});

describe('resolveEvaluationScope — what a scope says when it finds little', () => {
  test('[negative] no matching commits is a resolved "none" with a reason, not an unread scope', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(09-09): another plan');
    for (const options of [{}, { commitsOnly: true }]) {
      const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, options);
      assert.equal(scope.status, 'resolved');
      assert.equal(scope.reason, 'no-matching-commits');
      assert.deepEqual(scope.commits, []);
    }
    assert.equal(resolveEvaluationScope(repo.dir, { kind: 'quick', id: 'nope-123' }).reason, 'no-matching-commits');
  });

  test('[negative] commits whose every path is excluded are an empty scope that says so', () => {
    const repo = makeRepo();
    commit(repo, `${PHASE_DIR}/03-01-NOTES.md`, 'docs(03-01): notes only');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.reason, 'empty-after-exclusions');
    assert.equal(scope.commits.length, 1);
    assert.deepEqual(scope.files, []);
  });

  test('[negative] `since` removing every task commit is not "unreachable"', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, { since: a });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'no-task-commits-since');
  });

  test('[boundary] a phase directory that arrived with the root commit still includes the root commit\'s files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-scope-root-'));
    dirs.push(dir);
    const git = (...args) => gitOrThrow(args, { cwd: dir, env: { ...process.env, ...IDENTITY } }).trim();
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'test@test.io');
    git('config', 'user.name', 'Test');
    write(dir, `${PHASE_DIR}/03-CONTEXT.md`, 'context\n');
    write(dir, 'src/root.js', 'root\n');
    git('add', '.');
    git('commit', '-m', 'feat(03-01): everything in the root commit');
    const scope = resolveEvaluationScope(dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.deepEqual(scope.files, ['src/root.js']);
  });
});
