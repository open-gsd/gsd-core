/**
 * Process-contract cases of the state suite (#6334, ADR-6315 item 16).
 *
 * `state_head` is the commit a STATE.md was written against, read from a real
 * git repository, so the subject of these cases is git itself: they build
 * repositories with real git and assert what the library reads back.
 * Everything else about state is tested in-process in tests/state.test.cjs.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cleanup, createTempProject } = require('./helpers.cjs');

// ─── #2573: state_head commit provenance on the write seam ───────────────────

describe('syncStateFrontmatter — state_head commit provenance (#2573)', () => {
  const { runGit } = require('./helpers/process-seam.cjs');
  const { syncStateFrontmatter } = require('../gsd-core/bin/lib/state.cjs');
  const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
  const { createTempGitProject: mkGit } = require('./helpers.cjs');

  const dirs = [];
  const track = (d) => { dirs.push(d); return d; };
  afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

  const MINIMAL_STATE = [
    '---',
    'status: executing',
    '---',
    '',
    '# Session State',
    '',
    'Status: executing',
    '',
  ].join('\n');

  test('stamps state_head with the full HEAD sha of the project repo', () => {
    const dir = track(mkGit('gsd-2573-'));
    const head = runGit(['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();

    const synced = syncStateFrontmatter(MINIMAL_STATE, dir);
    const fm = extractFrontmatter(synced);

    assert.strictEqual(fm.state_head, head,
      'state_head must record the commit STATE.md was written against');
  });

  test('omits state_head entirely when the project is not a git repo (degrade, never throw)', () => {
    // trek-e's approval condition 3: degrade to no-signal rather than throwing
    // when the commit is unresolvable. A non-repo is the canonical case.
    const dir = track(createTempProject('gsd-2573-nogit-'));

    let synced;
    assert.doesNotThrow(() => { synced = syncStateFrontmatter(MINIMAL_STATE, dir); },
      'a non-git project must not throw');
    const fm = extractFrontmatter(synced);

    assert.ok(!('state_head' in fm),
      `state_head must be absent outside a git repo, got ${JSON.stringify(fm.state_head)}`);
  });

  test('drops a PRE-EXISTING state_head when the commit becomes unresolvable (never carried forward)', () => {
    // The omission test above feeds MINIMAL_STATE, which has no pre-existing
    // state_head — so it never reaches the #2202 carry-forward loop, which
    // copies any key absent from derivedFm straight back from the old file.
    // This fixture DOES carry a stamp, so it exercises that branch.
    //
    // state-transition.cts classifies state_head as { preservation: 'derive' }:
    // "Never preserved: a stale stamp would claim STATE.md was written against
    // a commit it wasn't." A carried-forward value contradicts that contract and
    // asserts provenance the file no longer has.
    const STAMPED_STATE = [
      '---',
      'status: executing',
      'state_head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '---',
      '',
      '# Session State',
      '',
      'Status: executing',
      '',
    ].join('\n');

    const dir = track(createTempProject('gsd-2573-stale-stamp-'));

    let synced;
    assert.doesNotThrow(() => { synced = syncStateFrontmatter(STAMPED_STATE, dir); },
      'a non-git project must not throw even with a pre-existing stamp');
    const fm = extractFrontmatter(synced);

    assert.ok(!('state_head' in fm),
      `a stale state_head must be DROPPED, not carried forward, when the commit is unresolvable — got ${JSON.stringify(fm.state_head)}`);
  });

  test('restamps state_head to the new HEAD after a commit (freshness proxy resets on write)', () => {
    // Goodhart guard, asserted rather than assumed: the counter resets as a
    // side effect of ANY state write, so state_head means "written at this
    // commit", never "STATE's content is accurate". Pinning it here so nobody
    // later builds a gate on the derived commit distance.
    const dir = track(mkGit('gsd-2573-restamp-'));
    const first = extractFrontmatter(syncStateFrontmatter(MINIMAL_STATE, dir)).state_head;

    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'change\n');
    runGit(['add', '-A'], { cwd: dir });
    runGit(['commit', '-m', 'unrelated'], { cwd: dir });
    const second = extractFrontmatter(syncStateFrontmatter(MINIMAL_STATE, dir)).state_head;

    const head = runGit(['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();
    assert.notStrictEqual(second, first, 'a new commit must produce a new state_head');
    assert.strictEqual(second, head, 'state_head must track the current HEAD');
  });

  test('carries a body-absent last_activity forward instead of dropping it (#2622 B1)', () => {
    // #2622 B1: the #2202 carry-forward loop skips `source: 'free'` fields
    // (state_head) so an unresolvable stamp is never re-asserted — but it must
    // NOT skip `last_activity` ({source:'body', preservation:'derive'}). When the
    // body carries no "Last activity:" line, buildStateFrontmatter omits the
    // field, and the existing frontmatter value has to survive: dropping it is
    // silent frontmatter data loss and would defeat #2570's staleness signal
    // downstream. A non-git project keeps this on the carry-forward path
    // (state_head is simply absent) and needs no subprocess.
    const STATE_WITH_ACTIVITY = [
      '---',
      'status: executing',
      'last_activity: 2026-01-15',
      '---',
      '',
      '# Session State',
      '',
      'Status: executing',
      '',
    ].join('\n');

    const dir = track(createTempProject('gsd-2622-b1-'));
    const fm = extractFrontmatter(syncStateFrontmatter(STATE_WITH_ACTIVITY, dir));

    assert.strictEqual(fm.last_activity, '2026-01-15',
      'a body-absent last_activity must carry forward, not be dropped by the state_head narrowing');
  });
});


// ─── #2573: property invariants for the state_head fence ─────────────────────
//
// `state_head` is read from disk and then passed to git AS AN ARGUMENT, which
// makes this a parser with a security-relevant fence — the class the repo's
// testing standards require fast-check coverage for. Example-based tests pin
// the shapes we thought of; these pin the invariant for the ones we didn't.

describe('readStateHeadFreshness — property invariants (#2573)', () => {
  const fc = require('./helpers/fast-check-setup.cjs');
  const { runGit } = require('./helpers/process-seam.cjs');
  const { after } = require('node:test');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { cleanup } = require('./helpers.cjs');
  const { readStateHeadFreshness } = require('../gsd-core/bin/lib/state.cjs');

  const propDirs = [];
  after(() => { while (propDirs.length) cleanup(propDirs.pop()); });

  function gitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-prop-'));
    propDirs.push(dir);
    runGit(['init', '-q'], { cwd: dir });
    runGit(['config', 'user.email', 't@t.com'], { cwd: dir });
    runGit(['config', 'user.name', 'T'], { cwd: dir });
    runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    runGit(['add', '-A'], { cwd: dir });
    runGit(['commit', '-q', '-m', 'seed'], { cwd: dir });
    return dir;
  }

const HEX_RE = /^[0-9a-f]{4,40}$/i;

  const repo = gitRepo();

  test('(a) total function — never throws for arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        readStateHeadFreshness(repo, value);
        return true;
      }),
    );
  });

  test('(b) fence — non-hex input never yields a stamp', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = readStateHeadFreshness(repo, s);
        if (HEX_RE.test(s.trim())) return true; // valid shape: out of scope here
        return r.state_head === null && r.commits_behind === null && r.commit_stale === null;
      }),
    );
  });

  test('(c) tri-state integrity — unknown never reads as known-fresh', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = readStateHeadFreshness(repo, s);
        const validTri = r.commit_stale === null || r.commit_stale === true || r.commit_stale === false;
        const unknownIsNull = r.commits_behind === null ? r.commit_stale === null : true;
        const agreement = typeof r.commits_behind === 'number'
          ? r.commit_stale === (r.commits_behind > 0)
          : true;
        return validTri && unknownIsNull && agreement;
      }),
    );
  });

  test('(d) no git-argument injection — dash-led values are rejected by the fence', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('--all', '-n', '--not', '--output=/tmp/pwn', '--help', '-- --all'),
        fc.string(),
        (flag, tail) => {
          const r = readStateHeadFreshness(repo, `${flag}${tail}`);
          return r.state_head === null && r.commits_behind === null && r.commit_stale === null;
        },
      ),
    );
  });

  test('(f) a NON-ANCESTOR stamp resolves to unknown, never to "known fresh"', () => {
    // `rev-list --count A..B` exits 0 with "0" when A is unreachable from B, so
    // reset --hard / rebase / squash / force-push past the stamp used to render
    // as commit_stale:false — "known fresh" for a codebase that was rewound.
    // That collapses the exact unknown-vs-fresh distinction the tri-state exists
    // to preserve, so a non-ancestor stamp must come back null.
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-nonanc-'));
    propDirs.push(d);
    const g = (argv) => runGit(argv, { cwd: d }).stdout;
    g(['init', '-q']); g(['config', 'user.email', 't@t.com']); g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
    const base = g(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(d, 'b.txt'), 'b\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'c1']);
    const tip = g(['rev-parse', 'HEAD']).trim();
    g(['reset', '--hard', '-q', base]);

    const r = readStateHeadFreshness(d, tip);
    assert.strictEqual(r.commits_behind, null, 'a non-ancestor stamp has no meaningful distance');
    assert.strictEqual(r.commit_stale, null, 'unknown must NOT report as false ("known fresh")');
  });

  test('(e) a real HEAD sha always resolves to zero commits behind', () => {
    const head = runGit(['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
    const r = readStateHeadFreshness(repo, head);
    assert.strictEqual(r.commits_behind, 0);
    assert.strictEqual(r.commit_stale, false);
    assert.strictEqual(r.state_head, head.slice(0, 7));
  });

  test('(g) a project whose nearest .git is an ANCESTOR repo resolves to unknown, never "known fresh"', () => {
    // #2573 degrade path D5. `git rev-parse HEAD` walks UP from cwd to the
    // nearest enclosing .git — nothing pins that repo to the project. A GSD
    // project living under an unrelated repo (a dotfiles/notes checkout, or the
    // outer workspace of a planning.sub_repos layout) measures its freshness
    // against a repo it has no relationship to.
    //
    // The stamp below IS that ancestor repo's HEAD, so pre-fix the ancestry
    // check passes, rev-list returns 0, and the tri-state reports
    // commit_stale:false — "known fresh" for a directory that is not in that
    // repo at all. Same invariant violation as (f), reached by another route.
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-ancestor-'));
    propDirs.push(outer);
    const g = (argv) => runGit(argv, { cwd: outer }).stdout;
    g(['init', '-q']); g(['config', 'user.email', 't@t.com']); g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(outer, 'unrelated.txt'), 'x\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'outer']);
    const outerHead = g(['rev-parse', 'HEAD']).trim();

    // The project itself is NOT a git repo — it merely sits inside one.
    const project = path.join(outer, 'nested-project');
    fs.mkdirSync(path.join(project, '.planning'), { recursive: true });

    const r = readStateHeadFreshness(project, outerHead);
    assert.strictEqual(r.commit_stale, null,
      'a stamp resolved against an ancestor repo is UNKNOWN — it must not report false ("known fresh")');
    assert.strictEqual(r.commits_behind, null,
      'distance measured against an unrelated repo is not a meaningful count');
  });

  test('(i) a sub_repos workspace resolves to unknown even though it owns its own repo', () => {
    // #2573 D5, sub_repos flavor. (g) covers the case where the project owns NO
    // .git. This is the harder one: the outer workspace owns BOTH .planning/ and
    // its own repo, so projectOwnsItsRepo passes — yet every code commit lands in
    // a nested child repo and the outer HEAD never advances.
    //
    // Pre-fix that stamps the outer HEAD, --is-ancestor passes trivially,
    // rev-list counts 0, and the tri-state reports commit_stale:false — "known
    // fresh" — no matter how far the children have moved. That is a WRONG answer,
    // not a missing one: the same invariant (g) protects, reached by a third
    // route. docs/CONFIGURATION.md describes sub_repos as scoping work per
    // sub-repo "instead of treating the outer repo as a monorepo", so an outer
    // wrapper that is itself a repo is a supported layout, not a contrived one.
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-subrepos-'));
    propDirs.push(outer);
    const g = (argv) => runGit(argv, { cwd: outer }).stdout;
    g(['init', '-q']); g(['config', 'user.email', 't@t.com']); g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(outer, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(outer, '.planning', 'config.json'),
      JSON.stringify({ planning: { sub_repos: ['frontend'] } }, null, 2),
    );
    fs.writeFileSync(path.join(outer, 'wrapper.txt'), 'x\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'outer']);
    const outerHead = g(['rev-parse', 'HEAD']).trim();

    // A separately tracked child repo — where the real work happens. The outer
    // repo is deliberately NOT advanced past `outerHead` afterwards, which is
    // precisely the topology that makes the stale reading look fresh.
    const child = path.join(outer, 'frontend');
    fs.mkdirSync(child, { recursive: true });
    const gc = (argv) => runGit(argv, { cwd: child }).stdout;
    gc(['init', '-q']); gc(['config', 'user.email', 't@t.com']); gc(['config', 'user.name', 'T']);
    gc(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(child, 'app.js'), 'let a = 1;\n');
    gc(['add', '-A']); gc(['commit', '-q', '-m', 'child']);

    const r = readStateHeadFreshness(outer, outerHead);
    assert.strictEqual(r.commit_stale, null,
      'a sub_repos workspace cannot substantiate a freshness claim from the outer ' +
      'HEAD — it must report unknown, never false ("known fresh")');
    assert.strictEqual(r.commits_behind, null,
      'a distance measured against the wrapper repo is not a meaningful count');
  });

  test('(j) a plain single-repo project is NOT degraded by the sub_repos check', () => {
    // Over-tightening guard for (i), mirroring what (h) does for (g). An empty or
    // absent sub_repos must leave the normal path untouched — a check that
    // degraded every project to unknown would "pass" (i) while destroying the
    // feature, which is the failure mode this pins.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-plain-'));
    propDirs.push(dir);
    const g = (argv) => runGit(argv, { cwd: dir }).stdout;
    g(['init', '-q']); g(['config', 'user.email', 't@t.com']); g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ planning: { sub_repos: [] } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const r = readStateHeadFreshness(dir, head);
    assert.strictEqual(r.commit_stale, false,
      'an empty sub_repos list is a normal single-repo project — it must resolve');
    assert.strictEqual(r.commits_behind, 0);
  });
});
