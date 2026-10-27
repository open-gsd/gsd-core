/**
 * Regressions for the round-7 review of #5509 (custom phase ids, #5186).
 * Each group fails on 3d52c7e36d and passes with the round-7 fixes.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createCustomPhaseProject: fixture, runCustomPhaseCommand: run, addCustomPhase: add,
  cleanup, runGsdTools, homeSandboxEnv, createTempProject,
} = require('./helpers.cjs');
const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');

const MIB = 1024 * 1024;

function numericProject(extraConfig = {}) {
  const cwd = fs.realpathSync(createTempProject());
  fs.writeFileSync(path.join(cwd, '.planning/config.json'), JSON.stringify(extraConfig));
  fs.writeFileSync(path.join(cwd, '.planning/ROADMAP.md'),
    '# Roadmap\n\n## Milestone v1.0\n\n### Phase 1: A\n**Goal:** a\n### Phase 2: B\n**Goal:** b\n### Phase 3: C\n**Goal:** c\n');
  fs.writeFileSync(path.join(cwd, '.planning/STATE.md'), '# State\n\nPhase: 1\n');
  for (const dir of ['01-a', '02-b', '03-c']) fs.mkdirSync(path.join(cwd, '.planning/phases', dir));
  return cwd;
}
const phases = cwd => fs.readdirSync(path.join(cwd, '.planning/phases')).sort();

// ── Major 1: prose parsing accepts only recorded or roadmap-listed ids ──────
for (const prose of ['complete', 'None', 'TBD']) {
  test(`custom prose identity: STATE "Phase: ${prose}" is not a phase id`, () => {
    const cwd = fixture(null);
    try {
      add(cwd, 'SETUP');
      const statePath = path.join(cwd, '.planning/STATE.md');
      fs.writeFileSync(statePath, `# State\n\nPhase: ${prose}\n\n**Status:** x\n`);
      const state = run(cwd, ['state', 'json']);
      assert.equal(state.current_phase, undefined);
      const before = fs.readFileSync(statePath, 'utf8');
      const result = runGsdTools(['state', 'complete-phase'], cwd, homeSandboxEnv(cwd));
      assert.match(result.output + (result.error || ''), /Unable to resolve current phase/);
      assert.equal(fs.readFileSync(statePath, 'utf8'), before);
    } finally { cleanup(cwd); }
  });
}
test('custom prose identity: a recorded id in STATE prose still resolves', () => {
  const cwd = fixture(null);
  try {
    add(cwd, 'SETUP');
    fs.writeFileSync(path.join(cwd, '.planning/STATE.md'), '# State\n\nPhase: SETUP\n\n**Status:** x\n');
    assert.equal(run(cwd, ['state', 'json']).current_phase, 'SETUP');
  } finally { cleanup(cwd); }
});

// ── Major 2: non-custom projects keep their pre-#5186 behaviour ─────────────
test('numeric phase remove: query 02 does not delete the unpadded Phase 2 heading', () => {
  const cwd = numericProject();
  try {
    run(cwd, ['phase', 'remove', '02', '--force']);
    const roadmap = fs.readFileSync(path.join(cwd, '.planning/ROADMAP.md'), 'utf8');
    assert.match(roadmap, /### Phase 2: B/);
  } finally { cleanup(cwd); }
});
test('numeric phase remove: a bare 01 beside 01-a still refuses as ambiguous', () => {
  const cwd = numericProject();
  try {
    fs.mkdirSync(path.join(cwd, '.planning/phases/01'));
    const result = run(cwd, ['phase', 'remove', '01', '--force']);
    assert.equal(result.removed, null);
    assert.deepEqual(result.ambiguous_matches, ['01', '01-a']);
    assert.deepEqual(phases(cwd), ['01', '01-a', '02-b', '03-c']);
  } finally { cleanup(cwd); }
});
test('numeric scaffold phase-dir: an existing directory is reused, not refused', () => {
  const cwd = numericProject();
  try {
    const result = run(cwd, ['scaffold', 'phase-dir', '--phase', '2', '--name', 'b']);
    assert.equal(result.created, true);
    assert.deepEqual(phases(cwd), ['01-a', '02-b', '03-c']);
  } finally { cleanup(cwd); }
});
test('milestone-prefixed state complete-phase keeps reading the dotted phase id', () => {
  const cwd = numericProject({phase_id_convention: 'milestone-prefixed'});
  try {
    fs.writeFileSync(path.join(cwd, '.planning/STATE.md'), '# State\n\n**Current Phase:** 3-01 (X)\n');
    assert.equal(run(cwd, ['state', 'complete-phase']).phase, '3');
  } finally { cleanup(cwd); }
});

// ── Major 3: boundary coverage (limit-1, limit, limit+1) ────────────────────
for (const [id, refused] of [['998', false], ['999', true], ['1000', false]]) {
  test(`custom hidden identity boundary: ${id} ${refused ? 'is refused' : 'is accepted'}`, () => {
    const cwd = fixture(null);
    try {
      const result = runGsdTools(['--json-errors', 'phase', 'add', 'Edge', '--id', id], cwd, homeSandboxEnv(cwd));
      assert.equal(result.success, !refused, result.output + (result.error || ''));
      if (!refused) assert.equal(run(cwd, ['find-phase', id]).found, true);
    } finally { cleanup(cwd); }
  });
}
for (const [size, honoured] of [[1023, true], [1024, true], [1025, false]]) {
  test(`custom marker bound: a ${size}-byte .phase-id is ${honoured ? 'read' : 'ignored'}`, () => {
    // Markerless, SETUP-2-b belongs to the longer declared SETUP-2; only a
    // honoured marker can hand it to SETUP.
    const cwd = fixture(null, 'custom', '# Roadmap\n\n## Milestone v1.0\n\n### Phase SETUP: S\n### Phase SETUP-2: S2\n');
    try {
      const dir = path.join(cwd, '.planning/phases/SETUP-2-b');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '.phase-id'), 'SETUP'.padEnd(size, ' '));
      assert.equal(run(cwd, ['find-phase', 'SETUP']).found, honoured);
    } finally { cleanup(cwd); }
  });
}
for (const [colonIndex, listed] of [[MIB - 2, true], [MIB - 1, true], [MIB, false]]) {
  test(`custom roadmap bound: a heading id ending at byte ${colonIndex} is ${listed ? 'listed' : 'beyond the read'}`, () => {
    const head = '# Roadmap\n\n## Milestone v1.0\n\n';
    const tail = '### Phase LATE';
    const filler = 'a'.repeat(colonIndex - head.length - tail.length - 2) + '\n\n';
    const roadmap = `${head}${filler}${tail}:`;
    assert.equal(roadmap.indexOf(':'), colonIndex);
    const cwd = fixture(null, 'custom', `${roadmap} Late\n`);
    try {
      fs.writeFileSync(path.join(cwd, '.planning/STATE.md'), '# State\n\nPhase: LATE\n\n**Status:** x\n');
      assert.equal(run(cwd, ['state', 'json']).current_phase, listed ? 'LATE' : undefined);
    } finally { cleanup(cwd); }
  });
}

// ── Minor 4: one selector decides what `phase remove` refuses on ────────────
function ambiguousOwnerProject() {
  const cwd = fixture(null, 'custom',
    '# Roadmap\n\n## Milestone v1.0\n\n### Phase 6: Six\n### Phase 6-a: Six A\n### Phase 2: Two\n### Phase 2.1: Child\n');
  for (const dir of ['02-two', '02.1-child', '02.2-other', '6-a-b']) fs.mkdirSync(path.join(cwd, '.planning/phases', dir));
  return cwd;
}
test('phase remove: a decimal removal ignores an ambiguous directory its renamer never touches', () => {
  const cwd = ambiguousOwnerProject();
  try {
    const result = run(cwd, ['phase', 'remove', '2.1', '--force']);
    assert.equal(result.directory_deleted, '02.1-child');
    assert.deepEqual(result.renamed_directories, [{from: '02.2-other', to: '02.1-other'}]);
  } finally { cleanup(cwd); }
});
test('phase remove: an integer removal the renamer would reach refuses before any write', () => {
  const cwd = ambiguousOwnerProject();
  try {
    const before = phases(cwd);
    const result = runGsdTools(['--json-errors', 'phase', 'remove', '1', '--force'], cwd, homeSandboxEnv(cwd));
    assert.equal(result.success, false, result.output);
    assert.equal(JSON.parse(result.error).reason, 'ambiguous_phase_owner');
    assert.deepEqual(phases(cwd), before);
  } finally { cleanup(cwd); }
});

// ── Minor 5: the custom comparator is a total preorder ──────────────────────
test('comparePhaseNum is a total preorder over mixed custom and numeric ids', () => {
  const roadmap = '# Roadmap\n\n### Phase 2: Two\n### Phase API: Api\n### Phase 1: One\n### Phase SETUP: Setup\n';
  const context = phaseId.phaseDirectoryContext({phase_naming: 'custom'}, roadmap);
  const ids = ['2', '02', 'API', '1', '01', 'SETUP', '5', '05', '7B', '10', 'ZED'];
  const cmp = (a, b) => Math.sign(phaseId.comparePhaseNum(a, b, context)) || 0;
  for (const a of ids) for (const b of ids) {
    assert.equal(cmp(a, b) + cmp(b, a), 0, `antisymmetry ${a} ${b}`);
    for (const c of ids) {
      if (cmp(a, b) <= 0 && cmp(b, c) <= 0) assert.ok(cmp(a, c) <= 0, `transitivity ${a} ${b} ${c}`);
    }
  }
  assert.deepEqual(['SETUP', '1', 'API', '2'].sort(cmp), ['2', 'API', '1', 'SETUP']);
  assert.equal(cmp('02', '2'), 0);
});

// ── Minor 8: ids drawn from the grammar, not a closed alphabet ──────────────
test('custom round trip: grammar-generated ids resolve or are refused with a typed reason', () => {
  const fc = require('fast-check');
  const idArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,6}(-[A-Za-z0-9]{1,4}){0,2}$/);
  fc.assert(fc.property(idArb, fc.boolean(), (id, prefixed) => {
    const code = prefixed ? 'CCM' : null;
    const cwd = fixture(code);
    try {
      const added = runGsdTools(['--json-errors', 'phase', 'add', 'Gen', '--id', id], cwd, homeSandboxEnv(cwd));
      if (!added.success) {
        assert.ok(['phase_id_collision', 'usage'].includes(JSON.parse(added.error).reason), added.error);
        assert.deepEqual(fs.readdirSync(path.join(cwd, '.planning/phases')), []);
        return;
      }
      const found = run(cwd, ['find-phase', id]);
      assert.equal(found.found, true, `${id} was written but cannot be found`);
      assert.equal(found.directory, JSON.parse(added.output).directory);
    } finally { cleanup(cwd); }
  }), {numRuns: 25, seed: 5186});
});

// ── Addendum: the default-context path of the changed locator signatures ────
test('phase locator: findPhaseInternal and searchPhaseInDir resolve numeric phases without a context argument', () => {
  const locator = require('../gsd-core/bin/lib/phase-locator.cjs');
  const cwd = numericProject();
  try {
    assert.equal(locator.findPhaseInternal(cwd, '2').directory, '.planning/phases/02-b');
    const phasesDir = path.join(cwd, '.planning/phases');
    assert.equal(locator.searchPhaseInDir(phasesDir, '.planning/phases', '03').directory, '.planning/phases/03-c');
    assert.equal(locator.findPhaseInternal(cwd, '9'), null);
  } finally { cleanup(cwd); }
});
