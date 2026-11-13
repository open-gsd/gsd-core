'use strict';

/**
 * Integration tests for `src/state-contract.cts` — the v1
 * `.planning/state.json` best-effort publisher (#3227).
 *
 * This file owns the CLI / call-site wiring band only: it spawns the real
 * `gsd-tools` binary via `runGsdTools` for each of the 11 documented
 * step-boundary commands (plus the non-boundary / no-planning / idempotent /
 * error-path guard cases) and asserts state.json actually lands on disk
 * end-to-end through the real dispatch path. The spawn-free, in-process
 * parsing/mapping/degradation/property-based surface — everything that does
 * NOT need a child process — lives in the `.unit.` sibling
 * `tests/state-contract.unit.test.cjs`, which is also the Stryker mutation
 * shard target (`scripts/mutation-matrix.cjs`, `state-contract` entry):
 * Stryker's command runner treats one `node --test <file>` invocation as a
 * single test costing whatever its slowest case costs, re-run once per
 * mutant, so a suite that spawns a child process per case cannot finish
 * inside the 15-minute shard cap (#2790 precedent).
 *
 * Design:       .gsd/phase/feat-3227-state-contract/40-design.md
 * Test matrix:  .gsd/phase/feat-3227-state-contract/50-test-matrix.md
 *
 * Fixture provenance (CONTRIBUTING.md "Fixture provenance (#2371)"): every
 * `.planning/` document shape written by this file's fixture builders is
 * derived from the SHIPPED templates the product author wrote —
 * `gsd-core/templates/roadmap.md` (`## Phases` checkbox bullets,
 * `### Phase N: Name` details with `Plans:` lists, the 4-column and
 * milestone-grouped 5-column `## Progress` tables, and the
 * `Not started | In progress | Complete | Deferred` status vocabulary) and
 * `gsd-core/templates/state.md` (`## Current Position`, `Phase: X of Y
 * (Name)`) — never from `state-contract.cts`'s own parsing model.
 *
 * This module is a NEW leaf; the fixture builders below are local to this
 * file rather than reused from `tests/planning-inspect.test.cjs` (a sibling
 * document-shape consumer) because the shapes this suite needs diverge
 * enough from that file's `## Phase Details` + `Plans:` fixtures that
 * sharing would couple two independent test suites to one mutable helper.
 *
 * These same fixture helpers are also byte-duplicated (not shared) into the
 * `.unit.` sibling above, deliberately: that file is the Stryker mutation
 * shard target and must stay spawn-free and self-contained, so a `require`
 * of this integration file would drag `runGsdTools` and its subprocess seam
 * into the shard. The duplication is isolation, not drift.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, createTempGitProject, createTempDir, cleanup, runGsdTools, homeSandboxEnv } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { stubEnv } = require('./helpers/env-guard.cjs');

const { STATE_CONTRACT_VERSION } = require('../gsd-core/bin/lib/state-contract.cjs');

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function statePathOf(cwd) {
  return path.join(planningDirOf(cwd), 'state.json');
}

function writeAbs(fullPath, content) {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function writeFile(cwd, relPath, content) {
  writeAbs(path.join(cwd, relPath), content);
}

function writeRoadmapRaw(cwd, content) {
  writeFile(cwd, '.planning/ROADMAP.md', content);
}

function writeRoadmap(cwd, lines, eol = '\n') {
  writeRoadmapRaw(cwd, lines.join(eol));
}

function writeState(cwd, frontmatterLines, bodyLines = [], eol = '\n') {
  writeFile(cwd, '.planning/STATE.md', ['---', ...frontmatterLines, '---', '', ...bodyLines].join(eol));
}

function readStateJsonRaw(cwd) {
  return fs.readFileSync(statePathOf(cwd), 'utf8');
}

// ─── 14. Call-site wiring (integration, real CLI) ──────────────────────────────

function writePassedVerification(tmpDir, phaseDirName, phaseToken) {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseDirName);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(phaseDir, `${phaseToken}-VERIFICATION.md`),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
  );
  return phaseDir;
}

const BOUNDARY_COMMANDS = [
  {
    label: 'state begin-phase',
    argv: ['state', 'begin-phase', '--phase', '2', '--name', 'Hardening', '--plans', '2'],
    setup: (tmpDir) => {
      // Body-only STATE.md (no frontmatter block) — begin-phase reads its
      // preconditions from the `**Current Phase:**`-style body fields.
      fs.writeFileSync(path.join(planningDirOf(tmpDir), 'STATE.md'), [
        '# Project State', '',
        '**Current Phase:** 2',
        '**Current Phase Name:** Hardening',
        '**Total Phases:** 3',
        '**Current Plan:** 0',
        '**Total Plans in Phase:** 0',
        '**Status:** Ready to plan',
        '**Last Activity:** 2025-01-01',
        '**Last Activity Description:** setup',
        '',
      ].join('\n'));
    },
  },
  {
    label: 'state planned-phase',
    argv: ['state', 'planned-phase', '--phase', '3', '--name', 'Polish', '--plans', '1'],
    setup: (tmpDir) => {
      fs.writeFileSync(path.join(planningDirOf(tmpDir), 'STATE.md'),
        '# Project State\n\n**Status:** Planning\n**Total Plans in Phase:** 0\n**Last Activity:** 2024-01-01\n**Current Phase:** 3\n');
    },
  },
  {
    label: 'state advance-plan',
    argv: ['state', 'advance-plan'],
    setup: (tmpDir) => {
      fs.writeFileSync(path.join(planningDirOf(tmpDir), 'STATE.md'), [
        '# Project State', '',
        '**Current Plan:** 1',
        '**Total Plans in Phase:** 3',
        '**Status:** Executing',
        '**Last Activity:** 2024-01-10',
        '',
      ].join('\n'));
    },
  },
  {
    label: 'state complete-phase',
    argv: ['state', 'complete-phase', '--phase', '2'],
    setup: (tmpDir) => {
      writeState(tmpDir, ['milestone: v1.0', 'current_phase: 2'], [
        '# State', '',
        '**Status:** Executing',
        '**Last Activity:** 2024-01-15',
        '',
      ]);
    },
  },
  {
    label: 'state milestone-switch',
    argv: ['state', 'milestone-switch', '--milestone', 'v2.0', '--name', 'Next'],
    setup: (tmpDir) => {
      writeState(tmpDir, [
        "gsd_state_version: '1.0'", 'milestone: v1.0', 'milestone_name: Foundation', 'status: completed',
      ], [
        '# Project State', '', '## Current Position', '',
        'Phase: 5 (Foundation) — COMPLETED', 'Plan: 3 of 3',
        'Status: v1.0 milestone complete', 'Last activity: 2025-01-01 -- v1.0 shipped', '',
      ]);
      writeRoadmap(tmpDir, ['# Roadmap', '', '## v1.0 Foundation', '', '### Phase 5: Notify', '']);
      fs.writeFileSync(path.join(planningDirOf(tmpDir), 'config.json'), '{}');
    },
  },
  {
    label: 'phase add',
    argv: ['phase', 'add', 'A new phase'],
    setup: (tmpDir) => {
      writeRoadmap(tmpDir, ['# Roadmap v1.0', '', '### Phase 1: Foundation', '**Goal:** Setup', '', '---', '']);
    },
  },
  {
    label: 'phase add-batch',
    argv: ['phase', 'add-batch', '--descriptions', '["One","Two"]'],
    setup: (tmpDir) => {
      writeRoadmap(tmpDir, ['# Roadmap v1.0', '', '### Phase 1: Foundation', '**Goal:** Setup', '', '---', '']);
    },
  },
  {
    label: 'phase insert',
    argv: ['phase', 'insert', '2', 'An inserted phase'],
    setup: (tmpDir) => {
      writeRoadmap(tmpDir, [
        '# Roadmap', '',
        '### Phase 1: Foundation', '**Goal:** Setup', '**Depends on:** Nothing', '',
        '### Phase 2: Auth', '**Goal:** Authentication', '**Depends on:** Phase 1', '',
      ]);
    },
  },
  {
    label: 'phase remove',
    argv: ['phase', 'remove', '3', '--force'],
    setup: (tmpDir) => {
      writeRoadmap(tmpDir, [
        '# Roadmap', '',
        '### Phase 1: Foundation', '**Goal:** Setup', '**Depends on:** Nothing', '',
        '### Phase 2: Auth', '**Goal:** Authentication', '**Depends on:** Phase 1', '',
        '### Phase 3: Features', '**Goal:** Core features', '**Depends on:** Phase 2', '',
      ]);
      fs.mkdirSync(path.join(planningDirOf(tmpDir), 'phases', '01-foundation'), { recursive: true });
      fs.mkdirSync(path.join(planningDirOf(tmpDir), 'phases', '02-auth'), { recursive: true });
      fs.mkdirSync(path.join(planningDirOf(tmpDir), 'phases', '03-features'), { recursive: true });
    },
  },
  {
    label: 'phase complete',
    argv: ['phase', 'complete', '1'],
    setup: (tmpDir) => {
      writeRoadmap(tmpDir, [
        '# Roadmap', '',
        '- [ ] Phase 1: Foundation', '- [ ] Phase 2: API', '',
        '### Phase 1: Foundation', '**Goal:** Setup', '**Plans:** 1 plans', '',
        '### Phase 2: API', '**Goal:** Build API', '',
      ]);
      fs.writeFileSync(path.join(planningDirOf(tmpDir), 'STATE.md'),
        '# State\n\n**Current Phase:** 01\n**Current Phase Name:** Foundation\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 1\n');
      const p1 = path.join(planningDirOf(tmpDir), 'phases', '01-foundation');
      fs.mkdirSync(p1, { recursive: true });
      fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
      fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
      fs.mkdirSync(path.join(planningDirOf(tmpDir), 'phases', '02-api'), { recursive: true });
      writePassedVerification(tmpDir, '01-foundation', '01');
    },
  },
  {
    label: 'milestone complete',
    // --confirm is the mutation opt-in (#3726) — without it the command
    // refuses before touching anything, and this fixture must genuinely
    // succeed. --force alone does not imply it.
    argv: ['milestone', 'complete', 'v1.1', '--force', '--confirm'],
    setup: (tmpDir) => {
      // --force bypasses both the TRUNCATED-scope guard and the
      // unstarted-phase (no_directory) guard, so this fixture only needs a
      // resolvable v1.1 milestone window with at least one phase entry —
      // the one precondition `getMilestonePhaseFilter`'s
      // `missingExplicitVersion` check enforces unconditionally, before
      // --force is ever consulted.
      writeRoadmap(tmpDir, ['# Roadmap', '', '## v1.1 Hardening', '', '### Phase 1: Foo', '**Goal:** Ship it', '']);
      fs.writeFileSync(path.join(planningDirOf(tmpDir), 'STATE.md'),
        '# Project State\n\n**Status:** Executing\n**Current Phase:** 1\n**Last Activity:** 2025-01-01\n');
    },
  },
];

describe('state contract — call-site wiring (integration, real CLI)', () => {
  test('eachBoundaryCommandPublishesTheSnapshot', () => {
    for (const { label, argv, setup } of BOUNDARY_COMMANDS) {
      const tmpDir = createTempProject();
      setup(tmpDir);
      const result = runGsdTools(argv, tmpDir);
      assert.strictEqual(result.success, true, `${label} fixture must genuinely succeed: ${result.error}`);
      const jsonPath = statePathOf(tmpDir);
      assert.strictEqual(fs.existsSync(jsonPath), true, `${label} must publish state.json`);
      const onDisk = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      assert.strictEqual(onDisk.contract, STATE_CONTRACT_VERSION, `${label}: state.json contract must equal STATE_CONTRACT_VERSION`);
      cleanup(tmpDir);
    }
  });

  test('nonBoundaryCommandDoesNotPublish', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(planningDirOf(tmpDir), 'STATE.md'), '# State\n\n**Status:** Planning\n');
    runGsdTools(['state', 'get', 'status'], tmpDir);
    assert.strictEqual(fs.existsSync(statePathOf(tmpDir)), false);
  });

  test('boundaryCommandUnaffectedWithoutPlanning', (t) => {
    const dirA = createTempDir();
    t.after(() => cleanup(dirA));
    const dirB = createTempDir();
    t.after(() => cleanup(dirB));
    const argv = ['state', 'begin-phase', '--phase', '1', '--name', 'X', '--plans', '1'];
    const resultA = runGsdTools(argv, dirA);
    const resultB = runGsdTools(argv, dirB);
    assert.strictEqual(resultA.success, resultB.success);
    assert.strictEqual(resultA.output, resultB.output);
  });

  test('idempotentNoOpDoesNotRepublish', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(planningDirOf(tmpDir), 'STATE.md'),
      '# Project State\n\n**Status:** Executing\n**Current Phase:** 1\n**Last Activity:** 2024-01-01\n');

    const first = runGsdTools(['state', 'complete-phase', '--phase', '1'], tmpDir);
    assert.ok(first.success, `first complete-phase call failed: ${first.error}`);
    assert.ok(fs.existsSync(statePathOf(tmpDir)), 'first (genuine) completion must publish');
    const beforeSecondCall = readStateJsonRaw(tmpDir);

    const second = runGsdTools(['state', 'complete-phase', '--phase', '1'], tmpDir);
    assert.ok(second.success, `second (idempotent) complete-phase call failed: ${second.error}`);
    const afterSecondCall = readStateJsonRaw(tmpDir);

    assert.strictEqual(afterSecondCall, beforeSecondCall, 'idempotent no-op must not republish (updated_at must not move)');
  });

  test('errorPathDoesNotPublish', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    // No STATE.md at all — complete-phase's own precondition check fails.
    const result = runGsdTools(['state', 'complete-phase', '--phase', '3'], tmpDir);
    assert.ok(result.success, `command should exit 0 with a JSON error envelope: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.error, 'expected a structured error envelope');
    assert.strictEqual(fs.existsSync(statePathOf(tmpDir)), false);
  });

  // #3227 blocker fix: `updated: []` genuine no-op transitions must not
  // publish state.json — a refreshed `updated_at` must always mean something
  // on disk actually moved (design doc §40 row 26). Each case below is a
  // reproducer confirmed (via direct CLI probing) to reach
  // `publishStateContract` on the unfixed code with nothing genuinely written.

  test('plannedPhaseNoOpDoesNotPublish', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## Progress', '',
      '| Phase | Plans Complete | Status | Completed |',
      '|---|---|---|---|',
      '| 1. A | 0/1 | Not started | - |',
      '',
    ]);
    // ADR-3473 §8.7 (#3872) / test-matrix row 17 (D15): `gsd_state_version`
    // is pre-seeded here so this fixture isolates the ONE thing it is meant
    // to prove (zero recognized Current Position labels is a genuine no-op)
    // from an UNRELATED, already-correct §8.7 behavior — a frontmatter block
    // synthesizing `gsd_state_version` for the first time on a document that
    // never had one IS a real, reportable addition (row 17/D15, pinned
    // separately by "state patch accepts JSON object input from workflows"
    // above). Omitting it here would make THIS no-op test fail for a reason
    // that has nothing to do with recognized labels.
    writeState(tmpDir, ['gsd_state_version: 1.0', 'status: planning'], [
      '# Project State', '',
      '(no recognized labels here)',
    ]);
    const result = runGsdTools(['state', 'planned-phase', '--phase', '3', '--name', 'Polish', '--plans', '1'], tmpDir);
    assert.ok(result.success, `planned-phase fixture must genuinely succeed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.updated, [], 'expected a genuine no-op (zero recognized Current Position labels)');
    assert.strictEqual(fs.existsSync(statePathOf(tmpDir)), false, 'a no-op transition must not publish state.json');
  });

  test('beginPhaseNoOpDoesNotPublish', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeRoadmap(tmpDir, ['# Roadmap', '']);
    fs.writeFileSync(path.join(planningDirOf(tmpDir), 'STATE.md'), [
      '# Project State', '',
      '(no recognized labels here)',
      '',
    ].join('\n'));
    const result = runGsdTools(['state', 'begin-phase', '--phase', '3', '--name', 'Polish', '--plans', '1'], tmpDir);
    assert.ok(result.success, `begin-phase fixture must genuinely succeed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.updated, [], 'expected a genuine no-op (zero recognized body fields)');
    assert.strictEqual(fs.existsSync(statePathOf(tmpDir)), false, 'a no-op transition must not publish state.json');
  });

  // Additional no-op path found while auditing `state advance-plan`
  // (cmdStateAdvancePlan, src/state.cts): re-invoking advance-plan while
  // already parked at "last plan, ready for verification" reproduces
  // byte-identical STATE.md content on the SECOND call. MOVED under
  // ADR-3473 §8.7 (#3872): before that change, `reconcileReportedFields`
  // compared the transform's OWN reported fields against the FINAL
  // persisted bytes, so `Status`/`Last Activity` (values the transform
  // always names, which trivially still matched the byte-identical file)
  // came back non-empty even though nothing was written. §8.7 replaced
  // that with a diff against the transaction's PRE-WRITE snapshot, so a
  // genuinely byte-identical second call now correctly reconciles to
  // `updated: []` — a true no-op is reported as a true no-op. Publishing
  // still does not fire on this call: `cmdStateAdvancePlan` gates on
  // `readModifyWriteStateMd`'s own write-happened return value, never on
  // `updated.length`, so this remains a no-op-does-not-publish regression
  // test — only the expected shape of the (now-correct) `updated` moved.
  test('advancePlanNoOpDoesNotPublish', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeRoadmap(tmpDir, ['# Roadmap', '']);
    writeState(tmpDir, ['status: planning'], [
      '# Project State', '',
      'Current Plan: 2', 'Total Plans in Phase: 2', 'Status: Ready to execute', 'Last Activity: 2020-01-01',
      '',
      '## Current Position',
      'Phase: 5', 'Plan: 2 of 2', 'Status: Ready to execute',
      '',
    ]);

    const first = runGsdTools(['state', 'advance-plan'], tmpDir);
    assert.ok(first.success, `first advance-plan call must genuinely succeed: ${first.error}`);
    assert.strictEqual(fs.existsSync(statePathOf(tmpDir)), true, 'first (genuine) advance must publish');
    fs.unlinkSync(statePathOf(tmpDir));

    const second = runGsdTools(['state', 'advance-plan'], tmpDir);
    assert.ok(second.success, `second (no-op) advance-plan call must genuinely succeed: ${second.error}`);
    const output = JSON.parse(second.output);
    assert.deepStrictEqual(output.updated, [], 'ADR-3473 §8.7: a byte-identical second call is a genuine no-op — `updated` must reconcile to empty, not merely reflect fields the transform always names');
    assert.strictEqual(fs.existsSync(statePathOf(tmpDir)), false, 'the second, no-op advance-plan call must not publish state.json');
  });

  // Additional no-op path found while auditing `phase complete`
  // (cmdPhaseComplete, src/phase.cts): with no STATE.md present, a re-run of
  // `phase complete <N>` against an already-completed phase produces a
  // `writes[]` whose only entry (ROADMAP.md) is byte-identical to what's
  // already on disk — `writePlanningFileSet` applies zero writes on the
  // second call, so the fix gates on that applied count rather than
  // publishing unconditionally once the verification-gated transaction runs.
  test('phaseCompleteReRunWithoutStateNoOpDoesNotPublish', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '### Phase 1: Foo', '',
      '**Goal:** g', '**Plans:** 1 plans', '',
      'Plans:', '- [ ] 01 TBD', '',
      '## Progress', '',
      '| Phase | Plans Complete | Status | Completed |',
      '|---|---|---|---|',
      '| 1 | 0/1 | Not started | - |',
      '',
    ]);
    if (fs.existsSync(path.join(planningDirOf(tmpDir), 'STATE.md'))) fs.unlinkSync(path.join(planningDirOf(tmpDir), 'STATE.md'));
    const phaseDir = path.join(planningDirOf(tmpDir), 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-SUMMARY.md'), '# Summary');
    writePassedVerification(tmpDir, '01-foo', '01');

    const first = runGsdTools(['phase', 'complete', '1'], tmpDir);
    assert.ok(first.success, `first phase complete call must genuinely succeed: ${first.error}`);
    assert.strictEqual(fs.existsSync(statePathOf(tmpDir)), true, 'first (genuine) completion must publish');
    fs.unlinkSync(statePathOf(tmpDir));

    const second = runGsdTools(['phase', 'complete', '1'], tmpDir);
    assert.ok(second.success, `second (no-op) phase complete call must genuinely succeed: ${second.error}`);
    assert.strictEqual(fs.existsSync(statePathOf(tmpDir)), false, 'the second, no-op phase complete call must not publish state.json');
  });
});

// #5505: state.json is a derived cache — publishing it must never dirty the tree.
describe('state.json never dirties the tree (#5505)', () => {
  const git = (cwd, ...args) => gitOrThrow(args, { cwd });
  const BEGIN = ['state', 'begin-phase', '--phase', '2', '--name', 'Hardening', '--plans', '2'];
  const STATE_MD = '# Project State\n\n**Current Phase:** 2\n**Current Phase Name:** Hardening\n**Total Phases:** 3\n**Current Plan:** 0\n**Total Plans in Phase:** 0\n**Status:** Ready to plan\n**Last Activity:** 2024-01-01\n';

  // Seeds a committed repo, runs one boundary command, returns paths.
  function boundary(t, { wsName, preTracked, commitDocs, priorIgnore } = {}) {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    // commit_docs false keeps GSD from touching the index, so a tracked copy stays tracked (what W031 reports)
    if (commitDocs === false) fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{"commit_docs": false}\n');
    const dir = wsName ? path.join(tmpDir, '.planning', 'workstreams', wsName) : path.join(tmpDir, '.planning');
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.relative(tmpDir, dir).split(path.sep).join('/');
    fs.writeFileSync(path.join(dir, 'STATE.md'), STATE_MD);
    if (preTracked) fs.writeFileSync(path.join(dir, 'state.json'), '{}\n');
    if (priorIgnore !== undefined) fs.writeFileSync(path.join(dir, '.gitignore'), priorIgnore === true ? 'scratch/\n' : priorIgnore);
    git(tmpDir, 'add', '-A');
    git(tmpDir, 'commit', '-q', '-m', 'seed');
    const r = runGsdTools(wsName ? [...BEGIN, '--ws', wsName] : BEGIN, tmpDir);
    assert.ok(r.success, `boundary command must succeed: ${r.error}`);
    assert.ok(fs.existsSync(path.join(dir, 'state.json')), 'state.json published');
    return { tmpDir, rel };
  }

  test('fresh state.json is ignored and the scoped final commit leaves a clean tree', (t) => {
    const { tmpDir, rel } = boundary(t);
    git(tmpDir, 'check-ignore', '-q', `${rel}/state.json`);
    const c = runGsdTools(['commit', 'docs: final', '--files', `${rel}/STATE.md`], tmpDir);
    assert.ok(c.success, `scoped commit must succeed: ${c.error}`);
    assert.strictEqual(git(tmpDir, 'status', '--porcelain'), '');
  });

  // A scoped commit and a default-mode commit must both carry the migration (the staged removal and the rule file).
  for (const [mode, files] of [['scoped final commit', (rel) => ['--files', `${rel}/STATE.md`]], ['default-mode commit', () => []]]) {
    test(`tracked modified state.json migrates (${mode})`, (t) => {
      const { tmpDir, rel } = boundary(t, { preTracked: true });
      assert.strictEqual(git(tmpDir, 'ls-files', '--', `${rel}/state.json`), '', 'the boundary untracked the copy');
      assert.ok(fs.existsSync(path.join(tmpDir, rel, 'state.json')), 'the file stays on disk');
      fs.appendFileSync(path.join(tmpDir, rel, 'STATE.md'), '\nedited\n');
      const c = runGsdTools(['commit', 'docs: final', ...files(rel)], tmpDir);
      assert.ok(c.success, `final commit must succeed: ${c.error}`);
      assert.strictEqual(git(tmpDir, 'status', '--porcelain'), '', 'no GSD-written file is left behind');
      assert.strictEqual(git(tmpDir, 'ls-files', '--', `${rel}/state.json`), '', 'the removal was committed');
      assert.strictEqual(git(tmpDir, 'ls-files', '--', `${rel}/.gitignore`).trim(), `${rel}/.gitignore`, 'the committed rule was carried');
      const { publishStateContract } = require('../gsd-core/bin/lib/state-contract.cjs');
      assert.strictEqual(publishStateContract(tmpDir).published, true);
      assert.strictEqual(git(tmpDir, 'status', '--porcelain'), '', 'a second boundary is a no-op');
    });
  }

  test('tracked modified state.json migrates beside an already tracked .gitignore (scoped commit)', (t) => {
    const { tmpDir, rel } = boundary(t, { preTracked: true, priorIgnore: true });
    assert.match(git(tmpDir, 'diff', '--cached', '--name-status', '--', `${rel}/.gitignore`), /^M\s/, 'the boundary staged an edit of the tracked rule file');
    fs.appendFileSync(path.join(tmpDir, rel, 'STATE.md'), '\nedited\n');
    const c = runGsdTools(['commit', 'docs: final', '--files', `${rel}/STATE.md`], tmpDir);
    assert.ok(c.success, `final commit must succeed: ${c.error}`);
    assert.strictEqual(git(tmpDir, 'status', '--porcelain'), '', 'the edited rule file was carried');
    assert.match(git(tmpDir, 'show', `HEAD:${rel}/.gitignore`), /^\/state\.json$/m);
  });

  test('a staged edit of a state.json that a negation keeps tracked is not carried', (t) => {
    const { tmpDir, rel } = boundary(t, { preTracked: true });
    fs.mkdirSync(path.join(tmpDir, rel, 'workstreams', 'kept'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, rel, 'workstreams', 'kept', 'STATE.md'), STATE_MD);
    fs.writeFileSync(path.join(tmpDir, rel, 'workstreams', 'kept', 'state.json'), '{}\n');
    git(tmpDir, 'add', '-f', `${rel}/workstreams/kept`);
    git(tmpDir, 'commit', '-q', '-m', 'track kept');
    fs.writeFileSync(path.join(tmpDir, rel, 'workstreams', 'kept', 'state.json'), '{"a":1}\n');
    git(tmpDir, 'add', `${rel}/workstreams/kept/state.json`);
    fs.appendFileSync(path.join(tmpDir, rel, 'STATE.md'), '\nedited\n');
    const c = runGsdTools(['commit', 'docs: final', '--files', `${rel}/STATE.md`], tmpDir);
    assert.ok(c.success, `final commit must succeed: ${c.error}`);
    assert.deepStrictEqual(git(tmpDir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [`${rel}/STATE.md`]);
  });

  test('the migration is carried when the tracked rule file had no final newline', (t) => {
    const { tmpDir, rel } = boundary(t, { preTracked: true, priorIgnore: 'scratch/' });
    fs.appendFileSync(path.join(tmpDir, rel, 'STATE.md'), '\nedited\n');
    const c = runGsdTools(['commit', 'docs: final', '--files', `${rel}/STATE.md`], tmpDir);
    assert.ok(c.success, `final commit must succeed: ${c.error}`);
    assert.strictEqual(git(tmpDir, 'status', '--porcelain'), '');
  });

  // execGit trims stdout: a rule file ending in a blank line, or an empty one, must still read as "only the added rule"
  for (const [shape, priorIgnore] of [['a trailing blank line', 'scratch/\n\n'], ['an empty file', '']]) {
    test(`the migration is carried when the tracked rule file is ${shape}`, (t) => {
      const { tmpDir, rel } = boundary(t, { preTracked: true, priorIgnore });
      fs.appendFileSync(path.join(tmpDir, rel, 'STATE.md'), '\nedited\n');
      const c = runGsdTools(['commit', 'docs: final', '--files', `${rel}/STATE.md`], tmpDir);
      assert.ok(c.success, `final commit must succeed: ${c.error}`);
      assert.strictEqual(git(tmpDir, 'status', '--porcelain'), '');
    });
  }

  test('tracked modified state.json migrates for a workstream copy too', (t) => {
    const { tmpDir, rel } = boundary(t, { wsName: 'ws1', preTracked: true });
    const c = runGsdTools(['commit', 'docs: ws', '--files', `${rel}/STATE.md`], tmpDir);
    assert.ok(c.success, `final commit must succeed: ${c.error}`);
    assert.strictEqual(git(tmpDir, 'status', '--porcelain'), '');
  });

  // The migration is per scope: a sibling workstream copy is untracked only when its own scope allows it.
  test('the migration leaves a sibling workstream copy tracked when its scope opts out or negates the rule', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    const ws = (name) => path.join(tmpDir, '.planning', 'workstreams', name);
    for (const name of ['ws1', 'ws2', 'ws3', 'ws4', 'ws5', 'ws6']) {
      fs.mkdirSync(ws(name), { recursive: true });
      fs.writeFileSync(path.join(ws(name), 'STATE.md'), STATE_MD);
      fs.writeFileSync(path.join(ws(name), 'state.json'), '{}\n');
    }
    fs.writeFileSync(path.join(ws('ws2'), 'config.json'), '{"commit_docs": false}\n');
    fs.writeFileSync(path.join(ws('ws3'), '.gitignore'), '!/state.json\n');
    fs.writeFileSync(path.join(ws('ws4'), 'config.json'), '{"commit_docs": 0}\n'); // the commit policy reads every falsy value as off
    fs.writeFileSync(path.join(ws('ws5'), 'config.json'), '{"commit_docs": null}\n');
    fs.writeFileSync(path.join(ws('ws6'), 'config.json'), '{"commit_docs": ""}\n');
    git(tmpDir, 'add', '-A');
    git(tmpDir, 'commit', '-q', '-m', 'seed');
    assert.ok(runGsdTools([...BEGIN, '--ws', 'ws1'], tmpDir).success);
    assert.strictEqual(git(tmpDir, 'ls-files', '--', '.planning/workstreams/ws1/state.json'), '', 'the active scope migrates');
    for (const name of ['ws2', 'ws3', 'ws4', 'ws5', 'ws6']) {
      assert.strictEqual(git(tmpDir, 'ls-files', '--', `.planning/workstreams/${name}/state.json`).trim(), `.planning/workstreams/${name}/state.json`, `${name} keeps its copy tracked`);
    }
  });

  test('a staged edit of the user\'s own .planning/.gitignore is not carried into a scoped commit', (t) => {
    const { tmpDir, rel } = boundary(t, { preTracked: true, priorIgnore: true });
    fs.appendFileSync(path.join(tmpDir, rel, '.gitignore'), 'mine/\n');
    git(tmpDir, 'add', `${rel}/.gitignore`);
    fs.appendFileSync(path.join(tmpDir, rel, 'STATE.md'), '\nedited\n');
    const c = runGsdTools(['commit', 'docs: final', '--files', `${rel}/STATE.md`], tmpDir);
    assert.ok(c.success, `final commit must succeed: ${c.error}`);
    assert.deepStrictEqual(git(tmpDir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [`${rel}/STATE.md`]);
    assert.match(git(tmpDir, 'diff', '--cached', '--', `${rel}/.gitignore`), /\+mine\//, 'the user\'s staged edit is still staged');
  });

  test('a user negation keeps a tracked state.json tracked', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), STATE_MD);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'state.json'), '{}\n');
    fs.appendFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), '!/.planning/state.json\n');
    git(tmpDir, 'add', '-A');
    git(tmpDir, 'commit', '-q', '-m', 'seed');
    assert.ok(runGsdTools(BEGIN, tmpDir).success);
    assert.strictEqual(git(tmpDir, 'ls-files', '--', '.planning/state.json').trim(), '.planning/state.json');
  });

  test('new-project ignore rule: written before any boundary command', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    cleanup(path.join(tmpDir, '.planning', 'config.json'));
    const r = runGsdTools(['config-new-project', '{}'], tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(r.success, r.error || r.output);
    git(tmpDir, 'check-ignore', '-q', '.planning/state.json');
    git(tmpDir, 'check-ignore', '-q', '.planning/workstreams/ws1/state.json');
    const exclude = path.join(tmpDir, '.git', 'info', 'exclude');
    assert.ok(!fs.existsSync(exclude) || !/state\.json/.test(fs.readFileSync(exclude, 'utf8')), 'the rule is committed content, not a per-clone exclude');
    assert.match(fs.readFileSync(path.join(tmpDir, '.planning', '.gitignore'), 'utf8'), /^\/state\.json$/m);
  });

  test('new-project ignore rule: none is written when .planning/ is already ignored (the commit_docs owner decides)', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    cleanup(path.join(tmpDir, '.planning', 'config.json'));
    fs.appendFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), '.planning\n');
    const r = runGsdTools(['config-new-project', '{}'], tmpDir, homeSandboxEnv(tmpDir));
    assert.ok(r.success, r.error || r.output);
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', '.gitignore')));
  });

  test('new-project ignore rule: a fresh clone keeps the tree clean before any boundary command', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    cleanup(path.join(tmpDir, '.planning', 'config.json'));
    assert.ok(runGsdTools(['config-new-project', '{}'], tmpDir, homeSandboxEnv(tmpDir)).success);
    const c = runGsdTools(['commit', 'chore: add project config', '--files', '.planning/config.json', '.planning/.gitignore'], tmpDir);
    assert.ok(c.success && JSON.parse(c.output).committed, `config commit: ${c.error || c.output}`);
    const cloneRoot = createTempDir('gsd-clone-');
    t.after(() => cleanup(cloneRoot));
    const clone = path.join(cloneRoot, 'clone');
    gitOrThrow(['clone', '-q', tmpDir, clone], { cwd: cloneRoot });
    fs.mkdirSync(path.join(clone, '.planning', 'workstreams', 'ws1'), { recursive: true });
    fs.writeFileSync(path.join(clone, '.planning', 'state.json'), '{}\n');
    fs.writeFileSync(path.join(clone, '.planning', 'workstreams', 'ws1', 'state.json'), '{}\n');
    assert.strictEqual(git(clone, 'status', '--porcelain'), '');
  });

  test('Case B: health W031 names a tracked state.json a boundary left modified, and is silent for an untracked excluded copy', (t) => {
    const { tmpDir, rel } = boundary(t, { wsName: 'ws1', preTracked: true, commitDocs: false });
    const p = `${rel}/state.json`;
    assert.match(git(tmpDir, 'status', '--porcelain', '--', p), /M .*state\.json/, 'the boundary left the tracked copy modified');
    const w031 = (cwd) => JSON.parse(runGsdTools(['validate', 'health'], cwd).output).warnings.find((w) => w.code === 'W031');
    const warning = w031(tmpDir);
    assert.ok(warning, 'validate health must report W031');
    assert.ok(warning.fix.includes(`\`git --literal-pathspecs rm --cached --ignore-unmatch -- ${p}\``), warning.fix);

    const fresh = boundary(t, { wsName: 'ws1' });
    assert.ok(fs.existsSync(path.join(fresh.tmpDir, p)), 'excluded copy is present');
    assert.strictEqual(w031(fresh.tmpDir), undefined, 'an untracked, excluded copy raises no W031');
  });

  test('Case B: W031 for a project nested in its repo says to run from the project directory', (t) => {
    const tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(path.join(sub, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.planning', 'STATE.md'), STATE_MD);
    fs.writeFileSync(path.join(sub, '.planning', 'state.json'), '{}\n');
    git(tmpDir, 'add', '-A');
    git(tmpDir, 'commit', '-q', '-m', 'seed');
    const warning = JSON.parse(runGsdTools(['validate', 'health'], sub).output).warnings.find((w) => w.code === 'W031');
    assert.ok(warning, 'validate health must report W031');
    assert.ok(warning.fix.includes('From the project directory'), warning.fix);
    assert.ok(warning.fix.includes('-- .planning/state.json`'), warning.fix);
  });

  test('commit --files on an untracked, ignored state.json skips it and still commits the rest', (t) => {
    const { tmpDir, rel } = boundary(t);
    fs.appendFileSync(path.join(tmpDir, rel, 'STATE.md'), '\nedited\n');
    const c = runGsdTools(['commit', 'docs: mixed', '--files', `${rel}/state.json`, `${rel}/STATE.md`], tmpDir);
    assert.ok(c.success, `commit must not abort on the ignored path: ${c.error}`);
    const out = JSON.parse(c.output);
    assert.strictEqual(out.committed, true);
    assert.deepStrictEqual(out.skipped_files, [`${rel}/state.json`]);
    assert.strictEqual(git(tmpDir, 'status', '--porcelain'), '');
  });

  test('commit --files skips another workstream\'s ignored state.json when the env selects none', (t) => {
    const { tmpDir, rel } = boundary(t, { wsName: 'ws1' });
    fs.appendFileSync(path.join(tmpDir, rel, 'STATE.md'), '\nedited\n');
    const c = runGsdTools(['commit', 'docs: ws', '--files', `${rel}/state.json`, `${rel}/STATE.md`], tmpDir);
    assert.ok(c.success, `commit must not abort on the ignored path: ${c.error}`);
    assert.deepStrictEqual(JSON.parse(c.output).skipped_files, [`${rel}/state.json`]);
  });

  test('commit --files still fails closed on an ignored, untracked path that is not the derived state.json', (t) => {
    const { tmpDir, rel } = boundary(t);
    fs.appendFileSync(path.join(tmpDir, '.gitignore'), '*.log\n');
    fs.writeFileSync(path.join(tmpDir, rel, 'secret.log'), 'x\n');
    const c = runGsdTools(['commit', 'docs: y', '--files', `${rel}/secret.log`], tmpDir);
    const out = JSON.parse(c.output);
    assert.strictEqual(out.committed, false, 'naming an ignored file must not silently succeed');
    assert.strictEqual(out.reason, 'staging_failed');
    assert.strictEqual(out.skipped_files, undefined);
  });

  test('commit --files still fails closed on an ignored state.json in a directory that is not a project', (t) => {
    const { tmpDir } = boundary(t);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'intel'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'intel', 'state.json'), '{}\n');
    fs.appendFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), '.planning/intel/\n');
    const out = JSON.parse(runGsdTools(['commit', 'docs: z', '--files', '.planning/intel/state.json'], tmpDir).output);
    assert.strictEqual(out.committed, false);
    assert.strictEqual(out.reason, 'staging_failed');
    assert.strictEqual(out.skipped_files, undefined);
  });

  test('commit --files still stages a tracked file that is also ignored', (t) => {
    const { tmpDir, rel } = boundary(t);
    fs.writeFileSync(path.join(tmpDir, rel, 'notes.log'), 'a\n');
    git(tmpDir, 'add', '-f', `${rel}/notes.log`);
    git(tmpDir, 'commit', '-q', '-m', 'track');
    fs.appendFileSync(path.join(tmpDir, '.gitignore'), '*.log\n');
    fs.appendFileSync(path.join(tmpDir, rel, 'notes.log'), 'b\n');
    const c = runGsdTools(['commit', 'docs: n', '--files', `${rel}/notes.log`], tmpDir);
    assert.ok(c.success, `tracked-and-ignored file must stage: ${c.error}`);
    assert.strictEqual(JSON.parse(c.output).committed, true);
  });

  // Input matrix of the `--files` parse the skip branch sits behind: a value that is empty, blank,
  // flag-shaped or full of shell metacharacters is data (skipped like any missing file), never a command.
  const ODD_FILES = [
    ['a blank value', '   '],
    ['a flag-shaped value', '-rf'],
    ['shell metacharacters', '$(touch pwned); `touch pwned2` | x'],
  ];
  for (const [label, value] of ODD_FILES) {
    test(`commit --files with ${label} beside the ignored state.json skips it and commits only the named file`, (t) => {
      const { tmpDir, rel } = boundary(t);
      fs.appendFileSync(path.join(tmpDir, rel, 'STATE.md'), '\nedited\n');
      const c = runGsdTools(['commit', 'docs: odd', '--files', value, `${rel}/state.json`, `${rel}/STATE.md`], tmpDir);
      const out = JSON.parse(c.output);
      assert.strictEqual(out.committed, true, c.output);
      assert.ok(out.skipped_files.includes(`${rel}/state.json`), c.output);
      assert.deepStrictEqual(git(tmpDir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [`${rel}/STATE.md`]);
      assert.ok(!fs.existsSync(path.join(tmpDir, 'pwned')) && !fs.existsSync(path.join(tmpDir, 'pwned2')), 'no shell ran');
      assert.strictEqual(git(tmpDir, 'status', '--porcelain'), '');
    });
  }

  test('commit --files with an empty value fails closed and stages nothing', (t) => {
    const { tmpDir, rel } = boundary(t);
    fs.appendFileSync(path.join(tmpDir, rel, 'STATE.md'), '\nedited\n');
    const out = JSON.parse(runGsdTools(['commit', 'docs: empty', '--files', '', `${rel}/STATE.md`], tmpDir).output);
    assert.strictEqual(out.committed, false);
    assert.strictEqual(out.reason, 'staging_failed');
    assert.strictEqual(git(tmpDir, 'diff', '--cached', '--name-only'), '', 'the index is unchanged');
  });

  test('a repeated --files flag merges its runs: the skip still applies to each', (t) => {
    const { tmpDir, rel } = boundary(t);
    fs.appendFileSync(path.join(tmpDir, rel, 'STATE.md'), '\nedited\n');
    const c = runGsdTools(['commit', 'docs: twice', '--files', `${rel}/state.json`, '--files', `${rel}/STATE.md`], tmpDir);
    const out = JSON.parse(c.output);
    assert.strictEqual(out.committed, true, c.output);
    assert.deepStrictEqual(out.skipped_files, [`${rel}/state.json`]);
    assert.strictEqual(git(tmpDir, 'status', '--porcelain'), '');
  });

  test('workstream state.json is ignored', (t) => {
    const { tmpDir, rel } = boundary(t, { wsName: 'ws1' });
    git(tmpDir, 'check-ignore', '-q', `${rel}/state.json`);
    assert.strictEqual(git(tmpDir, 'status', '--porcelain', '--', `${rel}/state.json`), '');
  });

  test('commit --files of only the ignored, untracked state.json commits nothing and reports it skipped', (t) => {
    const { tmpDir, rel } = boundary(t);
    const out = JSON.parse(runGsdTools(['commit', 'docs: only', '--files', `${rel}/state.json`], tmpDir).output);
    assert.strictEqual(out.committed, false);
    assert.strictEqual(out.reason, 'nothing_to_commit');
    assert.deepStrictEqual(out.skipped_files, [`${rel}/state.json`]);
  });
});

// Whatever the publisher writes, isStateJsonPublishPath must recognise (W031 and `commit --files` rely on it).
describe('publisher output satisfies isStateJsonPublishPath (#5505)', () => {
  const { publishStateContract } = require('../gsd-core/bin/lib/state-contract.cjs');
  const { isStateJsonPublishPath } = require('../gsd-core/bin/lib/core-utils.cjs');
  const scopes = {
    none: {},
    project: { project: 'proj', projectDoc: true },
    workstream: { ws: 'ws1' },
    'project+workstream': { project: 'proj', ws: 'ws1', projectDoc: true },
    'workstreams-only project': { project: 'proj', ws: 'ws1' },
  };
  for (const [name, { project, ws, projectDoc }] of Object.entries(scopes)) {
    test(`publisherOutputIsAPublishPath:${name}`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      stubEnv(t, 'GSD_PROJECT', project);
      stubEnv(t, 'GSD_WORKSTREAM', ws);
      const base = path.join(tmpDir, '.planning', ...(project ? [project] : []));
      fs.mkdirSync(path.join(base, ...(ws ? ['workstreams', ws] : [])), { recursive: true });
      if (projectDoc) fs.writeFileSync(path.join(base, 'STATE.md'), '# State\n');
      assert.strictEqual(publishStateContract(tmpDir).published, true);
      const written = path.join(base, ...(ws ? ['workstreams', ws] : []), 'state.json');
      assert.ok(fs.existsSync(written), 'publisher wrote state.json');
      assert.strictEqual(isStateJsonPublishPath(tmpDir, path.relative(tmpDir, written)), true);
    });
  }

  test('aStateJsonNextToNoProjectFilesOrInGsdsOwnDirectoryIsNotAPublishPath', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'intel'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'workstreams'), { recursive: true });
    for (const rel of ['.planning/intel/state.json', '.planning/workstreams/state.json']) {
      assert.strictEqual(isStateJsonPublishPath(tmpDir, rel), false, rel);
    }
  });
});
