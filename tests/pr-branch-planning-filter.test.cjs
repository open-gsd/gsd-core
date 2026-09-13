// docs-guard-exempt: 'docs/readme.md' is a synthetic non-planning-path fixture, never read as content.
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Failing-first suite for issue #2971 — `/gsd-pr-branch`'s `.planning/` path
 * filter grows a `planning.pr_strict` config switch and its `verify` step
 * stops contradicting the `create_pr_branch` step it is supposed to validate.
 *
 * `tests/helpers/pr-branch-filter.cjs` is the seam this file drives: it
 * PARSES the two shell declarations (`TRANSIENT_DIRS="..."` and
 * `STRUCTURAL_RE="..."`) straight out of `gsd-core/workflows/pr-branch.md`,
 * so the shipped workflow — not a second, hand-copied list in this test file
 * — is the single source of truth for which `.planning/` subdirectories are
 * "transient" and which structural files are carved out of the default
 * filter. Nothing below hardcodes a transient-dir or structural-file list;
 * every layer either builds an inline fixture text and feeds it through
 * `parseWorkflow`, or reads the real shipped file through `readWorkflow`.
 *
 * Six layers, in order:
 *   L1 — pure predicates over an inline workflow-text fixture (no disk, no
 *        subprocess): `classifyCommit` / `forbiddenPaths` / `structuralPaths`
 *        / `otherPlanningPaths` against hand-picked and boundary path lists.
 *   L2 — the real `create_pr_branch` cherry-pick-and-filter recipe, executed
 *        against real git fixtures via `sh -c`. Pins two defects reproduced
 *        empirically against today's shipped recipe (accidental deletion of
 *        untouched base `.planning/` content; a second commit silently
 *        dropped by an "untracked working tree files would be overwritten"
 *        cherry-pick abort) and proves both filter modes end-to-end.
 *   L3 — `planning.pr_strict` registration through the real CLI/config
 *        surfaces: `config-get`/`config-set`, the schema manifest, the
 *        defaults manifest, and `loadConfig`'s flat-root-alias behavior.
 *   L4 — the issue's load-bearing worktree claim, EXECUTED against a real
 *        `git worktree add`, not merely asserted.
 *   L5 — fast-check properties over the pure predicates, seeded and bounded.
 *   L6 — a drift guard over the shipped workflow's prose: this is the one
 *        layer allowed to source-grep, because the `.md` text IS the runtime
 *        contract GSD loads (CONTRIBUTING.md's source-text-is-the-product
 *        exception; the `local/no-source-grep` ESLint rule only covers
 *        `.cjs`/`.js`/`.ts`, never `.md`).
 *
 * Per CLAUDE.md's failing-first regression protocol, most of L1-L6 is
 * EXPECTED to fail until the #2971 implementation lands `planning.pr_strict`
 * in the config manifests/loader and rewrites `pr-branch.md`'s
 * `create_pr_branch`/`verify` steps. No assertion here is softened,
 * try/caught, or skipped to paper over that — a thrown `parseWorkflow` /
 * `readWorkflow` error inside an individual `test()` body is a truthful,
 * individually-attributable failure, not a suite crash, because every call
 * to `readWorkflow()` happens inside a `test()` body rather than at
 * `describe()`-collection time.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  cleanup, createTempProject, runGsdTools, readFileNormalized,
} = require('./helpers.cjs');
const { gitOrThrow, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');
const {
  WORKFLOW_PATH,
  parseWorkflow,
  readWorkflow,
  extractPickLoop,
  forbiddenRegex,
  forbiddenPaths,
  structuralPaths,
  classifyCommit,
  otherPlanningPaths,
} = require('./helpers/pr-branch-filter.cjs');
const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
const { extractFencedBlock } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_DEFAULTS_MANIFEST_PATH = path.join(
  REPO_ROOT, 'gsd-core', 'bin', 'shared', 'config-defaults.manifest.json',
);
const CONFIG_SCHEMA_MANIFEST_PATH = path.join(
  REPO_ROOT, 'gsd-core', 'bin', 'shared', 'config-schema.manifest.json',
);

/**
 * The cherry-pick recipe below runs the REAL create_pr_branch loop
 * extracted from pr-branch.md against a real git fixture (rev-list,
 * checkout, cherry-pick) -- genuine git work, not a mocked/trivial
 * operation. Pre-existing value, unchanged by this migration (#4514).
 */
const CHERRY_PICK_RECIPE_TIMEOUT_MS = 30000;

// ── Shared git-fixture primitives (L2 + L4) ────────────────────────────────

function git(args, cwd) {
  return gitOrThrow(args, { cwd, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['-c', 'init.defaultBranch=main', 'init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test User'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
}

function uniqueTmpPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('#2971 — pr-branch.md planning.pr_strict filter (failing-first)', () => {
  // ── L1: pure predicates (inline text fixtures, no disk) ─────────────────
  describe('L1: pure predicates over an inline workflow-text fixture', () => {
    const FIXTURE_TEXT = [
      'TRANSIENT_DIRS="phases quick research threads todos debug seeds codebase ui-reviews"',
      'STRUCTURAL_RE="^\\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\\.md$|^\\.planning/milestones/[^/]+\\.md$"',
      'MILESTONE_PHASES_RE="^\\.planning/milestones/[^/]+-phases/"',
    ].join('\n');
    const fixture = parseWorkflow(FIXTURE_TEXT);
    const strictOpts = { strict: true, transientDirs: fixture.transientDirs, structuralRe: fixture.structuralRe, milestonePhasesRe: fixture.milestonePhasesRe };
    const defaultOpts = { strict: false, transientDirs: fixture.transientDirs, structuralRe: fixture.structuralRe, milestonePhasesRe: fixture.milestonePhasesRe };

    test('1: [src/a.ts] includes in both modes', () => {
      assert.strictEqual(classifyCommit(['src/a.ts'], strictOpts), 'include');
      assert.strictEqual(classifyCommit(['src/a.ts'], defaultOpts), 'include');
    });

    test('2: [src/a.ts, .planning/phases/PLAN.md] includes in both modes', () => {
      const files = ['src/a.ts', '.planning/phases/PLAN.md'];
      assert.strictEqual(classifyCommit(files, strictOpts), 'include');
      assert.strictEqual(classifyCommit(files, defaultOpts), 'include');
    });

    test('3: [.planning/phases/PLAN.md] excludes in both modes', () => {
      const files = ['.planning/phases/PLAN.md'];
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
      assert.strictEqual(classifyCommit(files, defaultOpts), 'exclude');
    });

    test('4: [.planning/STATE.md] includes default, excludes strict', () => {
      const files = ['.planning/STATE.md'];
      assert.strictEqual(classifyCommit(files, defaultOpts), 'include');
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
    });

    test('5: [.planning/milestones/v1.0-ROADMAP.md] (true milestone-level FILE) includes default, excludes strict', () => {
      const files = ['.planning/milestones/v1.0-ROADMAP.md'];
      assert.strictEqual(classifyCommit(files, defaultOpts), 'include');
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
    });

    // #4605 parity pair for test 5: the nested <milestone>-phases/ directory
    // is the same reviewer noise as the flat .planning/phases/ case (test 3),
    // not structural state — it must NOT ride along with test 5's milestone
    // FILE just because both paths start with .planning/milestones/.
    test('5b: #4605 [.planning/milestones/v1.0-phases/01-01-PLAN.md] excludes in both modes (nested phases dir, not structural)', () => {
      const files = ['.planning/milestones/v1.0-phases/01-01-PLAN.md'];
      assert.strictEqual(classifyCommit(files, defaultOpts), 'exclude');
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), files);
      assert.deepStrictEqual(structuralPaths(files, defaultOpts), []);
    });

    // #4605: test 5's ORIGINAL path (.planning/milestones/m1/x.md) is neither
    // a true milestone-level file (it's nested one level deeper, under `m1/`)
    // nor a <milestone>-phases/ directory — post-fix it lands in the same
    // "third bucket" as .planning/config.json (test 6), not structural. This
    // is a deliberate behavior change from the fix (previously mis-included
    // as structural by the over-broad old regex); pinned explicitly so it
    // isn't mistaken for a future regression.
    test('5c: #4605 [.planning/milestones/m1/x.md] (nested, neither milestone-level file nor phases dir) now excludes in both modes (third bucket)', () => {
      const files = ['.planning/milestones/m1/x.md'];
      assert.strictEqual(classifyCommit(files, defaultOpts), 'exclude');
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
      assert.deepStrictEqual(structuralPaths(files, defaultOpts), []);
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
    });

    test('6: [.planning/config.json] excludes in both modes (third bucket)', () => {
      const files = ['.planning/config.json'];
      assert.strictEqual(classifyCommit(files, defaultOpts), 'exclude');
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
    });

    test('7: [] excludes in both modes', () => {
      assert.strictEqual(classifyCommit([], defaultOpts), 'exclude');
      assert.strictEqual(classifyCommit([], strictOpts), 'exclude');
    });

    // #4447: a `.planning/`-only commit that mixes a structural path with a
    // non-structural planning path (transient-dir or the "other" bucket) is
    // the exact shape the workflow's prose could not classify — the four
    // arms as written never compute a total planning-file count, so they
    // cannot tell "only structural" from "structural plus something else".
    // The JS model here already resolves it correctly (`classifyCommit`'s
    // structural check has no upper bound against the total), so these pin
    // that behavior; the actual defect is fixed in the workflow prose itself
    // (see test 51).
    test('49: #4447 [.planning/STATE.md, .planning/phases/PLAN.md] (structural + transient, no code) includes default, excludes strict', () => {
      const files = ['.planning/STATE.md', '.planning/phases/PLAN.md'];
      assert.strictEqual(classifyCommit(files, defaultOpts), 'include');
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
    });

    test('50: #4447 [.planning/STATE.md, .planning/config.json] (structural + third-bucket, no code) includes default', () => {
      const files = ['.planning/STATE.md', '.planning/config.json'];
      assert.strictEqual(classifyCommit(files, defaultOpts), 'include');
    });

    test('8: [.planning/STATE.md, src/a.ts] — forbiddenPaths [] default, [.planning/STATE.md] strict', () => {
      const files = ['.planning/STATE.md', 'src/a.ts'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), ['.planning/STATE.md']);
    });

    test('9: LOOKALIKE [src/planning-inspect.cts] — forbiddenPaths [] in both modes', () => {
      const files = ['src/planning-inspect.cts'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), []);
    });

    test('10: LOOKALIKE [.planning-notes/x.md] — forbiddenPaths [] in both modes', () => {
      const files = ['.planning-notes/x.md'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), []);
    });

    test('11: LOOKALIKE [.planningX/x.md] — forbiddenPaths [] in both modes', () => {
      const files = ['.planningX/x.md'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), []);
    });

    test('12: BOUNDARY [.planning/phases.md] (file, stem equals a transient dir) — not forbidden default, forbidden strict', () => {
      const files = ['.planning/phases.md'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), ['.planning/phases.md']);
    });

    test('13: BOUNDARY [.planning/phases/x.md] forbidden in both modes', () => {
      const files = ['.planning/phases/x.md'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), ['.planning/phases/x.md']);
      assert.deepStrictEqual(forbiddenPaths(files, strictOpts), ['.planning/phases/x.md']);
    });

    test('14: every parsed transient dir forbids .planning/<d>/f.md in default mode', () => {
      for (const d of fixture.transientDirs) {
        const p = `.planning/${d}/f.md`;
        assert.deepStrictEqual(
          forbiddenPaths([p], defaultOpts), [p],
          `expected ${p} to be forbidden in default mode`,
        );
      }
    });

    test('15: every structural file is not forbidden default, forbidden strict', () => {
      // Pattern extracted verbatim from the workflow fixture — the shipped
      // STRUCTURAL_RE pattern IS the product under test (#3951).
      const structuralRe = new RegExp(fixture.structuralRe); // allow-adhoc-regex-escape: runtime-contract-is-the-product
      for (const name of ['STATE', 'ROADMAP', 'MILESTONES', 'PROJECT', 'REQUIREMENTS']) {
        const p = `.planning/${name}.md`;
        assert.ok(structuralRe.test(p), `fixture bug: STRUCTURAL_RE must accept ${p}`);
        assert.deepStrictEqual(forbiddenPaths([p], defaultOpts), [], `${p} must not be forbidden in default mode`);
        assert.deepStrictEqual(forbiddenPaths([p], strictOpts), [p], `${p} must be forbidden in strict mode`);
      }
    });

    test('16: LOOKALIKE structural names — structuralPaths [] (anchored), land in otherPlanningPaths default', () => {
      const files = ['.planning/STATEX.md', '.planning/STATE.md.bak'];
      assert.deepStrictEqual(structuralPaths(files, defaultOpts), []);
      assert.deepStrictEqual(
        otherPlanningPaths(files, defaultOpts).sort(),
        [...files].sort(),
      );
    });

    test('17: CRLF string form classifies/filters identically to the LF array form', () => {
      const crlf = '.planning/phases/a.md\r\nsrc/b.ts\r\n';
      const arr = ['.planning/phases/a.md', 'src/b.ts'];
      for (const opts of [defaultOpts, strictOpts]) {
        assert.strictEqual(classifyCommit(crlf, opts), classifyCommit(arr, opts));
        assert.deepStrictEqual(forbiddenPaths(crlf, opts), forbiddenPaths(arr, opts));
      }
    });

    test('18: parseWorkflow throws on an absent declaration, and names the count on a duplicate', () => {
      assert.throws(
        () => parseWorkflow('no declarations here\n'),
        /no TRANSIENT_DIRS declaration/,
      );
      assert.throws(
        () => parseWorkflow('TRANSIENT_DIRS="a b"\n'),
        /no STRUCTURAL_RE declaration/,
      );
      const dupTransient = [
        'TRANSIENT_DIRS="a b"',
        'TRANSIENT_DIRS="a b"',
        'STRUCTURAL_RE="^\\.planning/STATE\\.md$"',
      ].join('\n');
      assert.throws(
        () => parseWorkflow(dupTransient),
        /TRANSIENT_DIRS declared 2 times/,
      );
      const dupStructural = [
        'TRANSIENT_DIRS="a b"',
        'STRUCTURAL_RE="^\\.planning/STATE\\.md$"',
        'STRUCTURAL_RE="^\\.planning/STATE\\.md$"',
      ].join('\n');
      assert.throws(
        () => parseWorkflow(dupStructural),
        /STRUCTURAL_RE declared 2 times/,
      );
    });

    // ── #4605: MILESTONE_PHASES_RE — folded into this same fixture/opts
    // above (tests 5/5b/5c already cover the core classification shape) ────
    test('#4605 parseWorkflow: MILESTONE_PHASES_RE is optional — absent in fixture text with no throw, and forbiddenRegex degrades to pre-#4605 behavior', () => {
      const noMilestonePhases = parseWorkflow([
        'TRANSIENT_DIRS="phases quick research threads todos debug seeds codebase ui-reviews"',
        'STRUCTURAL_RE="^\\.planning/STATE\\.md$"',
      ].join('\n'));
      assert.strictEqual(noMilestonePhases.milestonePhasesRe, undefined);
      const opts = { strict: false, transientDirs: noMilestonePhases.transientDirs, milestonePhasesRe: noMilestonePhases.milestonePhasesRe };
      assert.deepStrictEqual(forbiddenPaths(['.planning/milestones/v1.0-phases/01-01-PLAN.md'], opts), []);
    });

    test('#4605 parseWorkflow: throws on a duplicate MILESTONE_PHASES_RE, same as the other two declarations', () => {
      const dup = [
        'TRANSIENT_DIRS="a b"',
        'STRUCTURAL_RE="^\\.planning/STATE\\.md$"',
        'MILESTONE_PHASES_RE="^\\.planning/milestones/[^/]+-phases/"',
        'MILESTONE_PHASES_RE="^\\.planning/milestones/[^/]+-phases/"',
      ].join('\n');
      assert.throws(
        () => parseWorkflow(dup),
        /MILESTONE_PHASES_RE declared 2 times/,
      );
    });

    test('#4605 mixed [.planning/STATE.md, .planning/milestones/v1.0-phases/01-01-PLAN.md] includes default (structural + nested-phases), planning path filtered', () => {
      const files = ['.planning/STATE.md', '.planning/milestones/v1.0-phases/01-01-PLAN.md'];
      assert.strictEqual(classifyCommit(files, defaultOpts), 'include');
      assert.strictEqual(classifyCommit(files, strictOpts), 'exclude');
      assert.deepStrictEqual(
        forbiddenPaths(files, defaultOpts),
        ['.planning/milestones/v1.0-phases/01-01-PLAN.md'],
      );
    });

    test('#4605 LOOKALIKE [.planning/milestones/v1.0-phasesXYZ/x.md] (segment merely starts with "-phases", does not end the path component there) is not forbidden by MILESTONE_PHASES_RE', () => {
      const files = ['.planning/milestones/v1.0-phasesXYZ/x.md'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
    });

    test('#4605 LOOKALIKE [.planning/milestones-fake/v1.0-phases/x.md] ("milestones-fake", not "milestones") is not forbidden by MILESTONE_PHASES_RE', () => {
      const files = ['.planning/milestones-fake/v1.0-phases/x.md'];
      assert.deepStrictEqual(forbiddenPaths(files, defaultOpts), []);
    });

    test('#4605 every parsed milestone-phases path is forbidden for any milestone slug, default mode', () => {
      for (const slug of ['v1.0', 'm2', '2026-Q1']) {
        const p = `.planning/milestones/${slug}-phases/01-01-PLAN.md`;
        assert.deepStrictEqual(forbiddenPaths([p], defaultOpts), [p], `expected ${p} to be forbidden in default mode`);
      }
    });
  });

  // ── L2: the real create_pr_branch recipe, executed against real git ─────
  describe('L2: create_pr_branch recipe (real git)', () => {
    const activeDirs = [];

    function trackDir(dir) {
      activeDirs.push(dir);
      return dir;
    }

    function teardown() {
      while (activeDirs.length) cleanup(activeDirs.pop());
    }

    function currentTransientDirs() {
      return readWorkflow().transientDirs;
    }

    /**
     * Builds a fixture repo:
     *   main:    code.txt, (unless noPlanning) .planning/STATE.md,
     *            .planning/phases/old.md
     *   feature: c1 modifies code.txt + .planning/STATE.md, ADDS
     *            .planning/phases/new.md; c2 modifies code.txt AND the same
     *            .planning/phases/new.md (unless planningOnlySecondCommit,
     *            in which case c2 touches ONLY .planning/phases/new.md).
     *   prbranch: checked out from main (or from main + a conflicting extra
     *            commit on main, when conflict is true).
     */
    function buildFixture({ noPlanning = false, conflict = false, planningOnlySecondCommit = false } = {}) {
      const dir = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prbranch-')));
      initRepo(dir);
      writeFile(dir, 'code.txt', 'line1\n');
      if (!noPlanning) {
        writeFile(dir, '.planning/STATE.md', 'state v1\n');
        writeFile(dir, '.planning/phases/old.md', 'old plan\n');
      }
      commitAll(dir, 'chore: base');
      git(['branch', 'feature'], dir);

      git(['checkout', '-q', 'feature'], dir);
      writeFile(dir, 'code.txt', 'line1-c1\n');
      writeFile(dir, '.planning/STATE.md', 'state v2\n');
      writeFile(dir, '.planning/phases/new.md', 'new plan v1\n');
      commitAll(dir, 'feat: c1');

      if (planningOnlySecondCommit) {
        writeFile(dir, '.planning/phases/new.md', 'new plan v2\n');
        commitAll(dir, 'docs: c2 planning-only');
      } else {
        writeFile(dir, 'code.txt', 'line1-c1\nline2\n');
        writeFile(dir, '.planning/phases/new.md', 'new plan v2\n');
        commitAll(dir, 'feat: c2');
      }

      git(['checkout', '-q', 'main'], dir);
      if (conflict) {
        writeFile(dir, 'code.txt', 'line1-main\n');
        commitAll(dir, 'chore: main conflicting edit');
      }
      git(['checkout', '-q', '-b', 'prbranch', 'main'], dir);
      return dir;
    }

    function readWorkflowText() {
      return fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    }

    // Builds the exact fixture script L2 executes: fixed shell vars plus the
    // REAL create_pr_branch cherry-pick loop extracted verbatim from
    // pr-branch.md — not a hand-written mirror of it. NOTE: INCLUDED_COMMITS
    // here is deliberately ALL commits `main..feature`; this layer is only
    // proving the filter recipe (rm/checkout/conflict-halt/empty-skip), not
    // `analyze_commits`' include/exclude classification, which L1 covers.
    function buildRecipeScript(filterPaths) {
      return [
        'set -u',
        'CURRENT_BRANCH=feature',
        'PR_BRANCH=prbranch',
        'TARGET=main',
        'INCLUDED_COMMITS=$(git rev-list --reverse main..feature)',
        `FILTER_PATHS="${filterPaths.join(' ')}"`,
        extractPickLoop(readWorkflowText()),
      ].join('\n');
    }

    function runFilterLoop(repoDir, { strict, transientDirs }) {
      const filterPaths = strict ? ['.planning/'] : transientDirs.map((d) => `.planning/${d}/`);
      const script = buildRecipeScript(filterPaths);
      try {
        const stdout = execFileSync('sh', ['-c', script], { cwd: repoDir, encoding: 'utf8', timeout: CHERRY_PICK_RECIPE_TIMEOUT_MS });
        return { status: 0, stdout, stderr: '' };
      } catch (err) {
        return {
          status: typeof err.status === 'number' ? err.status : 1,
          stdout: err.stdout || '',
          stderr: err.stderr || '',
        };
      }
    }

    test('19: REGRESSION default — old.md is never staged as deleted', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      const result = runFilterLoop(dir, { strict: false, transientDirs });
      try {
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const lines = git(['diff', '--name-status', 'main..prbranch'], dir)
          .split('\n').map((s) => s.trim()).filter(Boolean);
        const deletedOld = lines.some((l) => l.startsWith('D') && l.includes('.planning/phases/old.md'));
        assert.strictEqual(deletedOld, false, `old.md must never be deleted; diff lines: ${lines.join(' | ')}`);
      } finally {
        teardown();
      }
    });

    test('20: REGRESSION strict — base planning tree is never deleted', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      try {
        const result = runFilterLoop(dir, { strict: true, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const tree = git(['ls-tree', '-r', '--name-only', 'prbranch', '--', '.planning'], dir)
          .split('\n').map((s) => s.trim()).filter(Boolean);
        assert.ok(tree.includes('.planning/STATE.md'), `expected .planning/STATE.md in ${tree.join(', ')}`);
        assert.ok(tree.includes('.planning/phases/old.md'), `expected .planning/phases/old.md in ${tree.join(', ')}`);
      } finally {
        teardown();
      }
    });

    test('21: REGRESSION default — both c1 and c2 land', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      try {
        const result = runFilterLoop(dir, { strict: false, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const count = parseInt(git(['rev-list', '--count', 'main..prbranch'], dir).trim(), 10);
        assert.strictEqual(count, 2, 'both c1 and c2 must land as commits on prbranch');
        const codeContent = fs.readFileSync(path.join(dir, 'code.txt'), 'utf-8');
        assert.ok(codeContent.includes('line2'), `expected c2's line in code.txt, got: ${codeContent}`);
      } finally {
        teardown();
      }
    });

    test('22: REGRESSION strict — both c1 and c2 land', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      try {
        const result = runFilterLoop(dir, { strict: true, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const count = parseInt(git(['rev-list', '--count', 'main..prbranch'], dir).trim(), 10);
        assert.strictEqual(count, 2, 'both c1 and c2 must land as commits on prbranch');
        const codeContent = fs.readFileSync(path.join(dir, 'code.txt'), 'utf-8');
        assert.ok(codeContent.includes('line2'), `expected c2's line in code.txt, got: ${codeContent}`);
      } finally {
        teardown();
      }
    });

    test('23: default end-to-end — diff carries code + STATE.md, nothing forbidden-default', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      try {
        const result = runFilterLoop(dir, { strict: false, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const files = git(['diff', '--name-only', 'main..prbranch'], dir)
          .split('\n').map((s) => s.trim()).filter(Boolean);
        assert.ok(files.includes('code.txt'), `expected code.txt in ${files.join(', ')}`);
        assert.ok(files.includes('.planning/STATE.md'), `expected .planning/STATE.md in ${files.join(', ')}`);
        const re = forbiddenRegex({ strict: false, transientDirs });
        assert.deepStrictEqual(files.filter((f) => re.test(f)), []);
      } finally {
        teardown();
      }
    });

    test('24: strict end-to-end — diff carries code, nothing under .planning/', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture();
      try {
        const result = runFilterLoop(dir, { strict: true, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const files = git(['diff', '--name-only', 'main..prbranch'], dir)
          .split('\n').map((s) => s.trim()).filter(Boolean);
        assert.ok(files.includes('code.txt'), `expected code.txt in ${files.join(', ')}`);
        assert.deepStrictEqual(files.filter((f) => f.startsWith('.planning/')), []);
      } finally {
        teardown();
      }
    });

    test('25: NEGATIVE — a real code conflict is not swallowed by the filter, and the halt path fully unwinds the partial prbranch', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture({ conflict: true });
      try {
        const result = runFilterLoop(dir, { strict: false, transientDirs });
        assert.notStrictEqual(result.status, 0, 'a genuine code conflict must not exit 0');
        assert.ok(
          result.stderr.includes('Conflict outside the .planning/ filter'),
          `expected the real halt message in stderr, got: ${result.stderr}`,
        );
        const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
        assert.strictEqual(
          currentBranch, 'feature',
          `expected the halt path to restore CURRENT_BRANCH (feature), got: ${currentBranch}`,
        );
        assert.throws(
          () => git(['rev-parse', '--verify', 'prbranch'], dir),
          /.*/,
          'expected the partial prbranch to be deleted by the halt path, not left stranded mid cherry-pick',
        );
      } finally {
        teardown();
      }
    });

    test('26: BOUNDARY — main tracks no .planning/ at all; loop still exits 0, both commits land', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture({ noPlanning: true });
      try {
        const result = runFilterLoop(dir, { strict: false, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const count = parseInt(git(['rev-list', '--count', 'main..prbranch'], dir).trim(), 10);
        assert.strictEqual(count, 2);
      } finally {
        teardown();
      }
    });

    test('27: BOUNDARY strict — a planning-only c2 is excluded, only c1 lands', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildFixture({ planningOnlySecondCommit: true });
      try {
        const result = runFilterLoop(dir, { strict: true, transientDirs });
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);
        const count = parseInt(git(['rev-list', '--count', 'main..prbranch'], dir).trim(), 10);
        assert.strictEqual(count, 1, 'a commit touching only .planning/ must not land under strict mode');
      } finally {
        teardown();
      }
    });

    // #4605: a separate small fixture (not buildFixture above) because it
    // needs a `.planning/milestones/<slug>-phases/` shape buildFixture never
    // produces. FILTER_PATHS here is built the same way the real workflow's
    // "Derive the mode's two projections" step builds it post-#4605: the
    // parsed transient dirs, PLUS whichever `<slug>-phases/` directories this
    // fixture repo actually has on disk — mirroring the shipped `find`
    // discovery rather than hand-listing `v1.0-phases` as a literal.
    function buildMilestonePhasesFixture() {
      const dir = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prbranch-mstone-')));
      initRepo(dir);
      writeFile(dir, 'code.txt', 'line1\n');
      writeFile(dir, '.planning/STATE.md', 'state v1\n');
      writeFile(dir, '.planning/milestones/v1.0-phases/old.md', 'old plan\n');
      commitAll(dir, 'chore: base');
      git(['branch', 'feature'], dir);

      git(['checkout', '-q', 'feature'], dir);
      writeFile(dir, 'code.txt', 'line1-c1\n');
      writeFile(dir, '.planning/STATE.md', 'state v2\n');
      writeFile(dir, '.planning/milestones/v1.0-phases/new.md', 'new plan v1\n');
      commitAll(dir, 'feat: c1');

      git(['checkout', '-q', 'main'], dir);
      git(['checkout', '-q', '-b', 'prbranch', 'main'], dir);
      return dir;
    }

    function discoverMilestonePhaseDirs(repoDir) {
      const base = path.join(repoDir, '.planning', 'milestones');
      if (!fs.existsSync(base)) return [];
      return fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.endsWith('-phases'))
        .map((e) => `.planning/milestones/${e.name}/`);
    }

    test('#4605 L2: a milestone-nested <slug>-phases/ dir is filtered from the PR branch by the real create_pr_branch recipe', () => {
      const transientDirs = currentTransientDirs();
      const dir = buildMilestonePhasesFixture();
      try {
        const filterPaths = transientDirs.map((d) => `.planning/${d}/`)
          .concat(discoverMilestonePhaseDirs(dir));
        const script = buildRecipeScript(filterPaths);
        let result;
        try {
          const stdout = execFileSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8', timeout: CHERRY_PICK_RECIPE_TIMEOUT_MS });
          result = { status: 0, stdout, stderr: '' };
        } catch (err) {
          result = { status: typeof err.status === 'number' ? err.status : 1, stdout: err.stdout || '', stderr: err.stderr || '' };
        }
        assert.strictEqual(result.status, 0, `filter loop failed: ${result.stderr}`);

        const diffFiles = git(['diff', '--name-only', 'main..prbranch'], dir)
          .split('\n').map((s) => s.trim()).filter(Boolean);
        assert.ok(
          !diffFiles.some((f) => f.startsWith('.planning/milestones/v1.0-phases/')),
          `milestone-phases content leaked into the PR branch diff: ${diffFiles.join(', ')}`,
        );
        assert.ok(diffFiles.includes('code.txt'), `expected code.txt in diff: ${diffFiles.join(', ')}`);
        assert.ok(diffFiles.includes('.planning/STATE.md'), `expected .planning/STATE.md in diff: ${diffFiles.join(', ')}`);

        // old.md predates the branch point (it's on `main` itself, same as
        // buildFixture's old.md in test 19) so it legitimately persists on
        // prbranch unchanged — that's the #3679 target-preservation contract,
        // not a leak. Assert it stays byte-identical rather than absent.
        const oldContent = fs.readFileSync(path.join(dir, '.planning/milestones/v1.0-phases/old.md'), 'utf-8');
        assert.strictEqual(oldContent, 'old plan\n', 'pre-existing old.md must survive unchanged on the checked-out prbranch worktree');
      } finally {
        teardown();
      }
    });
  });

  // ── L3: planning.pr_strict registration through the real CLI/config ─────
  describe('L3: planning.pr_strict config key registration', () => {
    const activeDirs = [];
    function trackDir(dir) {
      activeDirs.push(dir);
      return dir;
    }
    function teardown() {
      while (activeDirs.length) cleanup(activeDirs.pop());
    }

    test('28: no config.json at all -> config-get planning.pr_strict --raw is false, not "Key not found"', () => {
      const dir = trackDir(createTempProject());
      try {
        const res = runGsdTools(['query', 'config-get', 'planning.pr_strict', '--raw'], dir);
        assert.ok(res.success, `expected success, got: ${res.error}`);
        assert.strictEqual(res.output, 'false');
      } finally {
        teardown();
      }
    });

    test('29: {"planning":{"pr_strict":true}} -> prints true', () => {
      const dir = trackDir(createTempProject());
      try {
        fs.writeFileSync(
          path.join(dir, '.planning', 'config.json'),
          JSON.stringify({ planning: { pr_strict: true } }),
        );
        const res = runGsdTools(['query', 'config-get', 'planning.pr_strict', '--raw'], dir);
        assert.ok(res.success, `expected success, got: ${res.error}`);
        assert.strictEqual(res.output, 'true');
      } finally {
        teardown();
      }
    });

    test('30: {"planning":{"pr_strict":false}} -> prints false', () => {
      const dir = trackDir(createTempProject());
      try {
        fs.writeFileSync(
          path.join(dir, '.planning', 'config.json'),
          JSON.stringify({ planning: { pr_strict: false } }),
        );
        const res = runGsdTools(['query', 'config-get', 'planning.pr_strict', '--raw'], dir);
        assert.ok(res.success, `expected success, got: ${res.error}`);
        assert.strictEqual(res.output, 'false');
      } finally {
        teardown();
      }
    });

    test('31: config-set planning.pr_strict true exits 0 and round-trips through config-get', () => {
      const dir = trackDir(createTempProject());
      try {
        const setRes = runGsdTools(['config-set', 'planning.pr_strict', 'true'], dir);
        assert.ok(setRes.success, `config-set failed: ${setRes.error}`);
        const getRes = runGsdTools(['query', 'config-get', 'planning.pr_strict', '--raw'], dir);
        assert.ok(getRes.success, `config-get failed: ${getRes.error}`);
        assert.strictEqual(getRes.output, 'true');
      } finally {
        teardown();
      }
    });

    test('32: config-set planning.pr_stric true (typo) is rejected with a non-zero exit', () => {
      const dir = trackDir(createTempProject());
      try {
        const res = runGsdTools(['config-set', 'planning.pr_stric', 'true'], dir);
        assert.ok(!res.success, 'a typo\'d key must not be accepted');
        assert.notStrictEqual(res.exitCode, 0);
      } finally {
        teardown();
      }
    });

    test('33: config-defaults.manifest.json parses and planning.pr_strict is strictly false', () => {
      const manifest = JSON.parse(fs.readFileSync(CONFIG_DEFAULTS_MANIFEST_PATH, 'utf-8'));
      assert.strictEqual(
        manifest.planning && manifest.planning.pr_strict,
        false,
        'planning.pr_strict must be present and strictly false (not truthy, not absent)',
      );
    });

    test('34: config-schema.manifest.json validKeys includes planning.pr_strict', () => {
      const schema = JSON.parse(fs.readFileSync(CONFIG_SCHEMA_MANIFEST_PATH, 'utf-8'));
      assert.ok(
        Array.isArray(schema.validKeys) && schema.validKeys.includes('planning.pr_strict'),
        'config-schema.manifest.json validKeys must include "planning.pr_strict"',
      );
    });

    test('35: loadConfig resolves the flat root alias {"pr_strict":true} -> config.pr_strict === true', () => {
      const dir = trackDir(createTempProject());
      try {
        fs.writeFileSync(
          path.join(dir, '.planning', 'config.json'),
          JSON.stringify({ pr_strict: true }),
        );
        const config = loadConfig(dir);
        assert.strictEqual(config.pr_strict, true);
      } finally {
        teardown();
      }
    });

    test('36: loadConfig on {} yields pr_strict === false', () => {
      const dir = trackDir(createTempProject());
      try {
        fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({}));
        const config = loadConfig(dir);
        assert.strictEqual(config.pr_strict, false);
      } finally {
        teardown();
      }
    });
  });

  // ── L4: the issue's load-bearing worktree claim, EXECUTED not asserted ──
  describe('L4: worktree materialization (issue #2971 load-bearing claim)', () => {
    const activeDirs = [];
    const activeWorktrees = [];

    function teardown() {
      while (activeWorktrees.length) {
        const { repoDir, worktreeDir } = activeWorktrees.pop();
        try {
          git(['worktree', 'remove', '--force', worktreeDir], repoDir);
        } catch (_) {
          // best-effort; cleanup() below still removes the directory.
        }
        cleanup(worktreeDir);
      }
      while (activeDirs.length) cleanup(activeDirs.pop());
    }

    test('37: gitignored .planning/ never reaches a linked worktree (commit_docs:false is broken for parallel executors)', () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prbranch-wt-ignored-'));
      activeDirs.push(repoDir);
      try {
        initRepo(repoDir);
        writeFile(repoDir, '.gitignore', '.planning/\n');
        writeFile(repoDir, '.planning/STATE.md', 'state\n');
        writeFile(repoDir, 'README.md', '# repo\n');
        commitAll(repoDir, 'chore: base (planning gitignored)');
        const sha = git(['rev-parse', 'HEAD'], repoDir).trim();

        const worktreeDir = uniqueTmpPath('gsd-prbranch-wt-linked');
        git(['worktree', 'add', worktreeDir, sha], repoDir);
        activeWorktrees.push({ repoDir, worktreeDir });

        assert.strictEqual(
          fs.existsSync(path.join(worktreeDir, '.planning')),
          false,
          'a worktree built from a commit whose .planning/ was gitignored (never tracked) must not contain .planning/',
        );
      } finally {
        teardown();
      }
    });

    test('38: committed .planning/PLAN.md exists in a linked worktree (commit_docs:true + planning.pr_strict is the working combination)', () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prbranch-wt-committed-'));
      activeDirs.push(repoDir);
      try {
        initRepo(repoDir);
        writeFile(repoDir, '.planning/PLAN.md', '# Plan\n');
        writeFile(repoDir, 'README.md', '# repo\n');
        commitAll(repoDir, 'chore: base (planning committed)');
        const sha = git(['rev-parse', 'HEAD'], repoDir).trim();

        const worktreeDir = uniqueTmpPath('gsd-prbranch-wt-committed-linked');
        git(['worktree', 'add', worktreeDir, sha], repoDir);
        activeWorktrees.push({ repoDir, worktreeDir });

        assert.ok(
          fs.existsSync(path.join(worktreeDir, '.planning', 'PLAN.md')),
          '.planning/PLAN.md must exist inside a worktree built from a commit that tracked it',
        );
      } finally {
        teardown();
      }
    });
  });

  // ── L5: fast-check properties ─────────────────────────────────────────
  describe('L5: fast-check properties', () => {
    function buildPool(transientDirs) {
      const transientPaths = transientDirs.flatMap((d) => [`.planning/${d}/f.md`, `.planning/${d}/sub/g.md`]);
      const structuralPathsPool = [
        '.planning/STATE.md',
        '.planning/ROADMAP.md',
        '.planning/MILESTONES.md',
        '.planning/PROJECT.md',
        '.planning/REQUIREMENTS.md',
        '.planning/milestones/v1.0-ROADMAP.md',
      ];
      // #4605: .planning/milestones/m1/x.md moved here from structuralPathsPool
      // — post-fix it's neither a true milestone-level file (test 5) nor a
      // <milestone>-phases/ dir (test 5b), so it lands in the same bucket as
      // config.json (test 5c pins this explicitly for the classifier itself).
      const thirdBucket = ['.planning/config.json', '.planning/notes.md', '.planning/milestones/m1/x.md'];
      const nonPlanning = ['src/a.ts', 'docs/readme.md', 'package.json', 'src/planning-inspect.cts'];
      return fc.constantFrom(...transientPaths, ...structuralPathsPool, ...thirdBucket, ...nonPlanning);
    }

    test('39: forbiddenPaths(strict) is a superset of forbiddenPaths(default)', () => {
      const { transientDirs, structuralRe } = readWorkflow();
      const pool = buildPool(transientDirs);
      fc.assert(
        fc.property(fc.array(pool, { maxLength: 12 }), (files) => {
          const strictSet = new Set(forbiddenPaths(files, { strict: true, transientDirs, structuralRe }));
          const defaultSet = new Set(forbiddenPaths(files, { strict: false, transientDirs, structuralRe }));
          for (const f of defaultSet) {
            assert.ok(strictSet.has(f), `${f} forbidden in default mode but not in strict mode`);
          }
        }),
        { seed: 2971, numRuns: 300 },
      );
    });

    test('40: forbiddenPaths(strict) equals exactly the members matching /^\\.planning\\//', () => {
      const { transientDirs, structuralRe } = readWorkflow();
      const pool = buildPool(transientDirs);
      fc.assert(
        fc.property(fc.array(pool, { maxLength: 12 }), (files) => {
          const actual = forbiddenPaths(files, { strict: true, transientDirs, structuralRe }).sort();
          const expected = files.filter((f) => /^\.planning\//.test(f)).sort();
          assert.deepStrictEqual(actual, expected);
        }),
        { seed: 2971, numRuns: 300 },
      );
    });

    test('41: no path outside .planning/ is ever in forbiddenPaths, either mode', () => {
      const { transientDirs, structuralRe } = readWorkflow();
      const pool = buildPool(transientDirs);
      fc.assert(
        fc.property(fc.array(pool, { maxLength: 12 }), (files) => {
          for (const strict of [true, false]) {
            const result = forbiddenPaths(files, { strict, transientDirs, structuralRe });
            for (const f of result) {
              assert.ok(f.startsWith('.planning/'), `${f} is outside .planning/ but was forbidden (strict=${strict})`);
            }
          }
        }),
        { seed: 2971, numRuns: 300 },
      );
    });

    test('42: strict mode classifyCommit is include iff a member is outside .planning/', () => {
      const { transientDirs, structuralRe } = readWorkflow();
      const pool = buildPool(transientDirs);
      fc.assert(
        fc.property(fc.array(pool, { maxLength: 12 }), (files) => {
          const actual = classifyCommit(files, { strict: true, transientDirs, structuralRe });
          const expected = files.some((f) => !/^\.planning\//.test(f)) ? 'include' : 'exclude';
          assert.strictEqual(actual, expected);
        }),
        { seed: 2971, numRuns: 300 },
      );
    });
  });

  // ── L6: drift guard over the shipped workflow (prose) ────────────────
  describe('L6: drift guard over the shipped workflow (prose)', () => {
    test('43: workflow declares TRANSIENT_DIRS/STRUCTURAL_RE exactly once; 9 dirs incl. phases + ui-reviews', () => {
      const { transientDirs } = readWorkflow();
      assert.strictEqual(transientDirs.length, 9, `expected 9 transient dirs, got: ${transientDirs.join(', ')}`);
      assert.ok(transientDirs.includes('phases'));
      assert.ok(transientDirs.includes('ui-reviews'));
    });

    test('44: verify step derives from FORBIDDEN_RE, not the old unconditional wc -l count', () => {
      const text = readFileNormalized(WORKFLOW_PATH);
      const occurrences = (text.match(/FORBIDDEN_RE/g) || []).length;
      assert.ok(
        occurrences >= 2,
        `expected FORBIDDEN_RE to appear at least twice (declaration + use), found ${occurrences}`,
      );
      assert.ok(
        !text.includes('grep "^\\.planning/" | wc -l'),
        'the old unconditional `grep "^\\.planning/" | wc -l` count must be gone',
      );
    });

    test('45: create_pr_branch recipe carries every command shape L2 proved correct, in the load-bearing order', () => {
      const text = readFileNormalized(WORKFLOW_PATH);
      const required = [
        'git rm -r -f -q --ignore-unmatch --',
        'git checkout HEAD --',
        '--diff-filter=U',
        'git cherry-pick --quit',
      ];
      for (const needle of required) {
        assert.ok(text.includes(needle), `workflow is missing required recipe fragment: ${needle}`);
      }

      const loop = extractPickLoop(text);
      assert.ok(loop.length > 0, 'extractPickLoop must find exactly one canonical cherry-pick loop');

      const rmIndex = loop.indexOf('git rm -r -f -q --ignore-unmatch --');
      const checkoutIndex = loop.indexOf('git checkout HEAD --');
      assert.ok(rmIndex >= 0 && checkoutIndex >= 0, 'both rm and checkout forms must appear inside the extracted loop');
      assert.ok(
        rmIndex < checkoutIndex,
        'order is load-bearing: `git rm -r -f -q --ignore-unmatch --` must run BEFORE `git checkout HEAD --` — '
          + 'reversing it would restore the target branch\'s file and then immediately delete it, corrupting the PR branch',
      );
    });

    test('46: the old un-stage form is gone', () => {
      const text = readFileNormalized(WORKFLOW_PATH);
      assert.ok(
        !text.includes('git rm -r --cached ".planning/'),
        'the old unconditional `git rm -r --cached ".planning/` form must be removed',
      );
    });

    test('47: the workflow reads the config key', () => {
      const text = readFileNormalized(WORKFLOW_PATH);
      assert.ok(text.includes('config-get planning.pr_strict'), 'workflow must call config-get planning.pr_strict');
    });

    test('48: success criteria no longer claim an unconditional zero', () => {
      const text = readFileNormalized(WORKFLOW_PATH);
      assert.ok(
        !text.includes('- [ ] No .planning/ files in PR branch diff'),
        'the unconditional "No .planning/ files in PR branch diff" success line must be removed/replaced',
      );
    });

    // #4447: this pins the actual documented defect — ambiguous prose read by
    // an LLM executing the workflow, not the already-correct JS model in
    // pr-branch-filter.cjs (see tests 49/50). Before the fix, `analyze_commits`
    // computed FILES/NON_PLANING/STRUCTURAL but never a total planning-file
    // count, so its four classification arms had no way to distinguish
    // "only structural" `.planning/` commits from "structural plus a
    // transient/other `.planning/` path" — that second shape matched none of
    // the four arms and was silently dropped, breaking STATE.md's per-commit
    // revision chain in default mode. This must FAIL against the original
    // (unedited) step text, which had no `PLANNING_COUNT=` assignment at all.
    test('51: #4447 analyze_commits computes an explicit total .planning/ file count (PLANNING_COUNT), closing the gap that let a structural+transient/other planning commit match none of the four classification arms', () => {
      const text = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
      const stepMatch = text.match(/<step name="analyze_commits">([\s\S]{0,20000}?)<\/step>/);
      assert.ok(stepMatch, 'analyze_commits step not found in pr-branch.md');
      assert.match(
        stepMatch[1],
        /^PLANNING_COUNT=\$\(/m,
        'analyze_commits must compute an explicit total planning-file count via a real shell '
          + 'assignment (PLANNING_COUNT=$(...)) so the classification arms can distinguish '
          + '"only structural" planning commits from "structural plus transient/other" ones',
      );
    });

    // #4605: pins the actual documented defect against the shipped file, not
    // just the JS model — a bare, unanchored `^\.planning/milestones/` in
    // STRUCTURAL_RE matches a nested `<milestone>-phases/` directory (reviewer
    // noise) exactly as readily as a milestone-level file (structural state),
    // silently defeating default-mode filtering the moment a project passes a
    // milestone. This must FAIL against the pre-fix STRUCTURAL_RE, which had
    // no `[^/]+\.md$` anchor past `milestones/`.
    test('#4605 shipped STRUCTURAL_RE matches a milestone-level FILE but not a nested <milestone>-phases/ directory', () => {
      const { structuralRe } = readWorkflow();
      const re = new RegExp(structuralRe); // allow-adhoc-regex-escape: runtime-contract-is-the-product
      assert.ok(
        re.test('.planning/milestones/v1.0-ROADMAP.md'),
        'STRUCTURAL_RE must still accept a milestone-level file (e.g. v1.0-ROADMAP.md)',
      );
      assert.ok(
        !re.test('.planning/milestones/v1.0-phases/01-01-PLAN.md'),
        'STRUCTURAL_RE must NOT accept a nested <milestone>-phases/ path — that is reviewer '
          + 'noise, not structural state (#4605), and must fall through to MILESTONE_PHASES_RE',
      );
    });

    // #4605: MILESTONE_PHASES_RE is a new canonical declaration (optional in
    // the parsing seam for backward compatibility — see pr-branch-filter.cjs
    // — but the shipped file itself must always declare it exactly once,
    // same as the other two).
    test('#4605 shipped workflow declares MILESTONE_PHASES_RE exactly once, matching the <milestone>-phases/ shape', () => {
      const { milestonePhasesRe } = readWorkflow();
      assert.ok(typeof milestonePhasesRe === 'string' && milestonePhasesRe.length > 0, 'MILESTONE_PHASES_RE must be declared in the shipped workflow');
      const re = new RegExp(milestonePhasesRe); // allow-adhoc-regex-escape: runtime-contract-is-the-product
      assert.ok(re.test('.planning/milestones/v1.0-phases/01-01-PLAN.md'));
      assert.ok(!re.test('.planning/milestones/v1.0-ROADMAP.md'));
    });

    // #4605: FORBIDDEN_RE (default mode) must actually fold MILESTONE_PHASES_RE
    // in — declaring the regex alone does nothing if create_pr_branch's
    // derivation step never references it.
    test('#4605 default-mode FORBIDDEN_RE derivation references $MILESTONE_PHASES_RE', () => {
      const text = readFileNormalized(WORKFLOW_PATH);
      // Plain string search for the prose marker, THEN the sectionizer's own
      // fence scanner for the code block after it — not an ad-hoc fence
      // regex (local/no-adhoc-markdown-parsing forbids hand-rolled
      // ```-delimited parsing; extractFencedBlock is the sanctioned seam).
      const markerIdx = text.indexOf("Derive the mode's two projections");
      assert.ok(markerIdx >= 0, 'could not find the "Derive the mode\'s two projections" prose marker');
      const block = extractFencedBlock(text.slice(markerIdx), 'bash');
      assert.ok(block, 'could not find the FILTER_PATHS/FORBIDDEN_RE derivation bash block');
      assert.match(
        block,
        /^\s*FORBIDDEN_RE=.*\$MILESTONE_PHASES_RE/m,
        'the default-mode FORBIDDEN_RE assignment must fold in $MILESTONE_PHASES_RE, or a '
          + 'milestone-nested phases dir silently escapes the verify step\'s forbidden-path gate',
      );
      assert.match(
        block,
        /find \.planning\/milestones .*-name '\*-phases'/,
        'FILTER_PATHS must discover concrete <milestone>-phases/ directories on disk (the '
          + 'milestone slug is not static, so create_pr_branch cannot git-rm a literal path)',
      );
    });
  });
});
