// This file reads .md product files whose deployed text IS what the runtime loads, so
// testing text content tests the deployed contract. Suppression is SITE-scoped, not
// file-wide (CONTRIBUTING.md: the marker must sit within MAX_MARKER_LOOKAHEAD_LINES = 8
// of the line it covers, with nothing but blanks and comments between) — so the
// `allow-test-rule` markers live next to the two read sites below, not up here.
//
// Those markers are belt-and-braces today, and the reason is NOT that the rule ignores
// `RegExp.test` — it handles `regex.test(tracked)` explicitly (no-source-grep.cjs:239,
// :597-605). It is that neither read is tracked in the first place: `looksLikeSourcePath`
// (:378-390) admits only .cjs/.cts/.js/.mjs/.mts/.ts and UNDO_PATH is a .md, and the
// second site's reader is `readFileNormalized`, which the rule does not recognise as
// `readFileSync`. The markers are correct where they now sit, and become load-bearing if
// either scope widens.

/**
 * #4465 — /gsd:undo commit selection must be milestone-bounded and HEAD-reachable.
 *
 * The defect: `--phase` documented a primary path reading `.planning/.phase-manifest.json`,
 * a file nothing in the repository writes, so the documented fallback was the only real
 * path — `git log --oneline --no-merges --all | grep -E "\(0*${TARGET_PHASE}...` — with no
 * milestone bound and no reachability bound. Feeding that selection to `git revert
 * --no-commit` stages deletion of a previous milestone's files.
 *
 * The fix ports #3995's PHASE_START anchor (already live in code-review.md) to both
 * `--phase` and `--plan`, drops `--all`, and fails closed instead of widening.
 *
 * Two halves. The first pins the SHAPE of undo.md's fences (substring assertions over
 * the deployed prose — each half's own read site carries the marker). The second
 * EXECUTES those fences against a real git fixture and the real `gsd-tools.cjs`, so
 * a fence that matches the expected text but does not do the expected thing still fails.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const UNDO_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'undo.md');

/** Return the raw text of every ```bash fenced block in `content`. */
function extractBashBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  for (const block of scanFencedBlocks(lines)) {
    if (block.closeLineIdx === -1) continue;
    if ((block.infoString || '').trim().toLowerCase() !== 'bash') continue;
    blocks.push(lines.slice(block.openLineIdx, block.closeLineIdx + 1).join('\n'));
  }
  return blocks;
}

describe('#4465: undo commit selection is bounded', () => {
  // allow-test-rule: source-text-is-the-product (see #4465)
  const content = fs.readFileSync(UNDO_PATH, 'utf-8');
  const bash = extractBashBlocks(content).join('\n');

  test('A: no commit-selection git log uses --all', () => {
    // `--all` searches every ref, so a commit unreachable from HEAD can be selected
    // for revert. Every selection block must be HEAD-reachable.
    const offenders = extractBashBlocks(content).filter(
      (b) => /git log/.test(b) && /--all\b/.test(b),
    );
    assert.deepEqual(
      offenders, [],
      `undo.md must not select commits with 'git log ... --all' (#4465). Offending block(s):\n${offenders.join('\n---\n')}`,
    );
  });

  test('B: the dead .phase-manifest.json path is gone', () => {
    // Nothing in the repository writes this file, so the documented primary path was
    // permanently unreachable and the unbounded fallback was the only real path.
    assert.ok(
      !/phase-manifest/.test(content),
      'undo.md must not read or assert .planning/.phase-manifest.json — nothing writes it (#4465)',
    );
  });

  test('C: both modes anchor on the phase directory via PHASE_START', () => {
    assert.ok(
      /PHASE_START=\$\(git log --format="%H" --diff-filter=A -- "\$\{PHASE_DIR\}"/.test(bash),
      'undo.md must derive PHASE_START from the phase directory (the #3995 anchor)',
    );
    // Two derivations: one for MODE=phase, one for MODE=plan.
    const anchors = (bash.match(/--diff-filter=A -- "\$\{PHASE_DIR\}"/g) || []).length;
    assert.equal(anchors, 2, 'both --phase and --plan must anchor on PHASE_DIR (#4465)');
  });

  test('D: PHASE_DIR is resolved through find-phase, so it is workstream-correct', () => {
    // find-phase resolves through planningDir, which roots an active workstream at
    // .planning/workstreams/<ws>/ — a hardcoded .planning/phases/ would read the
    // root's same-numbered phase instead.
    const uses = (bash.match(/gsd_run query find-phase/g) || []).length;
    assert.equal(uses, 2, 'both modes must resolve PHASE_DIR via find-phase (#4465)');
  });

  test('E: the selection window is bounded above by HEAD', () => {
    assert.ok(
      /UNDO_RANGE="\$\{PHASE_START\}\^\.\.HEAD"/.test(bash),
      'the selection range must be bounded at HEAD (#4465)',
    );
  });

  test('J: the root-commit branch does not drop PHASE_START itself', () => {
    // `${PHASE_START}..HEAD` EXCLUDES PHASE_START. When PHASE_START is the root commit
    // there is no parent to exclude, so that spelling silently drops a legitimate first
    // phase commit and the undo refuses work it should do.
    assert.ok(
      !/UNDO_RANGE="\$\{PHASE_START\}\.\.HEAD"/.test(bash),
      'the root-commit branch must not use ${PHASE_START}..HEAD — it drops the root commit (#4465)',
    );
    assert.ok(
      /UNDO_RANGE="HEAD"/.test(bash),
      'the root-commit branch must select over HEAD so PHASE_START itself stays in range (#4465)',
    );
  });

  test('K: selection pipelines tolerate an empty match', () => {
    // grep exits 1 on no match. The removed `| head -50` used to mask that rc, so the
    // pipelines must not now abort before the workflow's own Empty check runs.
    const selectionBlocks = extractBashBlocks(content).filter(
      (b) => /git log --oneline --no-merges "\$\{UNDO_RANGE\}"/.test(b),
    );
    assert.equal(selectionBlocks.length, 2, 'expected one bounded selection pipeline per mode');
    for (const block of selectionBlocks) {
      assert.ok(
        /\|\| true/.test(block),
        `every selection pipeline must tolerate grep's no-match exit (#4465). Block:\n${block}`,
      );
    }
  });

  test('L: both modes stop rather than silently capping a >50 selection', () => {
    const stops = (content.match(/Report truncation, never truncate silently/g) || []).length;
    assert.equal(stops, 2, 'both --phase and --plan must document the >50 stop (#4465)');
    // The heading alone is not the rule: pin the refusal each mode instructs the runtime to
    // render, so removing the paragraph under an intact heading still fails here.
    const refusals = [...content.matchAll(/selects \$\{N\} commits \(>50\)\. Refusing to revert a partial (phase|plan)\./g)]
      .map((m) => m[1]);
    assert.deepEqual(refusals, ['phase', 'plan'],
      'both modes must carry the >50 refusal message, phase then plan (#4465)');
    // Executable lines only: the fix's own comment explains what `| head -50` used to mask,
    // and a comment naming the removed cap is not the cap.
    const code = bash
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    assert.ok(
      !/\| head -50/.test(code),
      'no selection pipeline may silently cap at 50 (#4465)',
    );
  });

  test('F: selection greps run against the bounded range, not the whole repo', () => {
    const selectionBlocks = extractBashBlocks(content).filter((b) => /grep -E/.test(b));
    assert.ok(selectionBlocks.length >= 2, 'expected a selection grep for each of --phase and --plan');
    for (const block of selectionBlocks) {
      assert.ok(
        /\$\{UNDO_RANGE\}/.test(block),
        `every commit-selection grep must run over \${UNDO_RANGE} (#4465). Block:\n${block}`,
      );
    }
  });

  test('G: the workflow fails closed rather than widening when no anchor resolves', () => {
    assert.ok(
      /do NOT fall back to an unbounded search/i.test(content),
      'undo.md must state that an unresolved phase does not widen the search (#4465)',
    );
    assert.ok(
      /An unbounded repository-wide search is never the fallback/i.test(content),
      'undo.md must state the fail-closed rule for an unresolvable anchor (#4465)',
    );
  });

  test('H: dependency_check reads the workstream-resolved planning root', () => {
    assert.ok(
      /PLANNING_DIR=\$\(gsd_run query planning inspect --pick generated_from\.planning_root/.test(bash),
      'dependency_check must resolve the planning root rather than hardcoding .planning/ (#4465)',
    );
    assert.ok(
      !/`\.planning\/ROADMAP\.md`/.test(content),
      'dependency_check must not read a hardcoded .planning/ROADMAP.md — wrong file under a workstream (#4465)',
    );
    assert.ok(
      !/\.planning\/phases\/\$\{/.test(content),
      'dependency_check must not glob a hardcoded .planning/phases/ — wrong tree under a workstream (#4465)',
    );
  });

  test('I: the revert verb is still git revert --no-commit, never git reset --hard', () => {
    // Guard the property the original workflow got right, so this fix cannot regress it.
    assert.ok(/git revert --no-commit/.test(bash), 'undo.md must still use git revert --no-commit');
    // Scoped to bash blocks: the success-criteria checklist legitimately contains the
    // prose "git reset --hard is NEVER used anywhere in this workflow".
    assert.ok(
      !/git reset --hard/.test(bash),
      'undo.md must never execute git reset --hard',
    );
  });

  test('M: both modes refuse a PHASE_DIR that resolves under milestones/', () => {
    // find-phase falls back to archived milestone dirs, and its ambiguity check does
    // not span them; anchoring there selects a LATER milestone's same-numbered phase.
    // Two guards, one per mode — a single one would leave the other selecting.
    const guards = extractBashBlocks(content).filter(
      (b) => /PHASE_DIR_ARCHIVED=""/.test(b)
        && /\*\/milestones\/v\[0-9\]\*-phases\/\*\|milestones\/v\[0-9\]\*-phases\/\*/.test(b),
    );
    assert.equal(guards.length, 2,
      `undo.md must refuse an archived resolution in BOTH modes; found ${guards.length} guard(s)`);
    // The same fence carries the reused-path collision check: an archived twin of a LIVE
    // directory name means the anchor belongs to the earlier occupant.
    for (const g of guards) {
      const code = g.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      assert.ok(/PHASE_DIR_REUSED=""/.test(code) && /milestones\/v\[0-9\]\*-phases\//.test(code),
        `each guard fence must also refuse a reused directory name (#4465):\n${code}`);
      assert.ok(/\[ -d "\$_arch" \]/.test(code),
        `the collision check must require a DIRECTORY, not any entry (#4465):\n${code}`);
    }
    // The pattern must key on the ARCHIVE LAYOUT. A bare `*/milestones/*` also matches a
    // workstream or project legitimately named `milestones` and refuses a LIVE phase.
    // Executable lines only: the guard's own comment quotes the rejected pattern to
    // explain why it is rejected, and a whole-block match would fire on that.
    for (const g of guards) {
      const code = g.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      assert.ok(!/\*\/milestones\/\*/.test(code),
        `the guard must not match the bare token 'milestones' — it refuses live phases:\n${code}`);
    }
    for (const g of guards) {
      assert.ok(/PHASE_DIR=""/.test(g),
        `the archived guard must blank PHASE_DIR so the fail-closed rule still holds:\n${g}`);
    }
  });

  test('N: the purpose line no longer advertises the removed phase manifest', () => {
    // B already reads the WHOLE file, so scope is not why it missed this: it greps the
    // hyphenated `phase-manifest` token — the filename — while the purpose line described
    // the same dead mechanism in prose, as "the phase manifest". Pinning the block itself
    // is spelling-independent, where widening B's pattern to /manifest/i would fire on any
    // future sentence that merely mentions one.
    // Sliced, not regex-matched: an unbounded `[\s\S]*?` over readFileSync content is a
    // catastrophic-backtracking risk and `local/no-unbounded-quantifier` rejects it.
    const open = content.indexOf('<purpose>');
    const close = content.indexOf('</purpose>', open + 1);
    assert.ok(open !== -1 && close !== -1, 'undo.md must carry a <purpose> block');
    const purpose = content.slice(open, close);
    assert.ok(!/manifest/i.test(purpose),
      `<purpose> must not describe the removed manifest mechanism; got:\n${purpose}`);
  });
});

// ─── Behavioral half (review round 1, #4472) ──────────────────────────────────
//
// The block above pins the SHAPE of undo.md's selection fences. This block
// EXECUTES them: the exact ```bash fences the runtime runs are sliced out of
// undo.md by content anchor, glued behind the inputs the workflow would have
// set, and run with `bash -c` inside a real git fixture against the real
// `gsd-tools.cjs` — the same createTempGitProject + fence-execution shape
// new-milestone-clear-phases.test.cjs (#2308) and
// code-review-pipeline-regression.test.cjs (#2352) use. A substring match cannot
// tell a live invocation from a dead one; a run can.
//
// win32: skipped, as the #2352 fence-execution tests are. The fences are POSIX
// bash and the fixture is driven through `bash -c`; Windows shards exercise the
// shape tests above.

const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { gitOrThrow, throwIfFailed } = require('./helpers/git-fixture.cjs');
const { createTempGitProject, cleanup, readFileNormalized } = require('./helpers.cjs');
const { createFixture, seedPhase, seedWorkstream } = require('./fixtures/index.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const GSD_TOOLS_BIN = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const SKIP_WIN32 = process.platform === 'win32'
  ? 'POSIX bash fence execution over a git fixture (see #2352 precedent)'
  : false;

/** Fence BODIES (no ``` lines), from a \r\n-normalized read so bash never sees a CR. */
function fenceBodies(content) {
  const lines = content.split('\n');
  const bodies = [];
  for (const block of scanFencedBlocks(lines)) {
    if (block.closeLineIdx === -1) continue;
    if ((block.infoString || '').trim().toLowerCase() !== 'bash') continue;
    bodies.push(lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n'));
  }
  return bodies;
}

/** The one fence whose body satisfies `pred` — located by content, never by position. */
function fenceWhere(bodies, label, pred) {
  const hits = bodies.filter(pred);
  assert.equal(hits.length, 1, `expected exactly one ${label} fence in undo.md, found ${hits.length}`);
  return hits[0];
}

describe('#4465: undo commit selection — executed against a git fixture', { skip: SKIP_WIN32 }, () => {
  // allow-test-rule: source-text-is-the-product (see #4465)
  const content = readFileNormalized(UNDO_PATH);
  const bodies = fenceBodies(content);

  // gather_commits, MODE=phase: resolve → anchor → select
  const phaseResolve = fenceWhere(bodies, 'phase resolve',
    (b) => b.includes('PHASE_DIR=$(gsd_run query find-phase "${TARGET_PHASE}"'));
  const phaseArchivedGuard = fenceWhere(bodies, 'phase archived guard',
    (b) => b.includes('PHASE_DIR_ARCHIVED=""') && !b.includes('PLAN_PHASE'));
  const phaseAnchor = fenceWhere(bodies, 'phase anchor',
    (b) => b.includes('PHASE_START=$(git log') && !b.includes('PLAN_PHASE'));
  const phaseSelect = fenceWhere(bodies, 'phase select',
    (b) => b.includes('grep -E "\\(0*${TARGET_PHASE}'));
  // gather_commits, MODE=plan: resolve+anchor → select
  const planAnchor = fenceWhere(bodies, 'plan resolve+anchor',
    (b) => b.includes('PLAN_PHASE="${TARGET_PLAN%%-*}"'));
  const planSelect = fenceWhere(bodies, 'plan select',
    (b) => b.includes('grep -E "\\(${TARGET_PLAN}\\):"'));
  // dependency_check: planning-root resolution
  const planningRoot = fenceWhere(bodies, 'planning root',
    (b) => b.includes('PLANNING_DIR=$(gsd_run query planning inspect'));

  // The composed script replays the fences in order in ONE shell, seeded with
  // what the workflow sets (TARGET_*), plus the real gsd_run over the real
  // binary. That is deliberately the workflow's own data flow — `PHASE_DIR`,
  // `PHASE_START`, `UNDO_RANGE` are carried from fence to fence by the runtime
  // that executes undo.md — and it is what these tests prove: the selection
  // logic, not the runtime's variable transport between blocks.
  const GSD_RUN = 'gsd_run() { node "$GSD_TOOLS_BIN" "$@"; }';

  function runFences(cwd, seed, fences, tail = '') {
    const script = [seed, GSD_RUN, ...fences, tail].join('\n');
    const env = { ...process.env, GSD_TOOLS_BIN, HOME: cwd };
    // A developer's active workstream must not leak into the fixture.
    delete env.GSD_WORKSTREAM;
    delete env.GSD_PROJECT;
    const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd, env, timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(r, 'bash <undo.md fences>');
    return r.stdout;
  }

  /** `git log --oneline` output → the subject lines, in order. */
  function subjects(oneline) {
    return oneline.split('\n').filter(Boolean).map((l) => l.replace(/^[0-9a-f]+ /, ''));
  }

  function commitFile(cwd, rel, body, message) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), body);
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', message], { cwd });
  }

  // The reported repro (#4465): milestone 1 ships phase 03 and is archived;
  // milestone 2 reuses the number. A dead branch carries a matching scope too.
  function multiMilestoneFixture() {
    const cwd = createTempGitProject('gsd-4465-mm-');
    const mainBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).trim();
    seedPhase(cwd, '03-auth', { '03-01-PLAN.md': '# auth\n' });
    commitFile(cwd, 'src/auth.js', 'auth\n', 'feat(03-01): implement auth endpoint');
    commitFile(cwd, 'src/ratelimit.js', 'rl\n', 'feat(03-02): add rate limiter');
    fs.mkdirSync(path.join(cwd, '.planning', 'milestones', 'v1.0-phases'), { recursive: true });
    gitOrThrow(['mv', '.planning/phases/03-auth', '.planning/milestones/v1.0-phases/03-auth'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'chore: archive v1.0 milestone files'], { cwd });
    gitOrThrow(['checkout', '-q', '-b', 'abandoned/x'], { cwd });
    commitFile(cwd, 'src/experiment.js', 'x\n', 'feat(03-02): abandoned experiment');
    gitOrThrow(['checkout', '-q', mainBranch], { cwd });
    seedPhase(cwd, '03-beta', { '03-01-PLAN.md': '# beta\n' });
    commitFile(cwd, 'src/beta.js', 'beta\n', 'feat(03-01): add beta feature flag');
    return cwd;
  }

  test('fixture reproduces #4465: the retired --all grep selected the archived milestone and a dead branch', (t) => {
    const cwd = multiMilestoneFixture();
    t.after(() => cleanup(cwd));
    // Negative control for the fixture itself: the pre-fix selection line, verbatim
    // from undo.md@b5b9814f0, over this fixture. If it did NOT over-select here, the
    // passing tests below would be vacuous.
    const old = runFences(cwd, 'TARGET_PHASE=03', [],
      'git log --oneline --no-merges --all | grep -E "\\(0*${TARGET_PHASE}(-[0-9]+)?\\):" | head -50');
    assert.deepEqual(subjects(old).sort(), [
      'feat(03-01): add beta feature flag',
      'feat(03-01): implement auth endpoint',
      'feat(03-02): abandoned experiment',
      'feat(03-02): add rate limiter',
    ]);
  });

  test('--phase selects only the current milestone\'s HEAD-reachable commits', (t) => {
    const cwd = multiMilestoneFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PHASE=03', [phaseResolve, phaseAnchor, phaseSelect]);
    assert.deepEqual(subjects(out), ['feat(03-01): add beta feature flag']);
  });

  test('--plan selects only the current milestone\'s instance of a reused plan id', (t) => {
    const cwd = multiMilestoneFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PLAN=03-01', [planAnchor, planSelect]);
    assert.deepEqual(subjects(out), ['feat(03-01): add beta feature flag']);
  });

  // Round 2: find-phase's ambiguity check is scoped to ONE searchDir (the
  // `matches.length > 1` test sits inside cmdFindPhase's per-directory loop), and the
  // live `phases/` dir is searched first. So a phase number that is NOT live resolves
  // silently to the OLDEST archived milestone carrying one. Two archived milestones is
  // the reported scenario; the current milestone has not reached phase 03 yet.
  function twoArchivedMilestonesFixture() {
    const cwd = createTempGitProject('gsd-4465-arch-');
    seedPhase(cwd, '03-auth', { '03-01-PLAN.md': '# auth\n' });
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'docs(03-01): v1.0 phase plan'], { cwd });
    commitFile(cwd, 'src/auth.js', 'auth\n', 'feat(03-01): implement auth endpoint');
    fs.mkdirSync(path.join(cwd, '.planning', 'milestones', 'v1.0-phases'), { recursive: true });
    gitOrThrow(['mv', '.planning/phases/03-auth', '.planning/milestones/v1.0-phases/03-auth'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'chore: archive v1.0 milestone files'], { cwd });
    seedPhase(cwd, '03-search', { '03-01-PLAN.md': '# search\n' });
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'docs(03-01): v2.0 phase plan'], { cwd });
    commitFile(cwd, 'src/search.js', 's\n', 'feat(03-01): add search index');
    fs.mkdirSync(path.join(cwd, '.planning', 'milestones', 'v2.0-phases'), { recursive: true });
    gitOrThrow(['mv', '.planning/phases/03-search', '.planning/milestones/v2.0-phases/03-search'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'chore: archive v2.0 milestone files'], { cwd });
    // v3.0 in progress; phase 03 does not exist live, which is what sends find-phase
    // into the archives at all.
    seedPhase(cwd, '01-setup', { '01-01-PLAN.md': '# setup\n' });
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'docs(01-01): v3.0 phase plan'], { cwd });
    return cwd;
  }

  test('negative control: WITHOUT the archived guard, an archived resolution selects the WRONG milestone', (t) => {
    const cwd = twoArchivedMilestonesFixture();
    t.after(() => cleanup(cwd));
    // Anchor + select with the guard fence omitted — i.e. this PR's round-1 state.
    // find-phase returns v1.0's dir, PHASE_START is the v1.0 ARCHIVAL commit, and the
    // window then runs forward into v2.0 and matches its same-numbered phase, while
    // v1.0's own work commit sits before the window. Both halves are asserted, because
    // "reverts too little" and "reverts someone else's milestone" are different bugs
    // and only the second is destructive.
    const out = runFences(cwd, 'TARGET_PHASE=03', [phaseResolve, phaseAnchor, phaseSelect],
      'echo "PHASE_DIR=${PHASE_DIR}"');
    assert.ok(out.includes('PHASE_DIR=.planning/milestones/v1.0-phases/03-auth'),
      `expected the OLDEST archived dir to win; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/PHASE_DIR=.*\n?/, '')),
      ['feat(03-01): add search index', 'docs(03-01): v2.0 phase plan'],
      'the unguarded window must select v2.0\'s phase 03 and none of v1.0\'s');
  });

  test('--phase REFUSES an archived resolution: no anchor, no range, nothing selected', (t) => {
    const cwd = twoArchivedMilestonesFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PHASE=03',
      [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect],
      'printf "ARCHIVED=[%s]\\nPHASE_DIR=[%s]\\nUNDO_RANGE=[%s]\\n" "$PHASE_DIR_ARCHIVED" "$PHASE_DIR" "$UNDO_RANGE"');
    assert.ok(out.includes('ARCHIVED=[.planning/milestones/v1.0-phases/03-auth]'),
      `the refusal must name the archived directory it declined; got:\n${out}`);
    assert.ok(out.includes('PHASE_DIR=[]'), `PHASE_DIR must be blanked; got:\n${out}`);
    assert.ok(out.includes('UNDO_RANGE=[]'), `UNDO_RANGE must stay empty; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/(ARCHIVED|PHASE_DIR|UNDO_RANGE)=.*\n?/g, '')), [],
      'nothing may be selected once the resolution is refused');
  });

  test('--plan REFUSES an archived resolution too', (t) => {
    const cwd = twoArchivedMilestonesFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PLAN=03-01', [planAnchor, planSelect],
      'printf "ARCHIVED=[%s]\\nUNDO_RANGE=[%s]\\n" "$PHASE_DIR_ARCHIVED" "$UNDO_RANGE"');
    assert.ok(out.includes('ARCHIVED=[.planning/milestones/v1.0-phases/03-auth]'),
      `--plan must refuse the same resolution; got:\n${out}`);
    assert.ok(out.includes('UNDO_RANGE=[]'), `UNDO_RANGE must stay empty; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/(ARCHIVED|UNDO_RANGE)=.*\n?/g, '')), [],
      'nothing may be selected once the resolution is refused');
  });

  test('the archived guard is inert on a LIVE resolution — it refuses archives, not phases', (t) => {
    const cwd = multiMilestoneFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PHASE=03',
      [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect],
      'echo "ARCHIVED=[${PHASE_DIR_ARCHIVED}]"');
    assert.ok(out.includes('ARCHIVED=[]'), `a live phase dir must not trip the guard; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/ARCHIVED=.*\n?/, '')), ['feat(03-01): add beta feature flag']);
  });

  // Round 2, self-found: a LIVE path can still be a previous occupant's. A later milestone
  // that re-creates the same literal directory (same number AND same slug) anchors on the
  // older milestone's add commit. The archive guard cannot see it -- find-phase returns the
  // live directory -- so the collision check keys on the archived twin instead.
  function reusedSlugFixture() {
    const cwd = createTempGitProject('gsd-4465-slug-');
    seedPhase(cwd, '03-auth', { '03-01-PLAN.md': '# v1\n' });
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'docs(03-01): v1 plan'], { cwd });
    commitFile(cwd, 'src/a.js', 'a\n', 'feat(03-01): v1 auth work');
    fs.mkdirSync(path.join(cwd, '.planning', 'milestones', 'v1.0-phases'), { recursive: true });
    gitOrThrow(['mv', '.planning/phases/03-auth', '.planning/milestones/v1.0-phases/03-auth'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'chore: archive v1.0'], { cwd });
    // v2.0 re-creates the SAME literal path.
    seedPhase(cwd, '03-auth', { '03-01-PLAN.md': '# v2\n' });
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'docs(03-01): v2 plan'], { cwd });
    commitFile(cwd, 'src/b.js', 'b\n', 'feat(03-01): v2 auth work');
    return cwd;
  }

  test('negative control: WITHOUT the collision guard, a reused slug selects the EARLIER milestone too', (t) => {
    const cwd = reusedSlugFixture();
    t.after(() => cleanup(cwd));
    // Resolve + anchor + select with the guard fence omitted. find-phase returns the LIVE
    // path, so the archive guard is inert here by construction -- this is the case it misses.
    const out = runFences(cwd, 'TARGET_PHASE=03', [phaseResolve, phaseAnchor, phaseSelect],
      'echo "PHASE_DIR=${PHASE_DIR}"');
    assert.ok(out.includes('PHASE_DIR=.planning/phases/03-auth'),
      `the LIVE path must win -- this is why the archive guard cannot reach it; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/PHASE_DIR=.*\n?/, '')), [
      'feat(03-01): v2 auth work',
      'docs(03-01): v2 plan',
      'feat(03-01): v1 auth work',
      'docs(03-01): v1 plan',
    ], 'the unguarded window must reach back into v1.0');
  });

  test('--phase REFUSES a reused directory name: no anchor, no range, nothing selected', (t) => {
    const cwd = reusedSlugFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PHASE=03',
      [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect],
      'printf "REUSED=[%s]\\nPHASE_DIR=[%s]\\nUNDO_RANGE=[%s]\\n" "$PHASE_DIR_REUSED" "$PHASE_DIR" "$UNDO_RANGE"');
    assert.ok(out.includes('REUSED=[.planning/milestones/v1.0-phases/03-auth]'),
      `the refusal must name the archived twin it collided with; got:\n${out}`);
    assert.ok(out.includes('UNDO_RANGE=[]'), `UNDO_RANGE must stay empty; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/(REUSED|PHASE_DIR|UNDO_RANGE)=.*\n?/g, '')), [],
      'nothing may be selected once the reused path is refused');
  });

  test('--plan REFUSES a reused directory name too', (t) => {
    const cwd = reusedSlugFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PLAN=03-01', [planAnchor, planSelect],
      'printf "REUSED=[%s]\\nUNDO_RANGE=[%s]\\n" "$PHASE_DIR_REUSED" "$UNDO_RANGE"');
    assert.ok(out.includes('REUSED=[.planning/milestones/v1.0-phases/03-auth]'),
      `--plan must refuse the same collision; got:\n${out}`);
    assert.ok(out.includes('UNDO_RANGE=[]'), `UNDO_RANGE must stay empty; got:\n${out}`);
  });

  test('the collision guard is inert when no archived twin exists', (t) => {
    const cwd = multiMilestoneFixture();
    t.after(() => cleanup(cwd));
    // 03-beta is live and 03-auth is archived -- different slugs, so no collision.
    const out = runFences(cwd, 'TARGET_PHASE=03',
      [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect],
      'echo "REUSED=[${PHASE_DIR_REUSED}]"');
    assert.ok(out.includes('REUSED=[]'), `a distinct slug must not collide; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/REUSED=.*\n?/, '')), ['feat(03-01): add beta feature flag']);
  });

  test('the collision guard needs a real archived DIRECTORY, not merely an entry', (t) => {
    // `-e` would accept a stray regular file and block a legitimate undo. The evidence the
    // refusal claims is "this path was used by an earlier milestone", and only a directory
    // is that. Round-2 audit finding.
    const cwd = createTempGitProject('gsd-4465-file-twin-');
    t.after(() => cleanup(cwd));
    seedPhase(cwd, '06-live', { '06-01-PLAN.md': '# live\n' });
    fs.mkdirSync(path.join(cwd, '.planning', 'milestones', 'v1.0-phases'), { recursive: true });
    // A FILE where an archived phase directory would sit.
    fs.writeFileSync(path.join(cwd, '.planning', 'milestones', 'v1.0-phases', '06-live'), 'not a dir\n');
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'docs(06-01): live plan'], { cwd });
    commitFile(cwd, 'src/f.js', 'f\n', 'feat(06-01): live work');
    const out = runFences(cwd, 'TARGET_PHASE=06',
      [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect],
      'echo "REUSED=[${PHASE_DIR_REUSED}]"');
    assert.ok(out.includes('REUSED=[]'), `a regular file is not an archived phase dir; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/REUSED=.*\n?/, '')), [
      'feat(06-01): live work',
      'docs(06-01): live plan',
    ], 'the undo must still work');
  });

  test('the collision guard mirrors the resolver: a malformed milestone dir does not refuse', (t) => {
    // cmdFindPhase only admits /^v\d+.*-phases$/, so `vnondigit-phases` is not a milestone
    // it would ever resolve. A broader glob here refuses over evidence the producer rejects.
    const cwd = createTempGitProject('gsd-4465-malformed-');
    t.after(() => cleanup(cwd));
    seedPhase(cwd, '05-live', { '05-01-PLAN.md': '# live\n' });
    fs.mkdirSync(path.join(cwd, '.planning', 'milestones', 'vnondigit-phases', '05-live'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'milestones', 'vnondigit-phases', '05-live', 'x.md'), 'x\n');
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'docs(05-01): live plan'], { cwd });
    commitFile(cwd, 'src/m.js', 'm\n', 'feat(05-01): live work');
    const out = runFences(cwd, 'TARGET_PHASE=05',
      [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect],
      'echo "REUSED=[${PHASE_DIR_REUSED}]"');
    assert.ok(out.includes('REUSED=[]'),
      `vnondigit-phases is not a milestone cmdFindPhase resolves; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/REUSED=.*\n?/, '')), [
      'feat(05-01): live work',
      'docs(05-01): live plan',
    ]);
  });

  test('the reused-path refusal can still name the live path it declined', (t) => {
    // The fence blanks PHASE_DIR, so the message must read the preserved copy — otherwise it
    // renders "resolves to , but ...". Round-2 audit finding.
    const cwd = reusedSlugFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PHASE=03',
      [phaseResolve, phaseArchivedGuard],
      'printf "LIVE=[%s]\\nPHASE_DIR=[%s]\\n" "$PHASE_DIR_LIVE" "$PHASE_DIR"');
    assert.ok(out.includes('LIVE=[.planning/phases/03-auth]'),
      `the declined live path must survive for the message; got:\n${out}`);
    assert.ok(out.includes('PHASE_DIR=[]'), `PHASE_DIR must still be blanked; got:\n${out}`);
  });

  test('the guard keys on the archive LAYOUT: a workstream named "milestones" is still live', (t) => {
    // The conventional live path above cannot catch this. `milestones` is a legal
    // workstream (and project) name, so a bare `*/milestones/*` pattern classifies
    // .planning/workstreams/milestones/phases/NN-x as archived and refuses a phase that
    // is live and revertible — a fail-closed bug, but a bug. Only `v*-phases`, the shape
    // cmdFindPhase actually creates (/^v\d+.*-phases$/), separates the two.
    const cwd = createTempGitProject('gsd-4465-wsname-');
    t.after(() => cleanup(cwd));
    const dir = path.join(cwd, '.planning', 'workstreams', 'milestones', 'phases', '03-live');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '03-01-PLAN.md'), '# live\n');
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'docs(03-01): workstream phase plan'], { cwd });
    commitFile(cwd, 'src/live.js', 'l\n', 'feat(03-01): workstream work');
    // Activate by env, the same route find-phase honours for an active workstream.
    const script = [
      'TARGET_PHASE=03', GSD_RUN, phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect,
      'echo "ARCHIVED=[${PHASE_DIR_ARCHIVED}]"',
    ].join('\n');
    const env = { ...process.env, GSD_TOOLS_BIN, HOME: cwd, GSD_WORKSTREAM: 'milestones' };
    delete env.GSD_PROJECT;
    const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd, env, timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(r, 'bash <undo.md fences>');
    assert.ok(r.stdout.includes('ARCHIVED=[]'),
      `a workstream NAMED "milestones" is a live scope, not an archive; got:\n${r.stdout}`);
    assert.deepEqual(subjects(r.stdout.replace(/ARCHIVED=.*\n?/, '')), [
      'feat(03-01): workstream work',
      'docs(03-01): workstream phase plan',
    ]);
  });

  test('single-milestone selection is unchanged: every phase commit, none from a later phase', (t) => {
    const cwd = createTempGitProject('gsd-4465-single-');
    t.after(() => cleanup(cwd));
    seedPhase(cwd, '03-auth', { '03-01-PLAN.md': '# auth\n' });
    commitFile(cwd, 'src/a.js', 'a\n', 'feat(03-01): implement auth endpoint');
    commitFile(cwd, 'src/b.js', 'b\n', 'feat(03-02): add rate limiter');
    commitFile(cwd, 'src/c.js', 'c\n', 'fix(03-02): correct limiter window');
    commitFile(cwd, 'src/d.js', 'd\n', 'docs(03): phase summary');
    seedPhase(cwd, '04-search', { '04-01-PLAN.md': '# search\n' });
    commitFile(cwd, 'src/e.js', 'e\n', 'feat(04-01): add search index');
    const out = runFences(cwd, 'TARGET_PHASE=03', [phaseResolve, phaseAnchor, phaseSelect]);
    assert.deepEqual(subjects(out), [
      'docs(03): phase summary',
      'fix(03-02): correct limiter window',
      'feat(03-02): add rate limiter',
      'feat(03-01): implement auth endpoint',
    ]);
  });

  test('limit-1: a matching commit one before PHASE_START is excluded; PHASE_START itself is included', (t) => {
    const cwd = createTempGitProject('gsd-4465-limit-');
    t.after(() => cleanup(cwd));
    // Matching scope, committed BEFORE the phase directory exists: outside the window.
    commitFile(cwd, 'src/pre.js', 'pre\n', 'feat(03-01): stray pre-phase commit');
    // PHASE_START: the commit that adds the phase directory, and it matches the scope.
    seedPhase(cwd, '03-auth', { '03-01-PLAN.md': '# auth\n' });
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'docs(03-01): add phase plan'], { cwd });
    commitFile(cwd, 'src/a.js', 'a\n', 'feat(03-01): implement auth endpoint');
    const out = runFences(cwd, 'TARGET_PHASE=03', [phaseResolve, phaseAnchor, phaseSelect]);
    assert.deepEqual(subjects(out), [
      'feat(03-01): implement auth endpoint',
      'docs(03-01): add phase plan',
    ]);
  });

  test('root commit: a phase whose first commit is the repository root is fully selected', (t) => {
    // createTempGitProject seeds an initial commit, so build the root by hand.
    const cwd = createFixture({ prefix: 'gsd-4465-root-', planning: true, git: false });
    t.after(() => cleanup(cwd));
    const g = (args) => gitOrThrow(args, { cwd });
    g(['init', '-q']);
    g(['config', 'user.email', 'test@test.com']);
    g(['config', 'user.name', 'Test']);
    g(['config', 'commit.gpgsign', 'false']);
    seedPhase(cwd, '01-seed', { '01-01-PLAN.md': '# seed\n' });
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'docs(01-01): add root phase plan']);
    commitFile(cwd, 'src/a.js', 'a\n', 'feat(01-01): first feature');
    const out = runFences(cwd, 'TARGET_PHASE=01', [phaseResolve, phaseAnchor, phaseSelect],
      'echo "UNDO_RANGE=${UNDO_RANGE}"');
    assert.ok(out.includes('UNDO_RANGE=HEAD'), `root branch must select over HEAD; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/UNDO_RANGE=.*\n?/, '')), [
      'feat(01-01): first feature',
      'docs(01-01): add root phase plan',
    ]);
  });

  test('fail-closed: an unknown phase resolves no anchor and no range — nothing widens', (t) => {
    const cwd = multiMilestoneFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PHASE=07', [phaseResolve, phaseAnchor],
      'printf "PHASE_DIR=[%s]\\nUNDO_RANGE=[%s]\\n" "$PHASE_DIR" "$UNDO_RANGE"');
    assert.ok(out.includes('PHASE_DIR=[]'), `expected an empty PHASE_DIR for an absent phase; got:\n${out}`);
    assert.ok(out.includes('UNDO_RANGE=[]'), `expected an empty UNDO_RANGE for an absent phase; got:\n${out}`);
  });

  test('fail-closed (--plan): an unknown plan\'s phase resolves no anchor and no range', (t) => {
    const cwd = multiMilestoneFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PLAN=07-01', [planAnchor],
      'printf "PHASE_DIR=[%s]\\nUNDO_RANGE=[%s]\\n" "$PHASE_DIR" "$UNDO_RANGE"');
    assert.ok(out.includes('PHASE_DIR=[]'), `expected an empty PHASE_DIR for an absent plan phase; got:\n${out}`);
    assert.ok(out.includes('UNDO_RANGE=[]'), `expected an empty UNDO_RANGE for an absent plan phase; got:\n${out}`);
  });

  test('workstream: --phase resolves the ACTIVE workstream\'s phase directory, not the root\'s', (t) => {
    const cwd = createTempGitProject('gsd-4465-ws-');
    t.after(() => cleanup(cwd));
    // Root scope: phase 03 exists and has a matching commit.
    seedPhase(cwd, '03-root', { '03-01-PLAN.md': '# root\n' });
    commitFile(cwd, 'src/root.js', 'r\n', 'feat(03-01): root-scope work');
    // Workstream scope: its own phase 03, activated by the pointer file.
    seedWorkstream(cwd, { name: 'payments', active: true });
    fs.mkdirSync(path.join(cwd, '.planning', 'workstreams', 'payments', 'phases', '03-pay'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'workstreams', 'payments', 'phases', '03-pay', '03-01-PLAN.md'), '# pay\n');
    gitOrThrow(['add', '-A'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'docs(03-01): payments phase plan'], { cwd });
    commitFile(cwd, 'src/pay.js', 'p\n', 'feat(03-01): payments work');
    const out = runFences(cwd, 'TARGET_PHASE=03', [phaseResolve, phaseAnchor, phaseSelect],
      'echo "PHASE_DIR=${PHASE_DIR}"');
    assert.ok(out.includes('PHASE_DIR=.planning/workstreams/payments/phases/03-pay'),
      `find-phase must resolve the active workstream's directory; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/PHASE_DIR=.*\n?/, '')), [
      'feat(03-01): payments work',
      'docs(03-01): payments phase plan',
    ]);
  });

  test('dependency_check: PLANNING_DIR resolves the active workstream root, and falls back to .planning without one', (t) => {
    const cwd = createTempGitProject('gsd-4465-pd-');
    t.after(() => cleanup(cwd));
    const tail = 'echo "PLANNING_DIR=${PLANNING_DIR}"';
    const flat = runFences(cwd, '', [planningRoot], tail);
    assert.ok(/PLANNING_DIR=.*[\\/]\.planning$/m.test(flat), `expected the project's .planning; got:\n${flat}`);
    seedWorkstream(cwd, { name: 'payments', active: true });
    const ws = runFences(cwd, '', [planningRoot], tail);
    assert.ok(/PLANNING_DIR=.*[\\/]\.planning[\\/]workstreams[\\/]payments$/m.test(ws),
      `expected the active workstream's root; got:\n${ws}`);
    // And the fallback is real, not the only path: with no .planning at all the
    // pick yields '' (planning_root is null) and the fence lands on the literal.
    const bare = createFixture({ prefix: 'gsd-4465-noplan-', planning: false, git: true, projectDoc: false });
    t.after(() => cleanup(bare));
    const none = runFences(bare, '', [planningRoot], tail);
    assert.ok(none.includes('PLANNING_DIR=.planning'), `expected the literal fallback; got:\n${none}`);
  });
});
