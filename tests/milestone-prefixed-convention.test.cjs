'use strict';

/**
 * W021 validation rule — milestone-prefixed phase ID convention.
 *
 * W021 fires when a phase ID's integer prefix doesn't match its enclosing
 * milestone section (e.g. phase '1-01' listed under ## v2.0 is a mismatch).
 *
 * Also covers: `gsd-tools roadmap validate` subcommand shape.
 *
 * These features do NOT exist yet — this file is written TDD-first.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

/**
 * Build a ROADMAP.md with milestone-prefixed sections at
 * `tmpDir/.planning/ROADMAP.md`.
 *
 * @param {string} tmpDir - Temp project root returned by createTempProject().
 * @param {Array<{version: string, label: string, phases: Array<{id: string, name: string}>}>} milestones
 *   Each milestone maps to a `## [GSD] vX.Y — Label` section; each phase maps
 *   to a `### Phase <id>: <name>` heading inside that section.
 * @param {object} [opts]
 * @param {string|null} [opts.conventionValue] - Value for the `phase_id_convention`
 *   front-matter field. Pass `null` to emit the key with a null/absent value.
 *   Omit (undefined) to use the default ('milestone-prefixed').
 */
function buildRoadmap(tmpDir, milestones, opts = {}) {
  const { conventionValue } = opts;

  let conventionLine;
  if (conventionValue === null) {
    conventionLine = 'phase_id_convention: null';
  } else if (conventionValue === undefined) {
    conventionLine = 'phase_id_convention: milestone-prefixed';
  } else {
    conventionLine = `phase_id_convention: ${conventionValue}`;
  }

  const frontmatter = `---\n${conventionLine}\n---\n\n`;

  const sections = milestones
    .map(({ version, label, phases }) => {
      const phaseBlocks = phases
        .map(({ id, name }) => `### Phase ${id}: ${name}\n**Goal:** Placeholder goal\n`)
        .join('\n');
      return `## [GSD] ${version} — ${label}\n\n${phaseBlocks}`;
    })
    .join('\n\n');

  const content = `${frontmatter}# Roadmap\n\n${sections}\n`;
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('W021 — milestone-prefixed phase ID convention', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── 1. Mismatch fires W021 ────────────────────────────────────────────────

  test('W021 fires when phase 1-01 is listed under ## v2.0 (mismatch)', () => {
    buildRoadmap(tmpDir, [
      {
        version: 'v2.0',
        label: 'Expansion',
        phases: [{ id: '1-01', name: 'Setup' }],
      },
    ]);

    const result = runGsdTools(['roadmap', 'validate'], tmpDir);
    // #2978: validate now exits non-zero on any warning (per its documented contract).
    assert.strictEqual(result.success, false, `roadmap validate must exit non-zero on W021 warnings: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.ok(Array.isArray(out.warnings), 'output.warnings should be an array');

    const w021 = out.warnings.filter(w => w.code === 'W021');
    assert.ok(w021.length > 0, 'at least one W021 warning expected for prefix mismatch');

    const warning = w021[0];
    assert.ok(warning.message, 'W021 entry should have a message field');
  });

  // ── 2. Match does NOT fire W021 ───────────────────────────────────────────

  test('W021 does NOT fire when phase 2-01 is under ## v2.0 (match)', () => {
    buildRoadmap(tmpDir, [
      {
        version: 'v2.0',
        label: 'Expansion',
        phases: [{ id: '2-01', name: 'New thing' }],
      },
    ]);

    const result = runGsdTools(['roadmap', 'validate'], tmpDir);
    assert.ok(result.success, `roadmap validate failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.ok(Array.isArray(out.warnings), 'output.warnings should be an array');

    const w021 = out.warnings.filter(w => w.code === 'W021');
    assert.strictEqual(w021.length, 0, 'no W021 warnings expected when prefix matches milestone');
  });

  // ── 3. Sentinel ranges are exempt ────────────────────────────────────────

  test('W021 does NOT fire for sentinel range: phase 999-01 (backlog)', () => {
    buildRoadmap(tmpDir, [
      {
        version: 'v1.0',
        label: 'Foundation',
        phases: [{ id: '999-01', name: 'Backlog item' }],
      },
    ]);

    const result = runGsdTools(['roadmap', 'validate'], tmpDir);
    assert.ok(result.success, `roadmap validate failed: ${result.error}`);

    const out = JSON.parse(result.output);
    const w021 = (out.warnings || []).filter(w => w.code === 'W021');
    assert.strictEqual(w021.length, 0, 'backlog sentinel (999-xx) should be exempt from W021');
  });

  test('W021 does NOT fire for sentinel range: phase 0-01 (pre-milestone)', () => {
    buildRoadmap(tmpDir, [
      {
        version: 'v1.0',
        label: 'Foundation',
        phases: [{ id: '0-01', name: 'Pre-milestone work' }],
      },
    ]);

    const result = runGsdTools(['roadmap', 'validate'], tmpDir);
    assert.ok(result.success, `roadmap validate failed: ${result.error}`);

    const out = JSON.parse(result.output);
    const w021 = (out.warnings || []).filter(w => w.code === 'W021');
    assert.strictEqual(w021.length, 0, 'pre-milestone sentinel (0-xx) should be exempt from W021');
  });

  // ── 4. null convention disables W021 ─────────────────────────────────────

  test('W021 does NOT fire when phase_id_convention is null (free-form roadmap)', () => {
    buildRoadmap(
      tmpDir,
      [
        {
          version: 'v2.0',
          label: 'Expansion',
          // Deliberately mismatched prefix to confirm the rule is disabled
          phases: [{ id: '1-01', name: 'Setup' }],
        },
      ],
      { conventionValue: null }
    );

    const result = runGsdTools(['roadmap', 'validate'], tmpDir);
    assert.ok(result.success, `roadmap validate failed: ${result.error}`);

    const out = JSON.parse(result.output);
    const w021 = (out.warnings || []).filter(w => w.code === 'W021');
    assert.strictEqual(w021.length, 0, 'W021 must not fire when convention is null');
  });

  // ── 5. `roadmap validate` returns JSON with warnings array ───────────────

  test("'gsd-tools roadmap validate' subcommand returns JSON with warnings array", () => {
    buildRoadmap(tmpDir, [
      {
        version: 'v1.0',
        label: 'Foundation',
        phases: [{ id: '1-01', name: 'Setup' }],
      },
    ]);

    const result = runGsdTools(['roadmap', 'validate'], tmpDir);
    assert.ok(result.success, `roadmap validate should succeed: ${result.error}`);

    let out;
    try {
      out = JSON.parse(result.output);
    } catch {
      assert.fail(`roadmap validate output is not valid JSON: ${result.output}`);
    }

    assert.ok(typeof out === 'object' && out !== null, 'output should be a JSON object');
    assert.ok(Array.isArray(out.warnings), 'output should have a warnings array');
  });

  // ── 6. W021 message includes migration command ────────────────────────────

  test('W021 warning text includes the migration command', () => {
    buildRoadmap(tmpDir, [
      {
        version: 'v2.0',
        label: 'Expansion',
        phases: [{ id: '1-01', name: 'Mismatched phase' }],
      },
    ]);

    const result = runGsdTools(['roadmap', 'validate'], tmpDir);
    // #2978: validate now exits non-zero on any warning (per its documented contract).
    assert.strictEqual(result.success, false, `roadmap validate must exit non-zero on W021 warnings: ${result.error}`);

    const out = JSON.parse(result.output);
    const w021 = (out.warnings || []).filter(w => w.code === 'W021');
    assert.ok(w021.length > 0, 'W021 warning expected');

    const migrationCmd = 'gsd-tools roadmap upgrade --convention milestone-prefixed';
    const hasMigration = w021.some(w => typeof w.message === 'string' && w.message.includes(migrationCmd));
    assert.ok(
      hasMigration,
      `W021 warning message should include "${migrationCmd}". Got: ${JSON.stringify(w021.map(w => w.message))}`
    );
  });
});

// ---------------------------------------------------------------------------
// #5626 — M-NN phase ids survive the state contract and the prose phase parser
// ---------------------------------------------------------------------------
//
// Under phase_id_convention: milestone-prefixed the phase id is the whole "3-01". Three leading-integer
// captures accepted only dotted segments, so state.json listed every phase as number "3", the checklist
// names carried the "-01:" remainder, and state sync rewrote current_phase: 3-01 to 3.

const { buildStateContract } = require('../gsd-core/bin/lib/state-contract.cjs');
const { parsePhaseFromProse } = require('../gsd-core/bin/lib/phase-id.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

const MP = 'milestone-prefixed';

const ROADMAP_TABLE = [
  '# Roadmap', '', '## Milestone v3.0', '',
  '- [ ] **Phase 3-01: Create layer**', '- [ ] **Phase 3-02: Validator**', '',
  '### Phase 3-01: Create layer', '**Goal**: x', '', '### Phase 3-02: Validator', '**Goal**: y', '',
  '## Progress', '',
  '| Phase | Plans Complete | Status | Completed |',
  '|-------|----------------|--------|-----------|',
  '| 3-01. Create layer | 0/1 | Planned | - |',
  '| 3-02. Validator | 0/0 | Not started | - |', '',
].join('\n');

const ROADMAP_CHECKLIST = [
  '# Roadmap', '', '## Phases', '',
  '- [ ] **Phase 3-01: Create layer**', '- [ ] **Phase 3-02: Validator**', '',
].join('\n');

const STATE_MD = [
  '---', 'milestone: v3.0', 'current_phase: 3-01', 'status: planning', '---', '',
  '# Project State', '', '## Current Position', '',
  'Phase: 3-01 (Create layer) — READY TO EXECUTE', 'Status: Executing', 'Total Plans in Phase: 5', '',
].join('\n');

describe('#5626 milestone-prefixed M-NN phase ids', () => {
  let projectDir;
  beforeEach(() => { projectDir = createTempProject('gsd-5626-'); });
  afterEach(() => { cleanup(projectDir); });

  function writeProject({ roadmap, convention = MP }) {
    const planning = path.join(projectDir, '.planning');
    const phaseDir = path.join(planning, 'phases', '3-01-create-layer');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '3-01-01-PLAN.md'), '# plan\n');
    fs.writeFileSync(path.join(phaseDir, '3-01-01-SUMMARY.md'), '# summary\n');
    fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify(convention === null ? {} : { phase_id_convention: convention }));
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(planning, 'STATE.md'), STATE_MD);
  }

  const view = (phases) => phases.map((p) => ({ number: p.number, name: p.name }));

  test('state.json phases keep M-NN ids from the Progress table (#5626)', () => {
    writeProject({ roadmap: ROADMAP_TABLE });
    assert.deepEqual(view(buildStateContract(projectDir).phases), [
      { number: '3-01', name: 'Create layer' },
      { number: '3-02', name: 'Validator' },
    ]);
  });

  test('state.json phases keep M-NN ids from the checklist and flag the current one (#5626)', () => {
    writeProject({ roadmap: ROADMAP_CHECKLIST });
    const phases = buildStateContract(projectDir).phases;
    assert.deepEqual(view(phases), [
      { number: '3-01', name: 'Create layer' },
      { number: '3-02', name: 'Validator' },
    ]);
    assert.deepEqual(phases.map((p) => p.status), ['in_progress', 'pending'], 'only the current phase is in progress');
  });

  test('parsePhaseFromProse keeps M-NN under milestone-prefixed (#5626)', () => {
    assert.equal(parsePhaseFromProse('3-01', MP).phase, '3-01');
    const withName = parsePhaseFromProse('3-01 (Create layer) — EXECUTING', MP);
    assert.equal(withName.phase, '3-01');
    assert.equal(withName.name, 'Create layer');
  });

  test('state sync keeps current_phase 3-01 (#5626)', () => {
    writeProject({ roadmap: ROADMAP_TABLE });
    const synced = runGsdTools(['state', 'sync'], projectDir);
    assert.equal(synced.success, true, synced.error);
    const state = fs.readFileSync(path.join(projectDir, '.planning', 'STATE.md'), 'utf8');
    assert.equal(extractFrontmatter(state).current_phase, '3-01', 'the frontmatter current_phase round-trips');
  });

  test('other id shapes parse as before under milestone-prefixed (#5626)', () => {
    const cases = [
      ['47', '47'], ['2.1', '2.1'], ['12A', '12A'], ['1.5', '1.5'], ['Phase 7', '7'],
      ['Milestone v3.0 complete', null], ['', null],
    ];
    for (const [input, phase] of cases) {
      assert.equal(parsePhaseFromProse(input, MP).phase, phase, JSON.stringify(input));
    }
    assert.equal(parsePhaseFromProse('[GSD.02] 05', MP).phase, parsePhaseFromProse('[GSD.02] 05').phase, 'bracket display ids read the same');
  });

  test('other conventions still read 3-01 as phase 3 (#5626)', () => {
    for (const convention of [undefined, null, 'bracket']) {
      assert.equal(parsePhaseFromProse('3-01', convention).phase, '3', String(convention));
    }
    assert.equal(parsePhaseFromProse('3-01').phase, '3');
  });

  test('state.json under no convention keeps the leading integer, as before (#5626)', () => {
    writeProject({ roadmap: ROADMAP_TABLE, convention: null });
    assert.deepEqual(buildStateContract(projectDir).phases.map((p) => p.number), ['3', '3']);
  });

  test('M-NN boundary shapes (#5626)', () => {
    const cases = [
      ['3-1', '3-1'], ['3-01', '3-01'], ['3-001', '3-001'],
      ['3-', '3'], ['3--01', '3'], ['-01', null], ['3-01-02', '3-01'],
    ];
    for (const [input, phase] of cases) {
      assert.equal(parsePhaseFromProse(input, MP).phase, phase, JSON.stringify(input));
    }
  });
});
