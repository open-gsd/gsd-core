'use strict';
/**
 * Regression test for bug #1514:
 * A retired/folded phase (struck through in ROADMAP, marked `[x]`, with a
 * directory but no completion artifact) must NOT be counted in
 * progress.total_phases. Otherwise it inflates the denominator without ever
 * satisfying the numerator (no SUMMARY → never "completed"), freezing a
 * fully-shipped milestone below 100%.
 *
 * Root cause:
 *   buildStateFrontmatter (state.cts) derived total_phases from
 *   max(phaseDirs.length, roadmapPhaseCount) — both of which counted the
 *   retired phase (its directory and its `### Phase NN:` heading) — while
 *   completed_phases came from a disk SUMMARY scan that the retired phase
 *   can never satisfy. Same counting family as #549 / #500 / #1445.
 *
 * Fix:
 *   buildStateFrontmatter now extracts retired phase numbers from the GFM
 *   strikethrough in the current-milestone ROADMAP scope and excludes them
 *   from BOTH the disk phase-dir set and the heading count, so a retired
 *   phase counts toward neither denominator nor numerator.
 *
 * Why integration (state json) not a unit test: the bug only manifests in the
 * assembled progress block a shipped milestone actually writes to STATE.md, so
 * the test reproduces that artifact rather than a helper in isolation.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { _extractRetiredPhaseNumbers } = require('../gsd-core/bin/lib/state.cjs');
const { normalizePhaseName } = require('../gsd-core/bin/lib/phase-id.cjs');

// Six phases, all shipped, except Phase 04 which is retired/folded into 05.
// Phases 01-03,05,06 have PLAN+SUMMARY (complete); Phase 04 keeps a directory
// but no work (retired). `complete` flags which dirs get PLAN+SUMMARY.
function seedProject(prefix, roadmap, completeDirs) {
  const tmpDir = createTempProject(prefix);
  const planning = path.join(tmpDir, '.planning');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmap, 'utf-8');
  fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
  fs.writeFileSync(
    path.join(planning, 'STATE.md'),
    [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.0',
      'status: executing',
      '---',
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Current Phase: 6',
      'Status: shipped',
      'Last Activity: 2026-06-01',
    ].join('\n'),
    'utf-8',
  );
  const allDirs = ['01-alpha', '02-beta', '03-gamma', '04-delta', '05-epsilon', '06-zeta'];
  for (const d of allDirs) {
    const dir = path.join(planning, 'phases', d);
    fs.mkdirSync(dir, { recursive: true });
    if (completeDirs.includes(d)) {
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
    }
  }
  return tmpDir;
}

const PHASE_DETAILS = [
  '### Phase 01: Alpha', '**Goal:** a', '',
  '### Phase 02: Beta', '**Goal:** b', '',
  '### Phase 03: Gamma', '**Goal:** c', '',
  '### Phase 04: Delta', '**Goal:** GOAL_04', '',
  '### Phase 05: Epsilon', '**Goal:** e', '',
  '### Phase 06: Zeta', '**Goal:** f',
];

function roadmap(checklist04, goal04) {
  return [
    '## Milestone v1.0: Repro',
    '',
    '### Phases',
    '- [x] **Phase 01: Alpha** — done',
    '- [x] **Phase 02: Beta** — done',
    '- [x] **Phase 03: Gamma** — done',
    checklist04,
    '- [x] **Phase 05: Epsilon** — done',
    '- [x] **Phase 06: Zeta** — done',
    '',
    ...PHASE_DETAILS.map((l) => (l === '**Goal:** GOAL_04' ? `**Goal:** ${goal04}` : l)),
  ].join('\n');
}

const ALL_COMPLETE = ['01-alpha', '02-beta', '03-gamma', '05-epsilon', '06-zeta'];

describe('bug #1514 — retired/folded phase excluded from progress.total_phases', () => {
  let tmpDir;
  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = undefined;
  });

  test('struck `[x] ~~Phase 04~~ — folded into Phase 05` → 5/5, percent 100 (not 5/6, 83)', () => {
    const rm = roadmap(
      '- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired',
      'folded into Phase 05',
    );
    tmpDir = seedProject('bug-1514-a-', rm, ALL_COMPLETE);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 5, `total_phases must exclude the retired phase. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 5, `completed_phases must be 5. Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `shipped milestone must reach 100%. Got ${progress.percent}`);
  });

  test('fold TARGET is not retired: a struck goal line `~~folded into Phase 05~~` must not drop Phase 05', () => {
    // Phase 04 retired via checklist; Phase 04 *goal* also struck and mentions
    // the fold target. The target (Phase 05) must remain a counted phase.
    const rm = roadmap(
      '- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired',
      '~~folded into Phase 05; retired~~',
    );
    tmpDir = seedProject('bug-1514-b-', rm, ALL_COMPLETE);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 5, `only Phase 04 is retired; Phase 05 must still count. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 5, `completed_phases must be 5. Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `Got ${progress.percent}`);
  });

  test('regression: no strikethrough → all 6 phases counted (6/6, 100)', () => {
    const rm = roadmap('- [x] **Phase 04: Delta** — done', 'd');
    tmpDir = seedProject('bug-1514-c-', rm, [...ALL_COMPLETE, '04-delta']);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 6, `no retired phase: all 6 counted. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 6, `Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `Got ${progress.percent}`);
  });

  // `state sync --verify` is the SECOND counting path (cmdStateSync). Before the
  // fix it re-derived the same inflated denominator and reported "no drift",
  // so a manual STATE edit was the only recourse (#1514). It must now agree
  // with state json and drive the stuck 83% Progress field to 100%.
  test('state sync --verify drives a stuck 83% Progress to 100% (cmdStateSync path)', () => {
    const rm = roadmap(
      '- [x] ~~**Phase 04: Delta**~~ — folded into Phase 05; number retired',
      'folded into Phase 05',
    );
    tmpDir = seedProject('bug-1514-sync-', rm, ALL_COMPLETE);
    // Seed a stuck Progress line that the inflated denominator would "agree" with.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.appendFileSync(statePath, '\nProgress: [████████░░] 83%\n', 'utf-8');
    const result = runGsdTools(['state', 'sync', '--verify'], tmpDir);
    assert.ok(result.success, `state sync --verify failed: ${result.error}`);
    const { changes } = JSON.parse(result.output);
    const progressChange = (changes || []).find((c) => /Progress:/.test(c));
    assert.ok(progressChange, `expected a Progress drift, got changes: ${JSON.stringify(changes)}`);
    assert.match(progressChange, /-> .*100%/, `sync must want 100%, got: ${progressChange}`);
  });
});

// ─── Generic seeder for non-canonical phase shapes ──────────────────────────

/**
 * Seed a project from explicit phase specs so project-code, decimal,
 * no-directory, and shipped-then-retired shapes can be exercised.
 * spec: { id, retired?, dir?, shipped? }
 *   id      — ROADMAP phase id (e.g. '04', '05.1', 'PROJ-42')
 *   retired — strike the checklist entry (folded/retired)
 *   dir     — directory name to create (omit → no directory)
 *   shipped — write PLAN+SUMMARY into the directory (complete)
 */
function seedFromSpecs(prefix, specs) {
  const tmpDir = createTempProject(prefix);
  const planning = path.join(tmpDir, '.planning');
  const checklist = specs.map((s) =>
    s.retired
      ? `- [x] ~~**Phase ${s.id}: P${s.id}**~~ — retired`
      : `- [x] **Phase ${s.id}: P${s.id}** — done`,
  );
  const details = specs.flatMap((s) => [`### Phase ${s.id}: P${s.id}`, '**Goal:** g', '']);
  const roadmapText = ['## Milestone v1.0: Specs', '', '### Phases', ...checklist, '', ...details].join('\n');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmapText, 'utf-8');
  fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
  fs.writeFileSync(
    path.join(planning, 'STATE.md'),
    ['---', 'gsd_state_version: 1.0', 'milestone: v1.0', 'status: executing', '---', '', '# GSD State', '', '## Configuration', 'Current Phase: 1'].join('\n'),
    'utf-8',
  );
  for (const s of specs) {
    if (!s.dir) continue;
    const dir = path.join(planning, 'phases', s.dir);
    fs.mkdirSync(dir, { recursive: true });
    if (s.shipped) {
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
    }
  }
  return tmpDir;
}

describe('bug #1514 — retired exclusion across phase shapes', () => {
  let tmpDir;
  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = undefined;
  });

  test('project-code retired phase is dropped from the denominator (Phase PROJ-42)', () => {
    // Project-code dirs are not milestone-mapped for completion counts (a
    // separate pre-existing limitation), so assert only the total_phases
    // denominator, which #1514 governs: the struck PROJ-42 heading must not
    // be counted, while PROJ-41 / PROJ-43 still are.
    tmpDir = seedFromSpecs('bug-1514-pc-', [
      { id: 'PROJ-41', dir: 'PROJ-41-a', shipped: true },
      { id: 'PROJ-42', retired: true, dir: 'PROJ-42-d' },
      { id: 'PROJ-43', dir: 'PROJ-43-c', shipped: true },
    ]);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 2, `retired project-code phase must be excluded. Got ${progress.total_phases}`);
  });

  test('decimal, multiple, shipped-then-retired, and no-directory retired phases all excluded', () => {
    // Retired: 02 (executed → has SUMMARY, then folded), 04 (no work),
    // 05.1 (decimal, no directory at all). Live: 01, 03, 06.
    tmpDir = seedFromSpecs('bug-1514-multi-', [
      { id: '01', dir: '01-a', shipped: true },
      { id: '02', retired: true, dir: '02-b', shipped: true },
      { id: '03', dir: '03-c', shipped: true },
      { id: '04', retired: true, dir: '04-d' },
      { id: '05.1', retired: true },
      { id: '06', dir: '06-f', shipped: true },
    ]);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 3, `3 retired of 6 → total 3. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 3, `live phases 01/03/06 complete. Got ${progress.completed_phases}`);
    assert.equal(progress.percent, 100, `Got ${progress.percent}`);
  });

  test('boundary: every phase retired (k === n) → total_phases 0', () => {
    tmpDir = seedFromSpecs('bug-1514-all-', [
      { id: '01', retired: true, dir: '01-a' },
      { id: '02', retired: true, dir: '02-b' },
      { id: '03', retired: true, dir: '03-c' },
    ]);
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 0, `all phases retired → denominator 0. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 0, `Got ${progress.completed_phases}`);
  });

  test('strikethrough in a non-checklist/heading line (a goal) does NOT retire that phase', () => {
    // Detection is scoped to checklist/heading lines, so a struck GOAL line
    // that begins with a phase reference must not retire it.
    const tmp = createTempProject('bug-1514-prose-');
    const planning = path.join(tmp, '.planning');
    const roadmapText = [
      '## Milestone v1.0: Prose',
      '',
      '### Phases',
      '- [x] **Phase 01: A** — done',
      '- [x] **Phase 02: B** — done',
      '- [x] **Phase 03: C** — done',
      '',
      '### Phase 01: A', '**Goal:** g',
      '### Phase 02: B', '**Goal:** ~~Phase 02 was renamed from an earlier plan~~',
      '### Phase 03: C', '**Goal:** g',
    ].join('\n');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmapText, 'utf-8');
    fs.writeFileSync(path.join(planning, 'config.json'), '{}', 'utf-8');
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      ['---', 'gsd_state_version: 1.0', 'milestone: v1.0', 'status: executing', '---', '', '# GSD State', '', '## Configuration', 'Current Phase: 3'].join('\n'),
      'utf-8',
    );
    for (const d of ['01-a', '02-b', '03-c']) {
      const dir = path.join(planning, 'phases', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'PLAN.md'), '# Plan\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n', 'utf-8');
    }
    tmpDir = tmp;
    const result = runGsdTools(['state', 'json'], tmpDir);
    assert.ok(result.success, `state json failed: ${result.error}`);
    const { progress } = JSON.parse(result.output);
    assert.equal(progress.total_phases, 3, `struck prose in a goal line must not retire Phase 02. Got ${progress.total_phases}`);
    assert.equal(progress.completed_phases, 3, `Got ${progress.completed_phases}`);
  });
});

// ─── Property: the strikethrough parser extracts exactly the struck set ──────

// extractRetiredPhaseNumbers is the parsing/transformation core of the fix, so
// per RULESET.TESTS.property-based-testing it carries a fast-check property:
// for a roadmap with k of n checklist phases struck, the parser must return
// exactly the canonical keys of those k phases — no more, no fewer — across
// randomized phase counts and numeric/zero-padded/project-code ID forms. This
// underpins the `total_phases === n - k` guarantee the integration tests assert.
describe('bug #1514 — extractRetiredPhaseNumbers property: returns exactly the struck set', () => {
  const idForm = (num, form) =>
    form === 'padded' ? String(num).padStart(2, '0')
      : form === 'project' ? `PROJ-${num}`
        : String(num);
  const keyOf = (num, form) => normalizePhaseName(idForm(num, form)).toUpperCase();

  test('k-of-n struck phases → exactly k canonical keys, for any n/form', () => {
    fc.assert(
      fc.property(
        // Distinct phase numbers so canonical keys don't collide within a run.
        fc.uniqueArray(fc.integer({ min: 1, max: 98 }), { minLength: 1, maxLength: 10 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
        fc.constantFrom('plain', 'padded', 'project'),
        (nums, flagsRaw, form) => {
          const lines = ['## Milestone v1.0: M', '', '### Phases'];
          const struck = [];
          nums.forEach((num, i) => {
            const id = idForm(num, form);
            if (flagsRaw[i]) {
              lines.push(`- [x] ~~**Phase ${id}: P${num}**~~ — folded; retired`);
              struck.push(num);
            } else {
              lines.push(`- [x] **Phase ${id}: P${num}** — done`);
            }
          });

          const got = _extractRetiredPhaseNumbers(lines.join('\n'));
          const expected = new Set(struck.map((num) => keyOf(num, form)));

          assert.equal(got.size, expected.size, `size: got ${got.size}, expected ${expected.size}`);
          for (const k of expected) assert.ok(got.has(k), `missing struck key ${k}`);
          for (const k of got) assert.ok(expected.has(k), `extra (non-struck) key ${k}`);
        },
      ),
    );
  });
});
