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
      /PHASE_START=\$\(git -C "\$\{PROJECT_ROOT:-\.\}" log --format="%H" --diff-filter=A -- "\$\{PHASE_DIR\}"/.test(bash),
      'undo.md must derive PHASE_START from the phase directory (the #3995 anchor), from the project root',
    );
    // Two derivations: one for MODE=phase, one for MODE=plan.
    const anchors = (bash.match(/--diff-filter=A -- "\$\{PHASE_DIR\}"/g) || []).length;
    assert.equal(anchors, 2, 'both --phase and --plan must anchor on PHASE_DIR (#4465)');
  });

  test('O: every PHASE_DIR-scoped git call runs from the project root find-phase answers against', () => {
    // find-phase prints a path relative to the PROJECT ROOT (gsd-tools resolves it before
    // dispatch), while the workflow's shell stays wherever the user invoked it. A pathspec is
    // read relative to git's cwd, so from a subdirectory a bare `git log -- "${PHASE_DIR}"`
    // matches nothing: the anchor comes back empty and a legitimate undo is refused, and the
    // collision check comes back empty and never fires (review round 5, self-found).
    const roots = (bash.match(/PROJECT_ROOT=\$\(gsd_run query planning inspect --pick generated_from\.cwd --raw/g) || []).length;
    assert.equal(roots, 2, 'both modes must take PROJECT_ROOT from the same owner as find-phase (#4465)');
    const code = bash.split('\n').filter((l) => !/^\s*#/.test(l));
    // And from nowhere else: a rooted call is only as good as the root it is handed, so a later
    // reassignment would pass every spelling check below (review round 5, claim 8).
    const assigns = code.filter((l) => /\bPROJECT_ROOT=/.test(l));
    assert.equal(assigns.length, 2, `PROJECT_ROOT may be assigned only from planning inspect; found:\n${assigns.join('\n')}`);
    const scoped = code.filter((l) => /\bgit\b.*-- "\$\{PHASE_DIR\}"/.test(l));
    // Per mode: the collision log, the collision ls-tree, the anchor.
    assert.equal(scoped.length, 6, `expected three PHASE_DIR-scoped git calls per mode; found:\n${scoped.join('\n')}`);
    // Count every git on the line: one rooted call must not excuse a second, unrooted one.
    const unrooted = scoped.filter((l) => (l.match(/\bgit\b/g) || []).length
      !== (l.match(/\bgit -C "\$\{PROJECT_ROOT:-\.\}" (log|ls-tree)\b/g) || []).length);
    assert.deepEqual(unrooted, [],
      'a PHASE_DIR-scoped git call not run as git -C "${PROJECT_ROOT:-.}" misreads the path from a subdirectory (#4465)');
  });

  test('P: a phase planned in another repository refuses, and a foreign anchor never widens to HEAD', () => {
    // In a sub_repos project the project root is a PARENT repository. An anchor read there is a
    // commit the caller's repository does not hold, and the root-commit arm reads "no parent" as
    // "root commit" and selects all of HEAD (review round 5, driven). Two layers, both modes:
    // the same-repository refusal, and an anchor that must be a commit in this repository.
    const code = extractBashBlocks(content)
      .map((b) => b.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'));
    // The COMMON git directory is the repository's identity: a linked worktree has its own per-worktree
    // git dir but shares the object database, and gsd-tools maps its planning to the MAIN worktree, so a
    // per-worktree comparison refuses a legitimate undo there (review round 5, third pass).
    const gates = code.filter((b) => /PHASE_DIR_FOREIGN=""/.test(b)
      && /_gd_here=\$\(_d=\$\(git rev-parse --git-common-dir 2>\/dev\/null\)/.test(b)
      && /_gd_root=\$\(cd "\$\{PROJECT_ROOT\}" 2>\/dev\/null && _d=\$\(git rev-parse --git-common-dir 2>\/dev\/null\)/.test(b)
      && /PHASE_DIR_FOREIGN="\$\{PROJECT_ROOT\}"; PHASE_DIR=""/.test(b));
    assert.equal(gates.length, 2, `both modes must refuse a phase directory in another repository; found ${gates.length}`);
    assert.ok(!/--absolute-git-dir/.test(code.join('\n')),
      'the repository gate must not compare per-worktree git dirs: it refuses a linked worktree');
    const hardened = (bash.match(/! git merge-base --is-ancestor "\$PHASE_START" HEAD 2>\/dev\/null; then PHASE_START=""; fi/g) || []).length;
    assert.equal(hardened, 2, 'both modes must blank a PHASE_START outside HEAD\'s own history before the root-commit arm');
    assert.equal((content.match(/PHASE_DIR_FOREIGN/g) || []).length >= 6, true,
      'the refusal must be documented, not only computed');
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
    // BOTH archive layouts the phase locator enumerates (listArchiveVersionDirs): the flat
    // `v<X.Y>-phases/<phase>` and the workstream archive `ws-<name>-<date>/phases/<phase>`.
    const guards = extractBashBlocks(content).filter(
      (b) => /PHASE_DIR_ARCHIVED=""/.test(b)
        && /\*\/milestones\/v\[0-9\]\*-phases\/\*\|milestones\/v\[0-9\]\*-phases\/\*/.test(b)
        && /\*\/milestones\/ws-\*\/phases\/\*\|milestones\/ws-\*\/phases\/\*/.test(b),
    );
    assert.equal(guards.length, 2,
      `undo.md must refuse BOTH archive layouts in BOTH modes; found ${guards.length} guard(s)`);
    // The same fence carries the reused-path collision check, and it asks HISTORY, not a
    // layout: a path that went empty in HEAD's history and came back anchors on the earlier
    // occupant's add, whatever vacated it (review round 4: a layout glob missed the ws-*
    // archive and would miss the next layout too).
    for (const g of guards) {
      const code = g.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      assert.ok(/PHASE_DIR_REUSED=""/.test(code)
        && /git -C "\$\{PROJECT_ROOT:-\.\}" log -m --no-renames --diff-filter=D --format=%H -- "\$\{PHASE_DIR\}"/.test(code)
        && /git -C "\$\{PROJECT_ROOT:-\.\}" ls-tree -d "\$_c" -- "\$\{PHASE_DIR\}"/.test(code),
        `each guard fence must refuse a path that history shows was vacated (#4465):\n${code}`);
      // No second reader of the archive layout inside the collision check.
      const collision = code.slice(code.indexOf('PHASE_DIR_REUSED=""'));
      assert.ok(!/milestones/.test(collision),
        `the collision check must not re-derive the archive layout from a glob (#4465):\n${collision}`);
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
  // Located loosely on purpose: shape test C pins the anchor's spelling, and a locator that
  // pinned it too would turn a spelling change into "no such fence" instead of a C failure.
  const phaseAnchor = fenceWhere(bodies, 'phase anchor',
    (b) => b.includes('PHASE_START=$(') && !b.includes('PLAN_PHASE'));
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

  // `runIn` is the directory the shell starts in, when it is not the fixture root: the user
  // can invoke /gsd:undo from anywhere inside the project.
  function runFences(cwd, seed, fences, tail = '', extraEnv = {}, runIn = cwd) {
    const script = [seed, GSD_RUN, ...fences, tail].join('\n');
    const env = { ...process.env, GSD_TOOLS_BIN, HOME: cwd };
    // A developer's active workstream must not leak into the fixture; a test that wants
    // one names it through `extraEnv`, applied after the scrub.
    delete env.GSD_WORKSTREAM;
    delete env.GSD_PROJECT;
    Object.assign(env, extraEnv);
    const r = runHookSeam('-c', [script], { interpreter: 'bash', cwd: runIn, env, timeoutMs: PROBE_TIMEOUT_MS });
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
  //
  // THE RESOLVER CONTRACT, stated precisely because there are TWO readers of the archive
  // tree and they disagree (review round 4). `find-phase` routes to cmdFindPhase
  // (src/phase.cts), which builds its OWN search list: the live `phases/` dir, then
  // `milestones/` entries matching /^v\d+.*-phases$/ — the flat layout ONLY. The phase
  // locator (listArchiveVersionDirs, src/phase-locator.cts) additionally enumerates the
  // workstream archive `milestones/ws-<name>-<date>/phases/`, which `workstream complete`
  // writes; find-phase never searches it. The tests below pin what find-phase actually
  // returns for BOTH layouts, so a change to either reader shows up here.
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
  // live directory -- so the collision check asks history whether this exact path was ever
  // vacated (round 4: it used to look for an archived twin by layout, and missed ws-*).
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
      'printf "REUSED=[%s]\\nPHASE_DIR=[%s]\\nUNDO_RANGE=[%s]\\n" "$(git log -1 --format=%s "$PHASE_DIR_REUSED" 2>/dev/null)" "$PHASE_DIR" "$UNDO_RANGE"');
    assert.ok(out.includes('REUSED=[chore: archive v1.0]'),
      `the refusal must name the commit that vacated the path; got:\n${out}`);
    assert.ok(out.includes('UNDO_RANGE=[]'), `UNDO_RANGE must stay empty; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/(REUSED|PHASE_DIR|UNDO_RANGE)=.*\n?/g, '')), [],
      'nothing may be selected once the reused path is refused');
  });

  test('--plan REFUSES a reused directory name too', (t) => {
    const cwd = reusedSlugFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PLAN=03-01', [planAnchor, planSelect],
      'printf "REUSED=[%s]\\nUNDO_RANGE=[%s]\\n" "$(git log -1 --format=%s "$PHASE_DIR_REUSED" 2>/dev/null)" "$UNDO_RANGE"');
    assert.ok(out.includes('REUSED=[chore: archive v1.0]'),
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

  test('false-positive control: a same-named entry under milestones/ does not refuse a never-vacated path', (t) => {
    // A CONTROL, not a proof the collision check works: with the check deleted this still
    // passes. What it catches is the opposite failure -- a check that refuses on a NAME it
    // finds under milestones/ rather than on this path's history, which is the layout-keyed
    // shape round 4 replaced. Round 2 pinned it for a stray FILE against the old glob.
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

  test('false-positive control: a same-named phase dir under a malformed milestone dir does not refuse', (t) => {
    // A CONTROL, like the one above: it passes with the collision check deleted, and fails only
    // if the check starts refusing on a directory name. `vnondigit-phases` is not a milestone
    // either reader of the archive tree admits, and this live path was never vacated.
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
      `a live path that was never vacated must not refuse; got:\n${out}`);
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
    // is live and revertible — a fail-closed bug, but a bug. Only the archive LAYOUTS
    // (`v<X.Y>-phases/<phase>` and `ws-<name>-<date>/phases/<phase>`) separate the two.
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

  // Round 4: the WORKSTREAM archive layout. `workstream complete` moves
  // `.planning/workstreams/<name>/` whole into `.planning/milestones/ws-<name>-<date>/`, so an
  // archived phase's former path is `.planning/workstreams/<name>/phases/<phase>`. Re-creating
  // the workstream under the same name with the same phase slug re-creates that exact path.
  function workstreamArchiveFixture({ recreate }) {
    const cwd = createTempGitProject('gsd-4465-ws-');
    commitFile(cwd, '.planning/workstreams/feat/phases/03-auth/03-01-PLAN.md', '# gen 1\n',
      'docs(03-01): feat generation-1 plan');
    commitFile(cwd, 'src/gen1.js', 'g1\n', 'feat(03-01): feat generation-1 work');
    fs.mkdirSync(path.join(cwd, '.planning', 'milestones'), { recursive: true });
    gitOrThrow(['mv', '.planning/workstreams/feat', '.planning/milestones/ws-feat-2026-09-01'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'chore: complete workstream feat'], { cwd });
    if (recreate) {
      commitFile(cwd, '.planning/workstreams/feat/phases/03-auth/03-01-PLAN.md', '# gen 2\n',
        'docs(03-01): feat generation-2 plan');
      commitFile(cwd, 'src/gen2.js', 'g2\n', 'feat(03-01): feat generation-2 work');
    } else {
      // A later phase 03 commit in the current scope with no live phase dir behind it.
      commitFile(cwd, 'src/later.js', 'l\n', 'feat(03-01): later milestone work');
    }
    return cwd;
  }
  const WS_FEAT = { GSD_WORKSTREAM: 'feat' };

  test('negative control: WITHOUT the collision guard, a re-created workstream selects its archived generation too', (t) => {
    const cwd = workstreamArchiveFixture({ recreate: true });
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PHASE=03', [phaseResolve, phaseAnchor, phaseSelect],
      'echo "PHASE_DIR=${PHASE_DIR}"', WS_FEAT);
    assert.ok(out.includes('PHASE_DIR=.planning/workstreams/feat/phases/03-auth'),
      `find-phase must return the LIVE re-created path; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/PHASE_DIR=.*\n?/, '')), [
      'feat(03-01): feat generation-2 work',
      'docs(03-01): feat generation-2 plan',
      'feat(03-01): feat generation-1 work',
      'docs(03-01): feat generation-1 plan',
    ], 'the unguarded window must reach back into the archived workstream generation');
  });

  test('--phase REFUSES a path re-created after a workstream archive (the ws-* layout)', (t) => {
    const cwd = workstreamArchiveFixture({ recreate: true });
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PHASE=03',
      [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect],
      'printf "REUSED=[%s]\\nLIVE=[%s]\\nUNDO_RANGE=[%s]\\n" "$(git log -1 --format=%s "$PHASE_DIR_REUSED" 2>/dev/null)" "$PHASE_DIR_LIVE" "$UNDO_RANGE"',
      WS_FEAT);
    assert.ok(out.includes('REUSED=[chore: complete workstream feat]'),
      `the refusal must name the workstream archive that vacated the path; got:\n${out}`);
    assert.ok(out.includes('LIVE=[.planning/workstreams/feat/phases/03-auth]'), `got:\n${out}`);
    assert.ok(out.includes('UNDO_RANGE=[]'), `UNDO_RANGE must stay empty; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/(REUSED|LIVE|UNDO_RANGE)=.*\n?/g, '')), [],
      'nothing may be selected: selection must not cross into the archived generation');
  });

  test('--plan REFUSES a path re-created after a workstream archive too', (t) => {
    const cwd = workstreamArchiveFixture({ recreate: true });
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PLAN=03-01', [planAnchor, planSelect],
      'printf "REUSED=[%s]\\nUNDO_RANGE=[%s]\\n" "$(git log -1 --format=%s "$PHASE_DIR_REUSED" 2>/dev/null)" "$UNDO_RANGE"',
      WS_FEAT);
    assert.ok(out.includes('REUSED=[chore: complete workstream feat]'), `got:\n${out}`);
    assert.ok(out.includes('UNDO_RANGE=[]'), `UNDO_RANGE must stay empty; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/(REUSED|UNDO_RANGE)=.*\n?/g, '')), []);
  });

  test('find-phase does not search the ws-* archive: a phase only there resolves to nothing, and nothing is selected', (t) => {
    // The actual resolver contract, pinned: cmdFindPhase admits only /^v\d+.*-phases$/ under
    // milestones/. So the ws-* archive never reaches the archived refusal through find-phase;
    // the not-found rule fails closed instead. If find-phase is ever taught the ws-* layout this
    // test goes red, and the stubbed-resolver test below is what keeps the refusal honest then.
    const cwd = workstreamArchiveFixture({ recreate: false });
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PHASE=03',
      [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect],
      'printf "PHASE_DIR=[%s]\\nARCHIVED=[%s]\\nUNDO_RANGE=[%s]\\n" "$PHASE_DIR" "$PHASE_DIR_ARCHIVED" "$UNDO_RANGE"');
    assert.ok(out.includes('PHASE_DIR=[]'), `find-phase must not resolve into ws-*; got:\n${out}`);
    assert.ok(out.includes('UNDO_RANGE=[]'), `no anchor, no range; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/(PHASE_DIR|ARCHIVED|UNDO_RANGE)=.*\n?/g, '')), [],
      'the later milestone\'s same-numbered commit must not be selected');
  });

  test('the archived refusal covers the ws-* layout if a resolver ever returns it (both modes)', (t) => {
    // Stubbed resolver: stands in for a find-phase that has been taught the locator's second
    // layout. Without the ws-* arm, PHASE_START would be the archival commit and the window
    // would run forward from it -- the exact contamination the refusal exists for.
    const cwd = workstreamArchiveFixture({ recreate: false });
    t.after(() => cleanup(cwd));
    const stub = 'gsd_run() { echo ".planning/milestones/ws-feat-2026-09-01/phases/03-auth"; }';
    const report = 'printf "ARCHIVED=[%s]\\nPHASE_DIR=[%s]\\nUNDO_RANGE=[%s]\\n" "$PHASE_DIR_ARCHIVED" "$PHASE_DIR" "$UNDO_RANGE"';
    for (const [seed, fences] of [
      ['TARGET_PHASE=03', [stub, phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect]],
      ['TARGET_PLAN=03-01', [stub, planAnchor, planSelect]],
    ]) {
      const out = runFences(cwd, seed, fences, report);
      assert.ok(out.includes('ARCHIVED=[.planning/milestones/ws-feat-2026-09-01/phases/03-auth]'),
        `${seed}: a ws-* archive path must be refused; got:\n${out}`);
      assert.ok(out.includes('PHASE_DIR=[]') && out.includes('UNDO_RANGE=[]'), `${seed}: got:\n${out}`);
      assert.deepEqual(subjects(out.replace(/(ARCHIVED|PHASE_DIR|UNDO_RANGE)=.*\n?/g, '')), [],
        `${seed}: nothing may be selected once the resolution is refused`);
    }
  });

  test('self-found: a phase REMOVED and re-added under the same slug is refused too', (t) => {
    // No archive anywhere -- the path was simply deleted and re-created. A layout glob has no
    // entry to find; the history check sees the vacancy. Same anchor defect, same refusal.
    const cwd = createTempGitProject('gsd-4465-readd-');
    t.after(() => cleanup(cwd));
    commitFile(cwd, '.planning/phases/03-auth/03-01-PLAN.md', '# first\n', 'docs(03-01): first plan');
    commitFile(cwd, 'src/first.js', 'f\n', 'feat(03-01): first attempt');
    gitOrThrow(['rm', '-rq', '.planning/phases/03-auth'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'chore: remove phase 03'], { cwd });
    commitFile(cwd, '.planning/phases/03-auth/03-01-PLAN.md', '# second\n', 'docs(03-01): second plan');
    const out = runFences(cwd, 'TARGET_PHASE=03',
      [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect],
      'printf "REUSED=[%s]\\nUNDO_RANGE=[%s]\\n" "$(git log -1 --format=%s "$PHASE_DIR_REUSED" 2>/dev/null)" "$UNDO_RANGE"');
    assert.ok(out.includes('REUSED=[chore: remove phase 03]'), `got:\n${out}`);
    assert.ok(out.includes('UNDO_RANGE=[]'), `got:\n${out}`);
  });

  function droppedPlanFixture() {
    const cwd = createTempGitProject('gsd-4465-dropplan-');
    commitFile(cwd, '.planning/phases/03-auth/03-01-PLAN.md', '# one\n', 'docs(03-01): plan one');
    commitFile(cwd, '.planning/phases/03-auth/03-02-PLAN.md', '# two\n', 'docs(03-02): plan two');
    gitOrThrow(['rm', '-q', '.planning/phases/03-auth/03-02-PLAN.md'], { cwd });
    gitOrThrow(['commit', '-q', '-m', 'docs(03-02): drop plan two'], { cwd });
    commitFile(cwd, 'src/auth.js', 'a\n', 'feat(03-01): auth work');
    return cwd;
  }
  const DROPPED_PLAN_PHASE = [
    'feat(03-01): auth work',
    'docs(03-02): drop plan two',
    'docs(03-02): plan two',
    'docs(03-01): plan one',
  ];

  test('the collision check is not tripped by an ordinary deleted file inside a live phase', (t) => {
    // The vacancy test is on the DIRECTORY (`ls-tree -d` at the deleting commit), so dropping
    // one plan file from a phase that still exists is not a previous occupant.
    const cwd = droppedPlanFixture();
    t.after(() => cleanup(cwd));
    const out = runFences(cwd, 'TARGET_PHASE=03',
      [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect],
      'echo "REUSED=[${PHASE_DIR_REUSED}]"');
    assert.ok(out.includes('REUSED=[]'), `a dropped plan file is not a vacated phase; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/REUSED=.*\n?/, '')), DROPPED_PLAN_PHASE,
      'the whole phase must still be selectable');
  });

  // Review round 5, self-found: the user can run /gsd:undo from anywhere inside the project.
  // find-phase answers relative to the PROJECT ROOT; a pathspec is read relative to git's cwd.
  // Every test above runs from the fixture root, where the two coincide and the mismatch is
  // invisible. These run the same fences from `sub/dir`.
  function fromSubdir(cwd) {
    const runIn = path.join(cwd, 'sub', 'dir');
    fs.mkdirSync(runIn, { recursive: true });
    return (seed, fences, tail = '', extraEnv = {}) =>
      runFences(cwd, seed, fences, tail, extraEnv, runIn);
  }

  test('from a subdirectory: --phase and --plan select exactly what they select at the root', (t) => {
    const cwd = multiMilestoneFixture();
    t.after(() => cleanup(cwd));
    const run = fromSubdir(cwd);
    const report = 'printf "PHASE_DIR=[%s]\\nUNDO_RANGE=[%s]\\n" "$PHASE_DIR" "$UNDO_RANGE"';
    for (const [seed, fences] of [
      ['TARGET_PHASE=03', [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect]],
      ['TARGET_PLAN=03-01', [planAnchor, planSelect]],
    ]) {
      const out = run(seed, fences, report);
      // The resolver half: find-phase did find the project from here, so a failure below is
      // the git half's, not a lookup that never happened.
      assert.ok(out.includes('PHASE_DIR=[.planning/phases/03-beta]'), `${seed}: got:\n${out}`);
      assert.ok(!out.includes('UNDO_RANGE=[]'), `${seed}: the anchor must resolve from a subdirectory; got:\n${out}`);
      assert.deepEqual(subjects(out.replace(/(PHASE_DIR|UNDO_RANGE)=.*\n?/g, '')),
        ['feat(03-01): add beta feature flag'], `${seed}: from sub/dir`);
    }
  });

  test('from a subdirectory: a re-created path is still refused (both layouts, both modes)', (t) => {
    const report = 'printf "REUSED=[%s]\\nUNDO_RANGE=[%s]\\n" "$(git log -1 --format=%s "$PHASE_DIR_REUSED" 2>/dev/null)" "$UNDO_RANGE"';
    for (const [label, build, vacatedBy, env] of [
      ['flat archive', reusedSlugFixture, 'chore: archive v1.0', {}],
      ['ws-* archive', () => workstreamArchiveFixture({ recreate: true }), 'chore: complete workstream feat', WS_FEAT],
    ]) {
      const cwd = build();
      t.after(() => cleanup(cwd));
      const run = fromSubdir(cwd);
      for (const [seed, fences] of [
        ['TARGET_PHASE=03', [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect]],
        ['TARGET_PLAN=03-01', [planAnchor, planSelect]],
      ]) {
        const out = run(seed, fences, report, env);
        assert.ok(out.includes(`REUSED=[${vacatedBy}]`),
          `${label}, ${seed}: the collision check must see the vacancy from sub/dir; got:\n${out}`);
        assert.ok(out.includes('UNDO_RANGE=[]'), `${label}, ${seed}: got:\n${out}`);
        assert.deepEqual(subjects(out.replace(/(REUSED|UNDO_RANGE)=.*\n?/g, '')), [], `${label}, ${seed}`);
      }
    }
  });

  test('from a subdirectory: a dropped plan file still does not refuse (both modes)', (t) => {
    // The other direction. An `ls-tree` that misreads the path lists nothing, and "lists nothing"
    // is exactly what the check reads as "the directory went away": a mis-rooted ls-tree does not
    // miss the collision, it refuses every phase that ever lost a file.
    const cwd = droppedPlanFixture();
    t.after(() => cleanup(cwd));
    const run = fromSubdir(cwd);
    for (const [seed, fences, expected] of [
      ['TARGET_PHASE=03', [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect], DROPPED_PLAN_PHASE],
      ['TARGET_PLAN=03-02', [planAnchor, planSelect], ['docs(03-02): drop plan two', 'docs(03-02): plan two']],
    ]) {
      const out = run(seed, fences, 'echo "REUSED=[${PHASE_DIR_REUSED}]"');
      assert.ok(out.includes('REUSED=[]'), `${seed}: a dropped plan file is not a vacated phase; got:\n${out}`);
      assert.deepEqual(subjects(out.replace(/REUSED=.*\n?/, '')), expected, `${seed}: from sub/dir`);
    }
  });

  // Review round 5, second pass: a `sub_repos` project keeps .planning/ in a PARENT repository and
  // the code in child repositories. From a child, findProjectRoot returns the parent, so the project
  // root and the repository the commits live in are different repositories.
  function subReposFixture(t) {
    const parent = createFixture({ prefix: 'gsd-4465-subrepos-', planning: false, git: true, projectDoc: false });
    t.after(() => cleanup(parent));
    fs.writeFileSync(path.join(parent, '.gitignore'), 'child/\n');
    fs.mkdirSync(path.join(parent, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(parent, '.planning', 'config.json'), '{"sub_repos":["child"]}\n');
    commitFile(parent, '.planning/phases/03-auth/03-01-PLAN.md', '# parent plan\n', 'docs(03-01): parent phase plan');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child);
    const g = (args) => gitOrThrow(args, { cwd: child });
    g(['init', '-q']); g(['config', 'user.email', 'test@test.com']); g(['config', 'user.name', 'Test']);
    g(['config', 'commit.gpgsign', 'false']);
    commitFile(child, 'a.js', 'a\n', 'feat(03-01): old child work');
    commitFile(child, 'b.js', 'b\n', 'feat(03-01): current child work');
    // HOME off the parent, so the sub_repos branch of findProjectRoot is the one that resolves.
    const home = createFixture({ prefix: 'gsd-4465-home-', planning: false, git: false });
    t.after(() => cleanup(home));
    return { parent, child, env: { HOME: home } };
  }

  test('negative control: the pre-hardening root-commit arm widened a foreign anchor to all of HEAD', (t) => {
    // The anchor's root-commit branch as it stood before this round's hardening, verbatim, fed the
    // PARENT repository's anchor from inside the child. If it did not widen here, the refusal tests
    // below would be vacuous.
    const { parent, child, env } = subReposFixture(t);
    const foreign = gitOrThrow(['rev-parse', 'HEAD'], { cwd: parent }).trim();
    const out = runFences(parent, `PHASE_START=${foreign}`, [
      'UNDO_RANGE=""; if [ -n "$PHASE_START" ]; then if git rev-parse "${PHASE_START}^" >/dev/null 2>&1; then UNDO_RANGE="${PHASE_START}^..HEAD"; else UNDO_RANGE="HEAD"; fi; fi',
      'echo "UNDO_RANGE=${UNDO_RANGE}"',
      'git log --oneline --no-merges "${UNDO_RANGE}" | grep -E "\\(0*03(-[0-9]+)?\\):" || true',
    ], '', env, child);
    assert.ok(out.includes('UNDO_RANGE=HEAD'), `got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/UNDO_RANGE=.*\n?/, '')),
      ['feat(03-01): current child work', 'feat(03-01): old child work']);
  });

  test('sub_repos: a phase planned in the parent repository is REFUSED from a child (both modes)', (t) => {
    const { parent, child, env } = subReposFixture(t);
    const report = 'printf "FOREIGN=[%s]\\nUNDO_RANGE=[%s]\\n" "$PHASE_DIR_FOREIGN" "$UNDO_RANGE"';
    for (const [seed, fences] of [
      ['TARGET_PHASE=03', [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect]],
      ['TARGET_PLAN=03-01', [planAnchor, planSelect]],
    ]) {
      const out = runFences(parent, seed, fences, report, env, child);
      const foreign = /FOREIGN=\[(.*)\]/.exec(out);
      assert.ok(foreign && foreign[1] !== '' && fs.realpathSync(foreign[1]) === fs.realpathSync(parent),
        `${seed}: must refuse, naming the parent repository; got:\n${out}`);
      assert.ok(out.includes('UNDO_RANGE=[]'), `${seed}: got:\n${out}`);
      assert.deepEqual(subjects(out.replace(/(FOREIGN|UNDO_RANGE)=.*\n?/g, '')), [], `${seed}: nothing may be selected`);
    }
  });

  test('defense in depth: without the repository refusal, a foreign anchor still resolves no range', (t) => {
    // The repository refusal lives in the guard fence; drop it and the anchor fence's own check --
    // PHASE_START must be a commit THIS repository holds -- still keeps the window from widening.
    const { parent, child, env } = subReposFixture(t);
    const out = runFences(parent, 'TARGET_PHASE=03', [phaseResolve, phaseAnchor, phaseSelect],
      'printf "PHASE_START=[%s]\\nUNDO_RANGE=[%s]\\n" "$PHASE_START" "$UNDO_RANGE"', env, child);
    assert.ok(out.includes('PHASE_START=[]') && out.includes('UNDO_RANGE=[]'), `got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/(PHASE_START|UNDO_RANGE)=.*\n?/g, '')), []);
  });

  // Review round 5, third pass: a LINKED worktree. gsd-tools maps a linked worktree with no
  // .planning/ of its own to the MAIN worktree (resolveMainWorktreeCwd), so PROJECT_ROOT is the main
  // checkout while the shell sits in the linked one: two worktrees, one repository. The anchor then
  // comes from the main branch's history, which the linked HEAD may or may not contain.
  function linkedWorktreeFixture(t, { branchAfterPhase }) {
    const main = createTempGitProject('gsd-4465-wt-main-');
    t.after(() => cleanup(main));
    const linked = createFixture({ prefix: 'gsd-4465-wt-linked-', planning: false, git: false });
    t.after(() => cleanup(linked));
    const phase = () => {
      seedPhase(main, '03-auth', { '03-01-PLAN.md': '# plan\n' });
      gitOrThrow(['add', '-A'], { cwd: main });
      gitOrThrow(['commit', '-q', '-m', 'docs(03-01): phase plan'], { cwd: main });
      commitFile(main, 'src/a.js', 'a\n', 'feat(03-01): main work');
    };
    if (branchAfterPhase) phase();
    gitOrThrow(['worktree', 'add', '-q', '-b', 'feature', linked], { cwd: main });
    if (!branchAfterPhase) phase();
    // No .planning/ in the linked checkout: that is what sends gsd-tools to the main worktree.
    gitOrThrow(['rm', '-rq', '.planning'], { cwd: linked });
    gitOrThrow(['commit', '-q', '-m', 'chore: executor worktree without planning'], { cwd: linked });
    commitFile(linked, 'src/b.js', 'b\n', 'feat(03-01): linked work');
    return { main, linked };
  }
  const LINKED_REPORT = 'printf "ROOT=[%s]\\nFOREIGN=[%s]\\nUNDO_RANGE=[%s]\\n" "$PROJECT_ROOT" "$PHASE_DIR_FOREIGN" "$UNDO_RANGE"';
  const assertMappedToMain = (out, main, seed) => {
    // The mapping is what makes this case: were PROJECT_ROOT the linked checkout, nothing would
    // compare two worktrees and the test would pass vacuously.
    const root = /ROOT=\[(.*)\]/.exec(out);
    assert.ok(root && root[1] !== '' && fs.realpathSync(root[1]) === fs.realpathSync(main),
      `${seed}: planning must resolve to the MAIN worktree from the linked one; got:\n${out}`);
  };

  test('linked worktree: the main worktree\'s planning is the same repository, and is not refused (both modes)', (t) => {
    const { main, linked } = linkedWorktreeFixture(t, { branchAfterPhase: true });
    for (const [seed, fences] of [
      ['TARGET_PHASE=03', [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect]],
      ['TARGET_PLAN=03-01', [planAnchor, planSelect]],
    ]) {
      const out = runFences(main, seed, fences, LINKED_REPORT, {}, linked);
      assertMappedToMain(out, main, seed);
      assert.ok(out.includes('FOREIGN=[]'), `${seed}: a linked worktree is the same repository; got:\n${out}`);
      assert.deepEqual(subjects(out.replace(/(ROOT|FOREIGN|UNDO_RANGE)=.*\n?/g, '')),
        ['feat(03-01): linked work', 'feat(03-01): main work', 'docs(03-01): phase plan'], `${seed}`);
    }
  });

  test('linked worktree branched BEFORE the phase: an anchor outside HEAD\'s history resolves no range (both modes)', (t) => {
    // Same repository, so the gate passes -- but the phase started on the main branch after this
    // branch left it, so the anchor is not in the linked HEAD's history and bounds nothing on it.
    // Without the ancestry check the window would be every linked commit since the fork.
    const { main, linked } = linkedWorktreeFixture(t, { branchAfterPhase: false });
    for (const [seed, fences] of [
      ['TARGET_PHASE=03', [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect]],
      ['TARGET_PLAN=03-01', [planAnchor, planSelect]],
    ]) {
      const out = runFences(main, seed, fences, LINKED_REPORT, {}, linked);
      assertMappedToMain(out, main, seed);
      assert.ok(out.includes('FOREIGN=[]') && out.includes('UNDO_RANGE=[]'), `${seed}: got:\n${out}`);
      assert.deepEqual(subjects(out.replace(/(ROOT|FOREIGN|UNDO_RANGE)=.*\n?/g, '')), [], `${seed}: nothing may be selected`);
    }
  });

  test('control: the root is the PROJECT root, not the repository top level', (t) => {
    // A project need not sit at the top of its repository. find-phase answers relative to the
    // directory holding .planning/, so `git rev-parse --show-toplevel` would be the wrong -C
    // here; generated_from.cwd is the directory find-phase itself resolved against. Run from the
    // project root, so this pins the choice of root, not the subdirectory case above.
    const repo = createFixture({ prefix: 'gsd-4465-nested-', planning: false, git: true, projectDoc: false });
    t.after(() => cleanup(repo));
    const project = path.join(repo, 'app');
    commitFile(repo, 'app/.planning/phases/03-auth/03-01-PLAN.md', '# nested\n', 'docs(03-01): nested plan');
    commitFile(repo, 'app/src/a.js', 'a\n', 'feat(03-01): nested work');
    const out = runFences(repo, 'TARGET_PHASE=03',
      [phaseResolve, phaseArchivedGuard, phaseAnchor, phaseSelect],
      'printf "PROJECT_ROOT=[%s]\\n" "$PROJECT_ROOT"', {}, project);
    assert.ok(/PROJECT_ROOT=\[.*[\\/]app\]/.test(out), `expected the nested project's root; got:\n${out}`);
    assert.deepEqual(subjects(out.replace(/PROJECT_ROOT=.*\n?/, '')), [
      'feat(03-01): nested work',
      'docs(03-01): nested plan',
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
