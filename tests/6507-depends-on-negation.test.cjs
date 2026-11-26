'use strict';

/**
 * 6507-depends-on-negation.test.cjs — a "Depends on" line that starts with
 * Nothing/None must yield no dependencies no matter what explanation trails.
 *
 * #6507: init manager read "Nothing (independent of Phases 1 and 3)" as a
 * dependency list because token extraction ran over the whole field. The
 * lead-negation rule now lives in the shared owner src/phase-id.cts, so init
 * manager and `planning inspect` agree by construction — the parity rows
 * prove that on the inspect payload; the guard rows pin that genuine lists
 * still extract and the bare payload shape stays byte-identical; the
 * inverted pin fixes that a lead negation wins over a trailing dependency;
 * the property row pins the shared owner predicate; the doc rows pin the
 * machine-read rule in the three writer documents.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { generateSlugInternal } = require('../gsd-core/bin/lib/core-utils.cjs');
const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');

const ROOT = path.join(__dirname, '..');
const ROADMAPPER_DOC = path.join(ROOT, 'agents', 'gsd-roadmapper.md');
const ADD_PHASE_DOC = path.join(ROOT, 'gsd-core', 'workflows', 'add-phase.md');
const EDIT_PHASE_DOC = path.join(ROOT, 'gsd-core', 'workflows', 'edit-phase.md');

// Harness mirrors tests/init-manager.test.cjs (local copy: the rule under
// test is the Depends-on line, so the fixture is deliberately minimal).
function writeRoadmap(tmpDir, phases) {
  const sections = phases.map((p) => {
    let section = `### Phase ${p.number}: ${p.name}\n\n**Goal:** ${p.goal || 'Do the thing'}\n`;
    if (p.depends_on !== undefined) section += `**Depends on:** ${p.depends_on}\n`;
    return section;
  }).join('\n');
  const checklist = phases
    .map((p) => `- [${p.complete ? 'x' : ' '}] **Phase ${p.number}: ${p.name}**`)
    .join('\n');
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap\n\n## Progress\n\n${checklist}\n\n${sections}`,
  );
}

function writeState(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    '---\nstatus: active\n---\n# State\n',
  );
}

function managerRows(tmpDir) {
  const result = runGsdTools('init manager', tmpDir);
  assert.equal(result.success, true, `init manager failed: ${result.error}`);
  return JSON.parse(result.output).phases;
}

function rowFor(rows, number) {
  const row = rows.find((r) => r.number === number);
  assert.ok(row, `manager must report phase ${number}`);
  return row;
}

// `planning inspect` scopes phase sections by milestone window, so the
// writer above (no milestone heading, init-manager-shaped) cannot produce an
// inspect phase row. These mirror tests/planning-inspect.test.cjs's minimal
// fixture exactly: STATE milestone frontmatter, `## v1.0 Current 🚧` window,
// `## Phases` checkboxes, and a created slugged phase dir (a declared-but-
// absent directory silently yields an empty phases[]).
function inspectSlugDir(token, name) {
  return `${String(token).padStart(2, '0')}-${generateSlugInternal(name, null) ?? ''}`;
}

function writeInspectFixture(tmpDir, phases) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    "---\ngsd_state_version: '1.0'\nstatus: planning\nmilestone: v1.0\n---\n",
  );
  const lines = ['## v1.0 Current 🚧', '', '## Phases', ''];
  for (const p of phases) lines.push(`- [ ] **Phase ${p.number}: ${p.name}** - stub`);
  lines.push('');
  for (const p of phases) {
    lines.push(`### Phase ${p.number}: ${p.name}`, '');
    if (p.depends_on) lines.push(`**Depends on:** ${p.depends_on}`, '');
  }
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), lines.join('\n'));
  for (const p of phases) {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', inspectSlugDir(p.number, p.name)), { recursive: true });
  }
}

function inspectRow(tmpDir, number, name) {
  const result = runGsdTools(['query', 'planning', 'inspect'], tmpDir);
  assert.equal(result.success, true, `planning inspect failed: ${result.error}`);
  const dir = inspectSlugDir(number, name);
  const row = JSON.parse(result.output).phases.find((r) => r.dir === dir);
  assert.ok(row, `inspect must report phase dir ${dir}`);
  return row;
}

describe('init manager: negated Depends-on prose is not a dependency list (#6507)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject('6507-mgr-'); });
  afterEach(() => cleanup(tmpDir));

  test('"Nothing (independent of Phases 1 and 3)" yields no dependencies (AC1)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'One' },
      { number: '2', name: 'Two', depends_on: 'Nothing (independent of Phases 1 and 3)' },
      { number: '3', name: 'Three' },
    ]);
    const row = rowFor(managerRows(tmpDir), '2');
    assert.deepEqual(row.dep_phases, [], 'negated prose must not become dependencies');
    assert.equal(row.deps_satisfied, true);
  });

  test('"None (does not wait for Phase 1)" yields no dependencies (AC1)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'One' },
      { number: '2', name: 'Two', depends_on: 'None (does not wait for Phase 1)' },
    ]);
    const row = rowFor(managerRows(tmpDir), '2');
    assert.deepEqual(row.dep_phases, [], 'negated prose must not become dependencies');
    assert.equal(row.deps_satisfied, true);
  });

  test('"Nothing except Phase 1" still yields no dependencies (inverted-failure pin)', () => {
    // Maintainer review Finding 2: a lead negation wins even over a trailing
    // real dependency — writers use a plain list when a dependency exists,
    // so the lead carries the contract. This pins that choice.
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'One' },
      { number: '2', name: 'Two', depends_on: 'Nothing except Phase 1' },
    ]);
    const row = rowFor(managerRows(tmpDir), '2');
    assert.deepEqual(row.dep_phases, [], 'the negated lead wins over the trailing token');
    assert.equal(row.deps_satisfied, true);
  });

  test('a plain list still extracts fully (AC2 guard)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'One' },
      { number: '2', name: 'Two' },
      { number: '3', name: 'Three', depends_on: 'Phase 1, Phase 2' },
    ]);
    const row = rowFor(managerRows(tmpDir), '3');
    assert.deepEqual(row.dep_phases, ['1', '2']);
    assert.equal(row.deps_satisfied, false);
  });

  test('"Phases 601 and 602" extracts both tokens (AC2 guard)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '601', name: 'SixOhOne' },
      { number: '602', name: 'SixOhTwo' },
      { number: '7', name: 'Seven', depends_on: 'Phases 601 and 602' },
    ]);
    const row = rowFor(managerRows(tmpDir), '7');
    assert.deepEqual(row.dep_phases, ['601', '602']);
    assert.equal(row.deps_satisfied, false);
  });

  test('"Phase 1-3" extracts the range endpoints (AC2 guard, #4764 rule)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'One' },
      { number: '2', name: 'Two' },
      { number: '3', name: 'Three' },
      { number: '4', name: 'Four', depends_on: 'Phase 1-3' },
    ]);
    const row = rowFor(managerRows(tmpDir), '4');
    assert.deepEqual(row.dep_phases, ['1', '3']);
  });

  test('bare "Nothing" keeps its current payload shape (AC3)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'One' },
      { number: '2', name: 'Two', depends_on: 'Nothing' },
    ]);
    const row = rowFor(managerRows(tmpDir), '2');
    assert.equal(row.deps_satisfied, true);
    assert.deepEqual(row.dep_phases, [], 'bare Nothing has always carried an empty dep_phases');
  });

  test('bare "None" keeps its current payload shape (AC3)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'One' },
      { number: '2', name: 'Two', depends_on: 'None' },
    ]);
    const row = rowFor(managerRows(tmpDir), '2');
    assert.equal(row.deps_satisfied, true);
    assert.equal('dep_phases' in row, false, 'the exact-none short-circuit never set dep_phases; the fix must not add it');
  });
});

describe('bracket convention behaves the same (#6507 AC4)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject('6507-brk-');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'CK', phase_id_convention: 'bracket' }, null, 2) + '\n',
    );
    writeState(tmpDir);
  });
  afterEach(() => cleanup(tmpDir));

  function writeBracketRoadmap(phases) {
    const sections = phases
      .map(
        (p) =>
          `### [CK.02] ${p.number}: ${p.name}\n**Goal:** do the thing\n` +
          (p.depends_on ? `**Depends on:** ${p.depends_on}\n` : ''),
      )
      .join('\n');
    const checklist = phases.map((p) => `- [ ] [CK.02] ${p.number}: ${p.name}`).join('\n');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap', '', '## [CK.02] v2.0 — Current', '', checklist, '', sections, ''].join('\n'),
    );
  }

  test('"Nothing (independent of [CK.02] 01 and 03)" yields no dependencies (AC4)', () => {
    writeBracketRoadmap([
      { number: '01', name: 'One' },
      { number: '02', name: 'Two' },
      { number: '03', name: 'Three' },
      { number: '04', name: 'Four', depends_on: 'Nothing (independent of [CK.02] 01 and 03)' },
    ]);
    const row = rowFor(managerRows(tmpDir), '04');
    assert.deepEqual(row.dep_phases, [], 'negated prose must not become dependencies under brackets');
    assert.equal(row.deps_satisfied, true);
  });

  test('a qualified bracket list still extracts (AC4 guard)', () => {
    writeBracketRoadmap([
      { number: '01', name: 'One' },
      { number: '03', name: 'Three' },
      { number: '04', name: 'Four', depends_on: '[CK.02] 01 and 03' },
    ]);
    const row = rowFor(managerRows(tmpDir), '04');
    assert.equal(row.dep_phases.length, 2, 'both qualified tokens must survive');
    assert.equal(row.deps_satisfied, false);
  });
});

describe('planning inspect agrees with init manager on negated leads (#6507 parity)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject('6507-insp-'); });
  afterEach(() => cleanup(tmpDir));

  test('"Nothing (independent of Phases 1 and 3)" reports no dependencies (manager↔inspect parity)', () => {
    // Both surfaces consume src/phase-id.cts's extractPhaseDependencyTokens,
    // so the empty answer is by construction — proven here through the
    // inspect payload's own dependencies field, scope 'complete' (a found
    // section with a real empty answer, not the unscoped non-answer).
    writeInspectFixture(tmpDir, [
      { number: '1', name: 'One' },
      { number: '2', name: 'Two', depends_on: 'Nothing (independent of Phases 1 and 3)' },
      { number: '3', name: 'Three' },
    ]);
    const row = inspectRow(tmpDir, '2', 'Two');
    assert.deepEqual(row.dependencies.value, [], 'inspect must report NO dependencies for the negated lead');
    assert.equal(row.dependencies.scope, 'complete');
  });

  test('"Phase 1, Phase 2" still reports both dependencies (parity guard)', () => {
    writeInspectFixture(tmpDir, [
      { number: '1', name: 'One' },
      { number: '2', name: 'Two' },
      { number: '3', name: 'Three', depends_on: 'Phase 1, Phase 2' },
    ]);
    const row = inspectRow(tmpDir, '3', 'Three');
    assert.deepEqual(row.dependencies.value, ['1', '2']);
    assert.equal(row.dependencies.scope, 'complete');
  });
});

describe('phase-id lead-negation owner contract (#6507 property)', () => {
  test('every drawn negated suffix yields no tokens under both conventions', () => {
    const suffixes = ['Phase 1', 'Phases 1 and 3', '[CK.02] 01 and 03', 'Phase 1-3', ''];
    const conventions = [null, 'bracket'];
    fc.assert(
      fc.property(
        fc.constantFrom(...suffixes),
        fc.constantFrom(...conventions),
        (suffix, convention) => {
          for (const lead of [`Nothing ${suffix}`, `None ${suffix}`]) {
            assert.equal(phaseId.isNegatedDependencyLead(lead), true, `negated lead must be recognized: ${lead}`);
            assert.deepEqual(
              phaseId.extractPhaseDependencyTokens(lead, convention),
              [],
              `negated lead must extract no tokens (${String(convention)}): ${lead}`,
            );
          }
          assert.equal(
            phaseId.isNegatedDependencyLead(`Phase 1, ${suffix}`),
            false,
            'a real lead list is never a negation',
          );
        },
      ),
      { seed: '6507', numRuns: 60 },
    );
  });
});

describe('writer guidance states the machine-read rule (#6507 AC5)', () => {
  const DOCS = [
    ['agents/gsd-roadmapper.md', ROADMAPPER_DOC],
    ['gsd-core/workflows/add-phase.md', ADD_PHASE_DOC],
    ['gsd-core/workflows/edit-phase.md', EDIT_PHASE_DOC],
  ];
  for (const [name, file] of DOCS) {
    test(`${name} states the Depends-on machine-read rule`, () => {
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, /machine-read/);
      assert.match(text, /Phase 4, Phase 5/);
    });
  }
});
