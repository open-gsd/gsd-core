/**
 * GSD Tools Tests - Init Manager
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup, absPlanningPath } = require('./helpers.cjs');
const { seedWorkstream } = require('./fixtures/index.cjs');

// Helper: write a minimal ROADMAP.md with phases
function writeRoadmap(tmpDir, phases) {
  const sections = phases.map(p => {
    let section = `### Phase ${p.number}: ${p.name}\n\n**Goal:** ${p.goal || 'Do the thing'}\n`;
    if (p.depends_on) section += `**Depends on:** ${p.depends_on}\n`;
    return section;
  }).join('\n');

  const checklist = phases.map(p => {
    const mark = p.complete ? 'x' : ' ';
    return `- [${mark}] **Phase ${p.number}: ${p.name}**`;
  }).join('\n');

  const content = `# Roadmap\n\n## Progress\n\n${checklist}\n\n${sections}`;
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

// Helper: write a minimal STATE.md
function writeState(tmpDir) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nstatus: active\n---\n# State\n');
}

// Helper: scaffold a phase directory with specific artifacts
function scaffoldPhase(tmpDir, num, opts = {}) {
  const padded = String(num).padStart(2, '0');
  const slug = opts.slug || 'test-phase';
  const dir = path.join(tmpDir, '.planning', 'phases', `${padded}-${slug}`);
  fs.mkdirSync(dir, { recursive: true });

  if (opts.context) fs.writeFileSync(path.join(dir, `${padded}-CONTEXT.md`), '# Context');
  if (opts.research) fs.writeFileSync(path.join(dir, `${padded}-RESEARCH.md`), '# Research');
  if (opts.plans) {
    for (let i = 1; i <= opts.plans; i++) {
      const planPad = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(dir, `${padded}-${planPad}-PLAN.md`), `# Plan ${i}`);
    }
  }
  if (opts.summaries) {
    for (let i = 1; i <= opts.summaries; i++) {
      const sumPad = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(dir, `${padded}-${sumPad}-SUMMARY.md`), `# Summary ${i}`);
    }
  }

  return dir;
}

function writePassedVerification(phaseDir, padded) {
  fs.writeFileSync(
    path.join(phaseDir, `${padded}-VERIFICATION.md`),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n')
  );
}

describe('init manager', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('fails without ROADMAP.md', () => {
    writeState(tmpDir);
    const result = runGsdTools('init manager', tmpDir);
    assert.ok(!result.success);
    assert.ok(result.error.includes('ROADMAP.md'));
  });

  test('fails without STATE.md', () => {
    writeRoadmap(tmpDir, [{ number: '1', name: 'Setup' }]);
    const result = runGsdTools('init manager', tmpDir);
    assert.ok(!result.success);
    assert.ok(result.error.includes('STATE.md'));
  });

  test('returns basic structure with phases', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '2', name: 'API Layer' },
      { number: '3', name: 'UI' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 3);
    assert.strictEqual(output.completed_count, 0);
    assert.strictEqual(output.roadmap_exists, true);
    assert.strictEqual(output.state_exists, true);
    assert.ok(Array.isArray(output.phases));
    assert.ok(Array.isArray(output.recommended_actions));
  });

  test('detects disk status correctly for each phase state', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Complete Phase', complete: true },
      { number: '2', name: 'Planned Phase' },
      { number: '3', name: 'Discussed Phase' },
      { number: '4', name: 'Empty Phase' },
      { number: '5', name: 'Not Started' },
    ]);

    // Phase 1: complete (plans + matching summaries + passed verification)
    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'complete-phase', context: true, plans: 2, summaries: 2 }), '01');
    // Phase 2: planned (plans, no summaries)
    scaffoldPhase(tmpDir, 2, { slug: 'planned-phase', context: true, plans: 3 });
    // Phase 3: discussed (context only)
    scaffoldPhase(tmpDir, 3, { slug: 'discussed-phase', context: true });
    // Phase 4: empty directory
    scaffoldPhase(tmpDir, 4, { slug: 'empty-phase' });
    // Phase 5: no directory at all

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].disk_status, 'complete');
    assert.strictEqual(output.phases[1].disk_status, 'planned');
    assert.strictEqual(output.phases[2].disk_status, 'discussed');
    assert.strictEqual(output.phases[3].disk_status, 'empty');
    assert.strictEqual(output.phases[4].disk_status, 'no_directory');
  });

  test('treats plans/PLAN-NN.md layout as planned/complete counts (#3053)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Nested Plans' },
    ]);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-nested-plans');
    fs.mkdirSync(path.join(phaseDir, 'plans'), { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'plans', 'PLAN-01.md'), '# Plan 1');
    fs.writeFileSync(path.join(phaseDir, 'plans', 'PLAN-02.md'), '# Plan 2');
    fs.writeFileSync(path.join(phaseDir, 'plans', 'SUMMARY-01.md'), '# Summary 1');

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].plan_count, 2);
    assert.strictEqual(output.phases[0].summary_count, 1);
    assert.strictEqual(output.phases[0].disk_status, 'partial');
  });

  test('dependency satisfaction: deps on complete phases = satisfied', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation', complete: true },
      { number: '2', name: 'Depends on 1', depends_on: 'Phase 1' },
    ]);
    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'foundation', plans: 1, summaries: 1 }), '01');

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].deps_satisfied, true);
    assert.strictEqual(output.phases[1].deps_satisfied, true);
  });

  test('dependency satisfaction: deps on incomplete phases = not satisfied', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '2', name: 'Depends on 1', depends_on: 'Phase 1' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].deps_satisfied, true); // no deps
    assert.strictEqual(output.phases[1].deps_satisfied, false); // phase 1 not complete
  });

  test('parallel discuss: all undiscussed phases are marked is_next_to_discuss', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '2', name: 'API Layer' },
      { number: '3', name: 'UI' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // All three phases are undiscussed — all should be discussable
    assert.strictEqual(output.phases[0].is_next_to_discuss, true);
    assert.strictEqual(output.phases[1].is_next_to_discuss, true);
    assert.strictEqual(output.phases[2].is_next_to_discuss, true);

    // All three should have discuss recommendations
    const discussActions = output.recommended_actions.filter(a => a.action === 'discuss');
    assert.strictEqual(discussActions.length, 3);
  });

  test('discussed phase is not discussable; undiscussed siblings are', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '2', name: 'API Layer' },
      { number: '3', name: 'UI' },
    ]);

    // Phase 1 discussed
    scaffoldPhase(tmpDir, 1, { slug: 'foundation', context: true });

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Phase 1 is discussed; phases 2 and 3 are both undiscussed and discussable
    assert.strictEqual(output.phases[0].is_next_to_discuss, false);
    assert.strictEqual(output.phases[1].is_next_to_discuss, true);
    assert.strictEqual(output.phases[2].is_next_to_discuss, true);

    // Should recommend plan phase 1 AND discuss phases 2 and 3
    const phase1Rec = output.recommended_actions.find(r => r.phase === '1');
    const phase2Rec = output.recommended_actions.find(r => r.phase === '2');
    const phase3Rec = output.recommended_actions.find(r => r.phase === '3');
    assert.strictEqual(phase1Rec.action, 'plan');
    assert.strictEqual(phase2Rec.action, 'discuss');
    assert.strictEqual(phase3Rec.action, 'discuss');
  });

  test('sliding window: full pipeline — execute N, plan N+1, discuss N+2', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation', complete: true },
      { number: '2', name: 'API Layer' },
      { number: '3', name: 'Auth' },
      { number: '4', name: 'UI' },
      { number: '5', name: 'Polish' },
    ]);

    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'foundation', plans: 1, summaries: 1 }), '01');
    scaffoldPhase(tmpDir, 2, { slug: 'api-layer', context: true, plans: 2 }); // planned
    scaffoldPhase(tmpDir, 3, { slug: 'auth', context: true }); // discussed

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Phases 4 and 5 are both undiscussed — both discussable
    assert.strictEqual(output.phases[3].is_next_to_discuss, true);
    assert.strictEqual(output.phases[4].is_next_to_discuss, true);

    // Recommendations: execute 2, plan 3, discuss 4, discuss 5
    assert.strictEqual(output.recommended_actions[0].action, 'execute');
    assert.strictEqual(output.recommended_actions[0].phase, '2');
    assert.strictEqual(output.recommended_actions[1].action, 'plan');
    assert.strictEqual(output.recommended_actions[1].phase, '3');
    const discussRecs = output.recommended_actions.filter(a => a.action === 'discuss').map(a => a.phase).sort();
    assert.deepStrictEqual(discussRecs, ['4', '5']);
  });

  test('recommendation ordering: execute > plan > discuss', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Complete', complete: true },
      { number: '2', name: 'Ready to Execute' },
      { number: '3', name: 'Ready to Plan' },
      { number: '4', name: 'Ready to Discuss' },
    ]);

    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'complete', plans: 1, summaries: 1 }), '01');
    scaffoldPhase(tmpDir, 2, { slug: 'ready-to-execute', context: true, plans: 2 });
    scaffoldPhase(tmpDir, 3, { slug: 'ready-to-plan', context: true });

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.ok(output.recommended_actions.length >= 3);
    assert.strictEqual(output.recommended_actions[0].action, 'execute');
    assert.strictEqual(output.recommended_actions[0].phase, '2');
    assert.strictEqual(output.recommended_actions[1].action, 'plan');
    assert.strictEqual(output.recommended_actions[1].phase, '3');
    assert.strictEqual(output.recommended_actions[2].action, 'discuss');
    assert.strictEqual(output.recommended_actions[2].phase, '4');
  });

  test('blocked phases not recommended', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'In Progress' },
      { number: '2', name: 'Blocked', depends_on: 'Phase 1' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Phase 2 should not appear in recommendations (blocked by phase 1)
    const phase2Rec = output.recommended_actions.find(r => r.phase === '2');
    assert.strictEqual(phase2Rec, undefined);
  });

  test('all phases complete sets all_complete flag', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Done', complete: true },
      { number: '2', name: 'Also Done', complete: true },
    ]);
    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'done', plans: 1, summaries: 1 }), '01');
    writePassedVerification(scaffoldPhase(tmpDir, 2, { slug: 'also-done', plans: 1, summaries: 1 }), '02');

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.all_complete, true);
    assert.strictEqual(output.recommended_actions.length, 0);
  });

  test('implementation-complete phase without passed verification is not all_complete', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Implemented', complete: true },
    ]);
    scaffoldPhase(tmpDir, 1, { slug: 'implemented', plans: 1, summaries: 1 });

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_complete, false);
    assert.strictEqual(output.completed_count, 0);
    assert.strictEqual(output.phases[0].disk_status, 'executed');
    assert.strictEqual(output.phases[0].implementation_complete, true);
    assert.strictEqual(output.phases[0].verification_status, 'missing');
    assert.strictEqual(output.phases[0].verification_passed, false);
    assert.strictEqual(output.recommended_actions[0].action, 'verify');
    assert.match(output.recommended_actions[0].command, /execute-phase 1/);
  });

  test('stale passed verification is not projected as complete', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Implemented', complete: true },
    ]);
    const phaseDir = scaffoldPhase(tmpDir, 1, { slug: 'implemented', plans: 1, summaries: 1 });
    writePassedVerification(phaseDir, '01');
    const verificationPath = path.join(phaseDir, '01-VERIFICATION.md');
    const summaryPath = path.join(phaseDir, '01-01-SUMMARY.md');
    const older = new Date('2025-01-01T00:00:00.000Z');
    const newer = new Date('2025-01-01T00:01:00.000Z');
    fs.utimesSync(verificationPath, older, older);
    fs.utimesSync(summaryPath, newer, newer);

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_complete, false);
    assert.strictEqual(output.completed_count, 0);
    assert.strictEqual(output.phases[0].disk_status, 'executed');
    assert.strictEqual(output.phases[0].implementation_complete, true);
    assert.strictEqual(output.phases[0].verification_status, 'stale');
    assert.strictEqual(output.phases[0].verification_passed, false);
    assert.strictEqual(output.phases[0].phase_complete, false);
    assert.strictEqual(output.recommended_actions[0].action, 'verify');
    assert.match(output.recommended_actions[0].reason, /verification stale/);
    assert.match(output.recommended_actions[0].command, /execute-phase 1/);
  });

  test('checked unpadded roadmap token does not satisfy padded unverified dependency', () => {
    writeState(tmpDir);
    const roadmap = [
      '# Roadmap',
      '',
      '## Progress',
      '',
      '- [x] **Phase 1: Foundation**',
      '- [ ] **Phase 02: Followup**',
      '',
      '### Phase 01: Foundation',
      '',
      '**Goal:** Build foundation',
      '',
      '### Phase 02: Followup',
      '',
      '**Goal:** Build followup',
      '**Depends on:** Phase 1',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    scaffoldPhase(tmpDir, 1, { slug: 'foundation', plans: 1, summaries: 1 });

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const phase1 = output.phases.find(p => p.number === '01');
    const phase2 = output.phases.find(p => p.number === '02');

    assert.ok(phase1, 'Phase 01 should be in the output');
    assert.strictEqual(phase1.phase_complete, false, 'Phase 01 is unverified and must not be complete');
    assert.ok(phase2, 'Phase 02 should be in the output');
    assert.strictEqual(phase2.deps_satisfied, false, 'Phase 02 dependency must wait for canonical Phase 01 verification');
  });

  test('WAITING.json detected when present', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    const waiting = { type: 'decision', phase: '1', question: 'Pick one' };
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'WAITING.json'),
      JSON.stringify(waiting)
    );

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.deepStrictEqual(output.waiting_signal, waiting);
  });

  test('phase fields include goal and depends_on from roadmap', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation', goal: 'Set up the base' },
      { number: '2', name: 'API', goal: 'Build endpoints', depends_on: 'Phase 1' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].goal, 'Set up the base');
    assert.strictEqual(output.phases[0].depends_on, null);
    assert.strictEqual(output.phases[1].goal, 'Build endpoints');
    assert.strictEqual(output.phases[1].depends_on, 'Phase 1');
  });

  test('display_name truncates long phase names', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Short' },
      { number: '2', name: 'Exactly Twenty Chars' },
      { number: '3', name: 'This Name Is Way Too Long For The Table' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].display_name, 'Short');
    assert.strictEqual(output.phases[1].display_name, 'Exactly Twenty Chars');
    assert.strictEqual(output.phases[2].display_name, 'This Name Is Way To…');
    assert.strictEqual(output.phases[2].display_name.length, 20);
    // Full name is preserved
    assert.strictEqual(output.phases[2].name, 'This Name Is Way Too Long For The Table');
  });

  test('activity detection: recent file = active', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Active Phase' }]);

    // Scaffold with a file — it will have current mtime (within 5 min)
    scaffoldPhase(tmpDir, 1, { slug: 'active-phase', context: true });

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].is_active, true);
    assert.ok(output.phases[0].last_activity !== null);
  });

  test('activity detection: hour-old file = not active', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Stale Phase' }]);

    const PINNED_NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z (second-aligned)
    const phaseDir = scaffoldPhase(tmpDir, 1, { slug: 'stale-phase', context: true });
    const files = fs.readdirSync(phaseDir);
    const old = new Date(PINNED_NOW_MS - 60 * 60 * 1000); // 1 hour before the pinned "now"
    for (const f of files) {
      fs.utimesSync(path.join(phaseDir, f), old, old);
    }

    const result = runGsdTools('init manager', tmpDir, {
      GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_NOW_MS),
    });
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].is_active, false);
  });

  // #4134 — a first-ever ROADMAP.md whose H1 puts the version after the name
  // (`# Roadmap: <Project> — <Milestone Name> (v1.13)` — the shape nothing
  // templates for a project's first milestone) used to make the §7.2 pinned
  // name rule return the literal `)` left after the version token as the
  // milestone's "name", and init manager displayed it verbatim. The refusal
  // reports the honest ADR-3180 §7.2 rule-6 answer instead: the version is
  // real, the name is not resolvable from that heading, milestone_name is
  // null — never a punctuation fragment.
  test('#4134 — milestone_name is null, never ")", for a name-then-version H1', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap: GSD Core — Native OMP Runtime Support (v1.13)',
        '',
        '## Phases',
        '',
        '- [ ] **Phase 1: Runtime Adapter Interface**',
        '',
        '## Phase Details',
        '',
        '### Phase 1: Runtime Adapter Interface',
        '',
        '**Goal:** Define the adapter contract.',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.13',
        'milestone_name: Native OMP Runtime Support',
        'status: planning',
        '---',
        '',
        '# Project State',
        '',
      ].join('\n')
    );

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.milestone_version, 'v1.13');
    assert.strictEqual(output.milestone_name, null);
    assert.ok(!result.output.includes('")"'), 'a lone ")" value must not appear anywhere in the JSON');
  });

  // #3314 — ADR-456 subprocess clock pin: cmdInitManager's `is_active` gate
  // (nowMs - newestMtime < 300000) is CLI-subprocess tested, so only the
  // GSD_TEST_MODE+GSD_NOW_MS pin can control "now" here (t.mock.timers in the
  // test process cannot reach the spawned child). newestMtime is set via
  // fs.utimesSync to an exact epoch offset from the pinned "now" so the
  // 300000ms boundary is provable exactly, not just "roughly recent"/"roughly old".
  describe('is_active boundary (#3314 — exactly 300000ms, condition is strict <)', () => {
    const PINNED_NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z (second-aligned)
    const PIN_ENV = { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_NOW_MS) };

    function scaffoldWithMtimeOffset(tmpDirLocal, offsetMs) {
      writeState(tmpDirLocal);
      writeRoadmap(tmpDirLocal, [{ number: '1', name: 'Boundary Phase' }]);
      const phaseDir = scaffoldPhase(tmpDirLocal, 1, { slug: 'boundary-phase', context: true });
      const mtimeMs = PINNED_NOW_MS - offsetMs;
      const mtimeDate = new Date(mtimeMs);
      for (const f of fs.readdirSync(phaseDir)) {
        fs.utimesSync(path.join(phaseDir, f), mtimeDate, mtimeDate);
      }
    }

    test('boundary: 299999ms since last activity → is_active true', () => {
      scaffoldWithMtimeOffset(tmpDir, 299_999);
      const result = runGsdTools('init manager', tmpDir, PIN_ENV);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.phases[0].is_active, true);
    });

    test('boundary: exactly 300000ms since last activity → is_active false', () => {
      scaffoldWithMtimeOffset(tmpDir, 300_000);
      const result = runGsdTools('init manager', tmpDir, PIN_ENV);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.phases[0].is_active, false);
    });

    test('boundary: 300001ms since last activity → is_active false', () => {
      scaffoldWithMtimeOffset(tmpDir, 300_001);
      const result = runGsdTools('init manager', tmpDir, PIN_ENV);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.phases[0].is_active, false);
    });
  });

  test('conflict filter: blocks dependent phase execute when dep is active', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation', complete: true },
      { number: '2', name: 'API Layer', depends_on: 'Phase 1' },
      { number: '3', name: 'Auth', depends_on: 'Phase 2' },
    ]);

    // Phase 2: partial (actively executing — has 2 plans, 1 summary)
    scaffoldPhase(tmpDir, 2, { slug: 'api-layer', context: true, plans: 2, summaries: 1 });
    // Phase 3: planned and deps would be met if Phase 2 were complete, but it's not
    scaffoldPhase(tmpDir, 3, { slug: 'auth', context: true, plans: 1 });

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Phase 2 is partial — should NOT appear as execute recommendation (already running)
    // Phase 3 deps_satisfied is false (Phase 2 not complete) — also no recommendation
    const execRecs = output.recommended_actions.filter(r => r.action === 'execute');
    assert.strictEqual(execRecs.length, 0);
  });

  test('conflict filter: allows independent phase execute in parallel', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation', complete: true },
      { number: '2', name: 'API Layer', depends_on: 'Phase 1' },
      { number: '3', name: 'Notifications' }, // no deps — independent
    ]);

    // Phase 2: partial (actively executing)
    scaffoldPhase(tmpDir, 2, { slug: 'api-layer', context: true, plans: 2, summaries: 1 });
    // Phase 3: planned, no deps — independent of Phase 2
    scaffoldPhase(tmpDir, 3, { slug: 'notifications', context: true, plans: 1 });

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Phase 3 is independent of Phase 2 — should be recommended for execution
    const execRecs = output.recommended_actions.filter(r => r.action === 'execute');
    assert.strictEqual(execRecs.length, 1);
    assert.strictEqual(execRecs[0].phase, '3');
  });

  test('output includes project_root field', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // macOS resolves /var → /private/var; normalize both sides
    assert.strictEqual(fs.realpathSync(output.project_root), fs.realpathSync(tmpDir));
  });

  test('output includes manager_flags defaults when not configured', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.ok(output.manager_flags, 'should include manager_flags');
    assert.strictEqual(output.manager_flags.discuss, '');
    assert.strictEqual(output.manager_flags.plan, '');
    assert.strictEqual(output.manager_flags.execute, '');
  });

  test('output includes manager_flags from config when set', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    // Write config with manager flags
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        manager: {
          flags: {
            discuss: '--auto --analyze',
            plan: '--skip-research',
            execute: '--interactive',
          }
        }
      })
    );

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.ok(output.manager_flags, 'should include manager_flags');
    assert.strictEqual(output.manager_flags.discuss, '--auto --analyze');
    assert.strictEqual(output.manager_flags.plan, '--skip-research');
    assert.strictEqual(output.manager_flags.execute, '--interactive');
  });

  test('sanitizes invalid manager_flags to prevent injection (#1410)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        manager: {
          flags: {
            discuss: '; rm -rf /',
            plan: '--valid-flag',
            execute: '$(whoami)',
          }
        }
      })
    );

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Invalid flags should be sanitized to empty string
    assert.strictEqual(output.manager_flags.discuss, '', 'injection attempt should be sanitized');
    assert.strictEqual(output.manager_flags.plan, '--valid-flag', 'valid flag should pass through');
    assert.strictEqual(output.manager_flags.execute, '', 'command substitution should be sanitized');
  });

  test('does not recommend BACKLOG phases (999.x) as next actions', () => {
    writeState(tmpDir);
    // Regular phase (planned, deps met) plus a backlog phase (999.1) also planned
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '999.1', name: 'Nice to have feature (BACKLOG)' },
    ]);
    // Phase 1: planned (has plan, no summary)
    scaffoldPhase(tmpDir, 1, { plans: 1 });
    // Phase 999.1: planned (has plan, no summary)
    const backlogDir = path.join(tmpDir, '.planning', 'phases', '999.1-backlog');
    fs.mkdirSync(backlogDir, { recursive: true });
    fs.writeFileSync(path.join(backlogDir, '999.1-01-PLAN.md'), '# Backlog Plan');

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const recommended = output.recommended_actions || [];
    const backlogRecs = recommended.filter(r => /^999/.test(r.phase));
    assert.strictEqual(backlogRecs.length, 0, 'no 999.x phases should appear in recommended_actions');

    // Phase 1 (non-backlog) should still be recommended
    const activeRecs = recommended.filter(r => r.phase === '1');
    assert.strictEqual(activeRecs.length, 1, 'phase 1 should still be recommended');
  });

  test('output includes response_language when configured', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ response_language: 'Japanese' })
    );

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.response_language, 'Japanese');
  });

  test('output omits response_language when not configured', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.response_language, undefined);
  });

  test('all_complete is true when non-backlog phases are complete and 999.x exists (#2129)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Setup', complete: true },
      { number: '2', name: 'Core', complete: true },
      { number: '3', name: 'Polish', complete: true },
      { number: '999.1', name: 'Backlog idea' },
    ]);

    // Scaffold completed phases on disk
    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'setup', plans: 2, summaries: 2 }), '01');
    writePassedVerification(scaffoldPhase(tmpDir, 2, { slug: 'core', plans: 1, summaries: 1 }), '02');
    writePassedVerification(scaffoldPhase(tmpDir, 3, { slug: 'polish', plans: 1, summaries: 1 }), '03');

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_complete, true, 'all_complete should be true when only 999.x phases remain incomplete');
  });

  test('all_complete false with incomplete non-backlog phase still produces recommended_actions (#2129)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Setup', complete: true },
      { number: '2', name: 'Core', complete: true },
      { number: '3', name: 'Polish' },
      { number: '999.1', name: 'Backlog idea' },
    ]);

    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'setup', plans: 1, summaries: 1 }), '01');
    writePassedVerification(scaffoldPhase(tmpDir, 2, { slug: 'core', plans: 1, summaries: 1 }), '02');
    // Phase 3 has no directory — should trigger discuss recommendation

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_complete, false, 'all_complete should be false with phase 3 incomplete');
    assert.ok(output.recommended_actions.length > 0, 'recommended_actions should not be empty when non-backlog phases remain');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2267: deps_satisfied should include phases from shipped milestones.
//
// Root cause: completedNums was built only from the current milestone's phases,
// so a dependency on a phase from a previously shipped milestone was never
// satisfied — even though all prior-milestone phases are complete by definition.
// ─────────────────────────────────────────────────────────────────────────────

describe('init manager — cross-milestone dependency satisfaction (#2267)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /**
   * Write a ROADMAP.md that has:
   *   - A shipped previous milestone (v1.0) inside a <details> block containing
   *     Phase 5 marked [x] complete.
   *   - A current active milestone (v2.0) containing Phase 6 that depends on
   *     Phase 5.
   */
  function writeRoadmapWithShippedMilestone(dir) {
    const content = [
      '# Roadmap',
      '',
      '<details>',
      '<summary>v1.0 — Initial Release (Shipped)</summary>',
      '',
      '## Roadmap v1.0: Initial Release',
      '',
      '- [x] **Phase 5: Auth**',
      '',
      '### Phase 5: Auth',
      '**Goal:** Add authentication',
      '',
      '</details>',
      '',
      '## Roadmap v2.0: Dashboard',
      '',
      '- [ ] **Phase 6: Dashboard**',
      '',
      '### Phase 6: Dashboard',
      '**Goal:** Build dashboard',
      '**Depends on:** Phase 5',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), content);
  }

  function writeStateWithMilestone(dir, version) {
    fs.writeFileSync(
      path.join(dir, '.planning', 'STATE.md'),
      `---\nmilestone: ${version}\n---\n# State\n`
    );
  }

  test('phase depending on a shipped-milestone phase has deps_satisfied: true (#2267)', () => {
    writeRoadmapWithShippedMilestone(tmpDir);
    writeStateWithMilestone(tmpDir, 'v2.0');

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);

    // Only the current milestone's phases should appear in the phases array
    assert.strictEqual(output.phases.length, 1, 'Should have exactly one phase from the current milestone');

    const phase6 = output.phases[0];
    assert.strictEqual(phase6.number, '6', 'Should be Phase 6');

    // Phase 6 depends on Phase 5 from the prior milestone — must be satisfied
    assert.strictEqual(
      phase6.deps_satisfied,
      true,
      'Phase 6 dep on shipped Phase 5 should be satisfied'
    );
  });

  test('phase depending on a non-existent phase has deps_satisfied: false (#2267)', () => {
    writeRoadmapWithShippedMilestone(tmpDir);
    writeStateWithMilestone(tmpDir, 'v2.0');

    // Add a second phase in the current milestone that depends on a phantom phase
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const existing = fs.readFileSync(roadmapPath, 'utf-8');
    const withExtra = existing + [
      '### Phase 7: Extra',
      '**Goal:** Extra work',
      '**Depends on:** Phase 99',
      '',
    ].join('\n');
    fs.writeFileSync(roadmapPath, withExtra);

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const phase7 = output.phases.find(p => p.number === '7');
    assert.ok(phase7, 'Phase 7 should be in the output');

    assert.strictEqual(
      phase7.deps_satisfied,
      false,
      'Phase 7 dep on non-existent Phase 99 should not be satisfied'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4455 — init manager emits workstream-scoped state_path/roadmap_path/
// archive_dir (same pattern cmdInitPlanPhase already uses, plus the
// milestone.cts archive-dir composition, #1911). autonomous.md's
// discover_phases/iterate/lifecycle steps consume these instead of
// hardcoding `.planning/STATE.md` / `.planning/milestones/...`.
// ─────────────────────────────────────────────────────────────────────────────

describe('init manager — state_path/roadmap_path/archive_dir (#4455)', () => {
  let tmpDir;

  beforeEach(() => {
    // macOS: realpath before absPlanningPath comparisons (symlinked /var/tmp).
    tmpDir = require('fs').realpathSync(createTempProject());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('flat mode (no GSD_WORKSTREAM): paths resolve to root .planning (regression guard)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Setup' }]);

    const result = runGsdTools('init manager', tmpDir, { GSD_WORKSTREAM: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
    assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
    assert.strictEqual(output.archive_dir, absPlanningPath(tmpDir, 'milestones'));
  });

  test('GSD_WORKSTREAM=alpha: paths resolve into the workstream, not root (#4455 regression)', () => {
    seedWorkstream(tmpDir, {
      name: 'alpha',
      state: '---\nstatus: active\n---\n# State\n',
      roadmap: '# Roadmap\n\n## Progress\n\n- [ ] **Phase 1: Setup**\n\n### Phase 1: Setup\n\n**Goal:** Bootstrap\n',
    });

    const result = runGsdTools('init manager', tmpDir, { GSD_WORKSTREAM: 'alpha' });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'workstreams', 'alpha', 'STATE.md'));
    assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'workstreams', 'alpha', 'ROADMAP.md'));
    assert.strictEqual(output.archive_dir, absPlanningPath(tmpDir, 'workstreams', 'alpha', 'milestones'));
    // Goodhart both-directions: must NOT be the flat root form.
    assert.notStrictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
    assert.notStrictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
    assert.notStrictEqual(output.archive_dir, absPlanningPath(tmpDir, 'milestones'));
  });

  test('state_path/roadmap_path are null when the files do not exist yet', () => {
    // init manager itself requires ROADMAP.md/STATE.md to exist to proceed
    // past its own readiness guard, so exercise the null branch through
    // init complete-milestone instead — same fs.existsSync(...) ? ... : null
    // pattern, no upstream guard blocking an empty-fixture run.
    const result = runGsdTools('init complete-milestone', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.state_path, null);
    assert.strictEqual(output.roadmap_path, null);
    assert.strictEqual(output.archive_dir, absPlanningPath(tmpDir, 'milestones'));
  });
});

describe('init complete-milestone — state_path/roadmap_path/archive_dir (#4455)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = require('fs').realpathSync(createTempProject());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('flat mode (no GSD_WORKSTREAM): paths resolve to root .planning (regression guard)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Setup' }]);

    const result = runGsdTools('init complete-milestone', tmpDir, { GSD_WORKSTREAM: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
    assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
    assert.strictEqual(output.archive_dir, absPlanningPath(tmpDir, 'milestones'));
  });

  test('GSD_WORKSTREAM=alpha: paths resolve into the workstream, not root (#4455 regression)', () => {
    seedWorkstream(tmpDir, {
      name: 'alpha',
      state: '---\nstatus: active\n---\n# State\n',
      roadmap: '# Roadmap\n\n## Progress\n\n- [ ] **Phase 1: Setup**\n\n### Phase 1: Setup\n\n**Goal:** Bootstrap\n',
    });

    const result = runGsdTools('init complete-milestone', tmpDir, { GSD_WORKSTREAM: 'alpha' });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'workstreams', 'alpha', 'STATE.md'));
    assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'workstreams', 'alpha', 'ROADMAP.md'));
    assert.strictEqual(output.archive_dir, absPlanningPath(tmpDir, 'workstreams', 'alpha', 'milestones'));
    assert.notStrictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
    assert.notStrictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
    assert.notStrictEqual(output.archive_dir, absPlanningPath(tmpDir, 'milestones'));
  });
});

describe('init complete-milestone — milestones_path/project_path/requirements_path (#4455 follow-up)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = require('fs').realpathSync(createTempProject());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeRootProjectMd(dir) {
    fs.writeFileSync(path.join(dir, '.planning', 'PROJECT.md'), '# Test Project\n');
  }

  test('flat mode: milestones_path/requirements_path resolve to root, project_path resolves to root (regression guard)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Setup' }]);
    writeRootProjectMd(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), '# Milestones\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');

    const result = runGsdTools('init complete-milestone', tmpDir, { GSD_WORKSTREAM: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.milestones_path, absPlanningPath(tmpDir, 'MILESTONES.md'));
    assert.strictEqual(output.project_path, absPlanningPath(tmpDir, 'PROJECT.md'));
    assert.strictEqual(output.requirements_path, absPlanningPath(tmpDir, 'REQUIREMENTS.md'));
  });

  test('GSD_WORKSTREAM=alpha: milestones_path/requirements_path resolve into the workstream, but project_path STAYS root (PROJECT.md is shared, #4455 follow-up regression)', () => {
    seedWorkstream(tmpDir, {
      name: 'alpha',
      state: '---\nstatus: active\n---\n# State\n',
      roadmap: '# Roadmap\n\n## Progress\n\n- [ ] **Phase 1: Setup**\n\n### Phase 1: Setup\n\n**Goal:** Bootstrap\n',
    });
    // PROJECT.md is only ever written at root — cmdWorkstreamCreate never
    // creates a per-workstream copy (it is a documented shared file, see
    // gsd-core/references/workstream-flag.md's directory diagram).
    writeRootProjectMd(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'MILESTONES.md'), '# Milestones\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'REQUIREMENTS.md'), '# Requirements\n');

    const result = runGsdTools('init complete-milestone', tmpDir, { GSD_WORKSTREAM: 'alpha' });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.milestones_path, absPlanningPath(tmpDir, 'workstreams', 'alpha', 'MILESTONES.md'));
    assert.strictEqual(output.requirements_path, absPlanningPath(tmpDir, 'workstreams', 'alpha', 'REQUIREMENTS.md'));
    // The regression this test guards against: project_path must be the
    // ROOT PROJECT.md, never a workstream-scoped path that no writer ever
    // populates.
    assert.strictEqual(output.project_path, absPlanningPath(tmpDir, 'PROJECT.md'));
    assert.notStrictEqual(output.project_path, absPlanningPath(tmpDir, 'workstreams', 'alpha', 'PROJECT.md'));
  });

  test('GSD_PROJECT=second-product: project_path resolves into the PROJECT namespace, not root (#3749 regression — round 1 of this fix broke this)', () => {
    // The FIRST version of this #4455 follow-up resolved project_path via
    // planningRoot(cwd), which ignores GSD_PROJECT entirely — gsd-test caught
    // this immediately (tests/init.test.cjs's pre-existing #3749 coverage) on
    // this fix's own first push. PROJECT.md is shared across a project's own
    // WORKSTREAMS, but a DIFFERENT project (GSD_PROJECT) legitimately gets
    // its own separate PROJECT.md at `.planning/<project>/PROJECT.md`. The
    // correct resolution is planningDir(cwd, null) — `ws` explicitly nulled
    // (never read from GSD_WORKSTREAM), `project` left to default from
    // GSD_PROJECT.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'second-product'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'second-product', 'PROJECT.md'), '# Second Product\n');
    writeRootProjectMd(tmpDir); // an unrelated root PROJECT.md must not win

    const result = runGsdTools('init complete-milestone', tmpDir, { GSD_PROJECT: 'second-product' });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.project_path, absPlanningPath(tmpDir, 'second-product', 'PROJECT.md'));
    assert.notStrictEqual(output.project_path, absPlanningPath(tmpDir, 'PROJECT.md'));
  });

  test('GSD_PROJECT=second-product AND GSD_WORKSTREAM=alpha together: project_path follows the PROJECT namespace, ignoring the workstream', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'second-product', 'workstreams', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'second-product', 'PROJECT.md'), '# Second Product\n');

    const result = runGsdTools('init complete-milestone', tmpDir, { GSD_PROJECT: 'second-product', GSD_WORKSTREAM: 'alpha' });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.project_path, absPlanningPath(tmpDir, 'second-product', 'PROJECT.md'));
    assert.notStrictEqual(output.project_path,
      absPlanningPath(tmpDir, 'second-product', 'workstreams', 'alpha', 'PROJECT.md'));
  });
});

describe('withProjectRoot — project_title reads PROJECT.md from root even under a workstream (#4455 follow-up)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = require('fs').realpathSync(createTempProject());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Exercised via `init complete-milestone` rather than `init manager`:
  // cmdInitManager has its own readiness guard requiring STATE.md/ROADMAP.md
  // to already exist (see the "state_path/roadmap_path are null" test
  // above), which would obscure whether THIS test is actually exercising
  // withProjectRoot. Both commands share the same withProjectRoot helper.
  test('flat mode: project_title is populated from the root PROJECT.md (regression guard)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# My Test Project\n\nSome content.\n');

    const result = runGsdTools('init complete-milestone', tmpDir, { GSD_WORKSTREAM: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.project_title, 'My Test Project');
  });

  test('GSD_WORKSTREAM=alpha: project_title is STILL populated from the root PROJECT.md, not silently dropped (#4455 follow-up regression)', () => {
    seedWorkstream(tmpDir, {
      name: 'alpha',
      state: '---\nstatus: active\n---\n# State\n',
      roadmap: '# Roadmap\n\n## Progress\n\n- [ ] **Phase 1: Setup**\n\n### Phase 1: Setup\n\n**Goal:** Bootstrap\n',
    });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# My Test Project\n\nSome content.\n');

    const result = runGsdTools('init complete-milestone', tmpDir, { GSD_WORKSTREAM: 'alpha' });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.project_title, 'My Test Project',
      'project_title must be read from the shared root PROJECT.md even when a workstream is active');
  });
});

describe('init subcommands sharing the project_exists/project_path PROJECT.md pattern (#4455 follow-up)', () => {
  // A code-review pass on this fix's first draft found the identical
  // workstream-scoped-PROJECT.md bug (fixed above for cmdInitCompleteMilestone
  // and withProjectRoot) repeated verbatim, via grep, in six more cmdInit*
  // functions. Each is exercised here through its real CLI subcommand rather
  // than re-asserting src/init.cts internals directly, so a regression in the
  // router wiring would also be caught. `init manager` is deliberately
  // excluded: it has its own STATE.md/ROADMAP.md readiness guard (covered
  // separately above via `init complete-milestone`, which shares
  // withProjectRoot). `new-milestone` was originally deferred to #4456's own
  // new-milestone.md workstream-forwarding work (see PR #4543), but that PR
  // only exercised the *workflow's* `--ws` argv forwarding through a stubbed
  // gsd_run, never cmdInitNewMilestone's real project_exists/project_path
  // output — #4457 closes that gap by folding it into this loop; it has no
  // manager-style readiness precondition, so it fits the shared assertion
  // shape below without a dedicated test.
  const SUBCOMMANDS = ['ingest-docs', 'resume', 'progress', 'new-project', 'new-milestone'];

  let tmpDir;

  beforeEach(() => {
    tmpDir = require('fs').realpathSync(createTempProject());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const subcommand of SUBCOMMANDS) {
    test(`GSD_WORKSTREAM=alpha: "init ${subcommand}" resolves project_path to the shared root PROJECT.md`, () => {
      seedWorkstream(tmpDir, {
        name: 'alpha',
        state: '---\nstatus: active\n---\n# State\n',
        roadmap: '# Roadmap\n\n## Progress\n\n- [ ] **Phase 1: Setup**\n\n### Phase 1: Setup\n\n**Goal:** Bootstrap\n',
      });
      fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Test Project\n');

      const result = runGsdTools(`init ${subcommand}`, tmpDir, { GSD_WORKSTREAM: 'alpha' });
      assert.ok(result.success, `init ${subcommand} failed: ${result.error}`);
      const output = JSON.parse(result.output);

      assert.strictEqual(output.project_exists, true,
        `init ${subcommand}: project_exists must be true (root PROJECT.md exists), got: ${JSON.stringify(output.project_exists)}`);
      if ('project_path' in output) {
        assert.strictEqual(output.project_path, absPlanningPath(tmpDir, 'PROJECT.md'),
          `init ${subcommand}: project_path must resolve to the shared root PROJECT.md, got: ${output.project_path}`);
        assert.notStrictEqual(output.project_path, absPlanningPath(tmpDir, 'workstreams', 'alpha', 'PROJECT.md'),
          `init ${subcommand}: project_path must not resolve into the workstream directory`);
      }
    });
  }

  test('milestone-op: GSD_WORKSTREAM=alpha does not report project_exists=false for a root-only PROJECT.md', () => {
    // milestone-op does not expose a project_path field, only project_exists
    // via buildInitCompletenessFields — the coreComplete/init_incomplete fix.
    seedWorkstream(tmpDir, {
      name: 'alpha',
      state: '---\nstatus: active\n---\n# State\n',
      roadmap: '# Roadmap\n\n## Progress\n\n- [ ] **Phase 1: Setup**\n\n### Phase 1: Setup\n\n**Goal:** Bootstrap\n',
    });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Test Project\n');

    const result = runGsdTools('init milestone-op', tmpDir, { GSD_WORKSTREAM: 'alpha' });
    assert.ok(result.success, `init milestone-op failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.project_exists, true,
      `init milestone-op: project_exists must be true for a root-only PROJECT.md under a workstream, got: ${JSON.stringify(output.project_exists)}`);
  });
});

// #4458: init new-project's sub_repos_detected field reuses core-utils.cts's
// detectSubRepos instead of new-project.md's own (now-removed) narrower `find
// -exec test -d "{}/.git"` predicate, which required .git to be a DIRECTORY and
// so silently excluded linked git worktree children (.git is a FILE there).
describe('init new-project: sub_repos_detected (#4458)', () => {
  const { execFileSync } = require('child_process');
  const { createTempGitProject } = require('./helpers.cjs');
  const { GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

  let tmpDir;

  afterEach(() => {
    if (tmpDir) { cleanup(tmpDir); tmpDir = null; }
  });

  test('detects a REAL linked git worktree child, matching the issue #4458 repro exactly', () => {
    // `git worktree add` genuinely needs a real git repo -- this is the only
    // one of these three tests that does (createTempGitProject spawns
    // `git init` + a commit, real subprocess overhead on Windows CI's
    // Defender-scanned spawns; the other two tests below use the plain,
    // no-git createTempProject fixture instead, matching the pattern
    // already proven safe by the SUBCOMMANDS loop above running `init
    // new-project` against a non-git tmpDir).
    tmpDir = fs.realpathSync(createTempGitProject());
    const worktreeDir = path.join(tmpDir, 'child-wt');
    // `git worktree add` checks out files into a new working tree — the same
    // "construction" weight class as init/config/add/commit, not plain
    // plumbing (rev-parse/branch/log), so GIT_FIXTURE_TIMEOUT_MS is the
    // correct shared norm here (tests/helpers/timeouts.cjs).
    execFileSync('git', ['worktree', 'add', '-b', 'wt-branch', worktreeDir], { cwd: tmpDir, stdio: 'pipe', timeout: GIT_FIXTURE_TIMEOUT_MS });

    // Confirm the fixture actually reproduces the reported shape before
    // trusting the assertion below: a linked worktree's .git is a FILE.
    assert.ok(fs.statSync(path.join(worktreeDir, '.git')).isFile(),
      'fixture setup: linked worktree .git must be a file, not a directory');

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `init new-project failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.sub_repos_detected), 'sub_repos_detected must be an array');
    assert.ok(output.sub_repos_detected.includes('child-wt'),
      `sub_repos_detected must include the linked worktree child, got: ${JSON.stringify(output.sub_repos_detected)}`);
  });

  test('detects an ordinary child clone (.git as a directory) — no regression', () => {
    // detectSubRepos only inspects the CHILD directory's .git, not the
    // root's own git state -- a real outer repo isn't needed here, matching
    // the SUBCOMMANDS loop above.
    tmpDir = fs.realpathSync(createTempProject());
    const cloneDir = path.join(tmpDir, 'child-clone');
    fs.mkdirSync(path.join(cloneDir, '.git'), { recursive: true });

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `init new-project failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.sub_repos_detected.includes('child-clone'),
      `sub_repos_detected must include the ordinary child clone, got: ${JSON.stringify(output.sub_repos_detected)}`);
  });

  test('does not report an ordinary non-repository directory as a sub-repo', () => {
    tmpDir = fs.realpathSync(createTempProject());
    fs.mkdirSync(path.join(tmpDir, 'not-a-repo'));

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `init new-project failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(!output.sub_repos_detected.includes('not-a-repo'),
      `sub_repos_detected must not include a plain non-repo directory, got: ${JSON.stringify(output.sub_repos_detected)}`);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3584-runtime-slash-emitters.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3584-runtime-slash-emitters (consolidation epic #1969 B2 #1971)", () => {
/**
 * Regression tests for bug #3584 — runtime emitters use the slash formatter.
 *
 * These tests exercise the actual runtime command handlers via `runGsdTools`
 * and assert on the structured payloads they emit/persist. They prove that
 * the high-impact emitters identified in the issue (`init.cjs` recommended
 * actions, `phase.cjs` ROADMAP persistence, `verify.cjs` remediation hints,
 * `milestone.cjs` Operator-Next-Steps persistence, `validate-command-router`
 * fracture recommendations) no longer emit the unroutable `/gsd:<cmd>` colon
 * form for skills-based runtimes.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  runGsdTools,
  createTempProject,
  createTempDir,
  cleanup,
} = require('./helpers.cjs');

// Helper: assert no string field anywhere in `value` (recursive) contains '/gsd:'.
function assertNoColonForm(value, label) {
  const stack = [{ v: value, p: label }];
  while (stack.length > 0) {
    const { v, p } = stack.pop();
    if (typeof v === 'string') {
      assert.ok(
        !v.includes('/gsd:'),
        `${p}: must not contain deprecated /gsd: form, got ${JSON.stringify(v)}`,
      );
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => stack.push({ v: item, p: `${p}[${i}]` }));
    } else if (v && typeof v === 'object') {
      for (const key of Object.keys(v)) {
        stack.push({ v: v[key], p: `${p}.${key}` });
      }
    }
  }
}

// Helper: collect every `command` string under a recommendedActions-style array.
function collectCommandFields(value) {
  const out = [];
  const stack = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (v && typeof v === 'object') {
      if (typeof v.command === 'string') out.push(v.command);
      for (const key of Object.keys(v)) stack.push(v[key]);
    }
  }
  return out;
}

describe('bug-3584: init manager recommendedActions emit hyphen form', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Minimal ROADMAP + STATE so init manager will run.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Milestone v1',
        '',
        '### Phase 1: Foundation',
        '**Goal:** scaffold',
        '**Plans:** 1 plan',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\nCurrent Phase: 1\n',
    );
  });

  afterEach(() => cleanup(tmpDir));

  test('skills runtime (claude) emits /gsd-<cmd> in recommended_actions[].command', () => {
    // Plan-but-not-executed: directory exists with a PLAN.md → execute is recommended.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('init manager', tmpDir, { GSD_RUNTIME: 'claude' });
    assert.ok(result.success, `init manager failed: ${result.error || result.output}`);

    const payload = JSON.parse(result.output);
    const commands = collectCommandFields(payload.recommended_actions || []);
    assert.ok(commands.length > 0, 'recommended_actions should produce at least one command');

    for (const cmd of commands) {
      assert.ok(
        cmd.startsWith('/gsd-'),
        `recommended_actions command must start with /gsd- for skills-based runtimes, got ${cmd}`,
      );
      assert.ok(
        !cmd.includes('/gsd:'),
        `recommended_actions command must not contain /gsd: colon form, got ${cmd}`,
      );
    }
    assertNoColonForm(payload, 'init.manager payload');
  });

  test('codex runtime emits $gsd-<cmd> in recommended_actions[].command', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('init manager', tmpDir, { GSD_RUNTIME: 'codex' });
    assert.ok(result.success, `init manager (codex) failed: ${result.error || result.output}`);

    const payload = JSON.parse(result.output);
    const commands = collectCommandFields(payload.recommended_actions || []);
    assert.ok(commands.length > 0);

    for (const cmd of commands) {
      assert.ok(
        cmd.startsWith('$gsd-'),
        `codex recommended_actions command must use $gsd- shell-var form, got ${cmd}`,
      );
    }
  });

  test('codex alias runtime emits $gsd-<cmd> in recommended_actions[].command', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('init manager', tmpDir, { GSD_RUNTIME: 'codex-app' });
    assert.ok(result.success, `init manager (codex-app) failed: ${result.error || result.output}`);

    const payload = JSON.parse(result.output);
    const commands = collectCommandFields(payload.recommended_actions || []);
    assert.ok(commands.length > 0);

    for (const cmd of commands) {
      assert.ok(
        cmd.startsWith('$gsd-'),
        `codex alias recommended_actions command must use $gsd- shell-var form, got ${cmd}`,
      );
    }
  });
});

describe('bug-3584: phase add persists hyphen form into ROADMAP.md', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Milestone v1\n\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n',
    );
  });

  afterEach(() => cleanup(tmpDir));

  test('phase add persists hyphen-form slash command in roadmap get-phase payload', () => {
    // 1. Add a phase — the system under test persists the phase entry into ROADMAP.md.
    const addResult = runGsdTools(
      ['phase', 'add', 'Test new feature'],
      tmpDir,
      { GSD_RUNTIME: 'claude' },
    );
    assert.ok(addResult.success, `phase add failed: ${addResult.error || addResult.output}`);
    const addPayload = JSON.parse(addResult.output);
    assert.ok(addPayload.phase_number, 'phase add must return phase_number');

    // 2. Read the persisted section back via the structured roadmap-get-phase
    //    contract (NOT via readFileSync; the `section` field on the JSON payload
    //    is the runtime's typed projection of the on-disk ROADMAP content).
    const getResult = runGsdTools(
      ['roadmap', 'get-phase', String(addPayload.phase_number)],
      tmpDir,
      { GSD_RUNTIME: 'claude' },
    );
    assert.ok(getResult.success, `roadmap get-phase failed: ${getResult.error || getResult.output}`);
    const getPayload = JSON.parse(getResult.output);
    assert.ok(getPayload.found, 'roadmap get-phase must find the newly-added phase');
    assert.ok(typeof getPayload.section === 'string', 'roadmap get-phase must return a section field');

    // 3. The persisted phase section must use the routable hyphen form.
    assert.ok(
      !getPayload.section.includes('/gsd:plan-phase'),
      `persisted phase section must not contain /gsd:plan-phase, got: ${getPayload.section}`,
    );
    assert.ok(
      getPayload.section.includes('/gsd-plan-phase'),
      `persisted phase section must contain /gsd-plan-phase, got: ${getPayload.section}`,
    );
  });
});

describe('bug-3584: validate health emits hyphen form in fix hints', () => {
  test('validate health on a broken project returns hyphen-form fix strings', (t) => {
    const tmpDir = createTempDir();
    t.after(() => cleanup(tmpDir));
    // No .planning directory → E001 fires with a `fix:` string that contains
    // the slash-command form.

    const result = runGsdTools(
      ['validate', 'health'],
      tmpDir,
      { GSD_RUNTIME: 'claude' },
    );
    // validate health exits non-zero on broken projects but still emits JSON to stdout.
    const stdout = result.output;
    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`validate health did not emit parseable JSON: ${stdout.slice(0, 400)}`);
    }

    const allIssues = []
      .concat(payload.errors || [])
      .concat(payload.warnings || [])
      .concat(payload.info || []);

    assert.ok(allIssues.length > 0, 'validate health on a bare tmpdir should report at least one issue');

    const fixesWithSlash = allIssues
      .map((i) => i.fix)
      .filter((f) => typeof f === 'string' && /gsd[-:]/.test(f));
    assert.ok(
      fixesWithSlash.length > 0,
      'at least one fix hint should reference a /gsd- slash command',
    );

    for (const fix of fixesWithSlash) {
      assert.ok(
        !fix.includes('/gsd:'),
        `validate health fix hint must not contain /gsd: colon form, got ${JSON.stringify(fix)}`,
      );
    }
    assertNoColonForm(payload, 'validate health payload');
  });
});

describe('bug-3584: validate context recommendation uses hyphen form', () => {
  test('warning/critical recommendations emit /gsd-thread', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // Critical band: 75% utilization. validate context emits JSON only with --json.
    const result = runGsdTools(
      ['validate', 'context', '--tokens-used', '75000', '--context-window', '100000', '--json'],
      tmpDir,
      { GSD_RUNTIME: 'claude' },
    );
    assert.ok(result.success, `validate context failed: ${result.error || result.output}`);

    const payload = JSON.parse(result.output);
    assert.ok(payload.recommendation, 'critical utilization should produce a recommendation');
    assert.ok(
      !payload.recommendation.includes('/gsd:'),
      `recommendation must not contain /gsd:, got ${JSON.stringify(payload.recommendation)}`,
    );
    assert.ok(
      payload.recommendation.includes('/gsd-thread'),
      `recommendation must reference /gsd-thread, got ${JSON.stringify(payload.recommendation)}`,
    );
  });
});

describe('bug-3584: validate health uses formatter for codex runtime too', () => {
  test('validate health under codex emits $gsd-<cmd> in fix strings (positive assertion)', (t) => {
    const tmpDir = createTempDir();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['validate', 'health'],
      tmpDir,
      { GSD_RUNTIME: 'codex' },
    );
    let payload;
    try {
      payload = JSON.parse(result.output);
    } catch (e) {
      throw new Error(`validate health (codex) did not emit JSON: ${result.output.slice(0, 400)}`);
    }

    const allIssues = []
      .concat(payload.errors || [])
      .concat(payload.warnings || [])
      .concat(payload.info || []);

    // Collect fixes that mention any gsd slash-command form so we can lock
    // both the absence of legacy forms AND the presence of the codex shape.
    const fixesWithGsdRef = allIssues
      .map((i) => i.fix)
      .filter((f) => typeof f === 'string' && /(?:\$|\/)gsd[-:]/.test(f));

    assert.ok(
      fixesWithGsdRef.length > 0,
      'validate health on a bare tmpdir must produce at least one fix hint referencing a gsd command',
    );

    for (const fix of fixesWithGsdRef) {
      assert.ok(
        fix.includes('$gsd-'),
        `codex validate health fix must use shell-var $gsd- form, got ${JSON.stringify(fix)}`,
      );
      assert.ok(
        !fix.includes('/gsd:'),
        `codex validate health fix must not contain /gsd: colon form, got ${JSON.stringify(fix)}`,
      );
      assert.ok(
        !fix.includes('/gsd-'),
        `codex validate health fix must not contain /gsd- (skills) form, got ${JSON.stringify(fix)}`,
      );
    }
  });
});
  });
}

// ─── #4764: dep_phases extracts only in-context phase references ────────────

describe('#4764 dep_phases extracts only Phase-prefixed references', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // The issue's measured phase-663 prose: dates, a round name, ledger ids and
  // the row's own number, plus one genuine "Phase 654" mention.
  const ISSUE_663_PROSE =
    'Nothing. Round 663-DISPOSITION Q7 (3/3, 2026-09-14, ' +
    '`.planning/decisions/663-CROSSAI-stream-consumer-failure-disposition.md`) moved the ' +
    '"for retry" javadoc correction into this phase and dropped the dependency on Phase 654; ' +
    'the defect is already recorded (WINDOWS #1843, #1977-#1985, #1992).';

  test("#4764: dep_phases extracts only Phase-prefixed references from the issue's measured prose", () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '663', name: 'Disposition phase', depends_on: ISSUE_663_PROSE },
      { number: '654', name: 'Prior phase' },
    ]);

    const output = JSON.parse(runGsdTools('init manager', tmpDir).output);
    const row = output.phases.find((p) => p.number === '663');

    assert.deepEqual(row.dep_phases, ['654']);
    for (const junk of ['663', '2026', '09', '14', '7', '3', '1843', '1977', '1985', '1992']) {
      assert.ok(!row.dep_phases.includes(junk), `must not scrape ${junk} as a dependency`);
    }
    assert.strictEqual(row.deps_satisfied, false, '654 is incomplete — the only real reference');
  });

  test('#4764: a date-only depends_on prose yields no dependencies and a satisfied row', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '674', name: 'Ops current', depends_on: 'Nothing. Opened by the owner on 2026-09-15 after asking whether the operations app was current with the backend.' },
    ]);

    const output = JSON.parse(runGsdTools('init manager', tmpDir).output);
    const row = output.phases.find((p) => p.number === '674');

    assert.deepEqual(row.dep_phases, []);
    assert.strictEqual(row.deps_satisfied, true);
    assert.strictEqual(row.deps_display, '—');
  });

  test('#4764: sha-bearing prose contributes no dependency tokens', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '607', name: 'Sha phase', depends_on: 'Landed in 8bf403100d and 9445745c08; follow-up 76aea5c36f tracked separately.' },
    ]);

    const output = JSON.parse(runGsdTools('init manager', tmpDir).output);
    const row = output.phases.find((p) => p.number === '607');

    assert.deepEqual(row.dep_phases, []);
    assert.strictEqual(row.deps_satisfied, true);
  });

  test('#4764: Phase lists stay fully extracted (and/comma separators)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'A', complete: true },
      { number: '2', name: 'B', complete: true },
      { number: '3', name: 'C', depends_on: 'Phases 1 and 2' },
      { number: '4', name: 'D', depends_on: 'Phase 1, Phase 2' },
      { number: '5', name: 'E', depends_on: 'Phase 1 & 2' },
      { number: '6', name: 'F', depends_on: 'Phase 1 to 2' },
    ]);
    // Completion is DISK-strict (ADR-3180): a ticked checkbox does not feed
    // completedNums — the dep targets need real dirs + passed verifications.
    for (const n of [1, 2]) {
      writePassedVerification(scaffoldPhase(tmpDir, n, { plans: 1, summaries: 1 }), `0${n}`);
    }

    const output = JSON.parse(runGsdTools('init manager', tmpDir).output);
    assert.deepEqual(output.phases.find((p) => p.number === '3').dep_phases, ['1', '2']);
    assert.deepEqual(output.phases.find((p) => p.number === '4').dep_phases, ['1', '2']);
    assert.deepEqual(output.phases.find((p) => p.number === '5').dep_phases, ['1', '2'], '& separator');
    assert.deepEqual(output.phases.find((p) => p.number === '6').dep_phases, ['1', '2'], 'to-range separator');
    assert.strictEqual(output.phases.find((p) => p.number === '3').deps_satisfied, true);
    assert.strictEqual(output.phases.find((p) => p.number === '5').deps_satisfied, true);
    assert.strictEqual(output.phases.find((p) => p.number === '6').deps_satisfied, true);
  });

  test('#4764: Oxford-comma lists stay fully extracted, and a missing member blocks', () => {
    // Adversarial-review fold-in: "Phases 1, 2, and 3" is the most common
    // English enumeration; the first grammar cut dropped 603-style tail
    // members, silently clearing a real blocker (the dangerous direction).
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'A', complete: true },
      { number: '2', name: 'B', complete: true },
      { number: '3', name: 'C', depends_on: 'Phases 1, 2, and 3' },
    ]);
    for (const n of [1, 2]) {
      writePassedVerification(scaffoldPhase(tmpDir, n, { plans: 1, summaries: 1 }), `0${n}`);
    }

    const output = JSON.parse(runGsdTools('init manager', tmpDir).output);
    const row = output.phases.find((p) => p.number === '3');
    assert.deepEqual(row.dep_phases, ['1', '2']);
    assert.strictEqual(row.deps_satisfied, true);
  });

  test('#4764: hyphen ranges extract both endpoints and a missing tail blocks', () => {
    // House style writes ranges ("Phases 1-9"); endpoints are the written
    // references (the pre-#4764 scrape also kept only endpoints).
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'A', complete: true },
      { number: '3', name: 'C' },
      { number: '4', name: 'D', depends_on: 'Phases 1-3' },
    ]);
    writePassedVerification(scaffoldPhase(tmpDir, 1, { plans: 1, summaries: 1 }), '01');

    const output = JSON.parse(runGsdTools('init manager', tmpDir).output);
    const row = output.phases.find((p) => p.number === '4');
    assert.deepEqual(row.dep_phases, ['1', '3']);
    assert.strictEqual(row.deps_satisfied, false, '3 is incomplete — a real blocker must not be dropped');
  });

  test('#4764 property: extraction pulls exactly the Phase-prefixed references out of arbitrary prose', () => {
    // House fast-check config (seed 42); per-call numRuns caps the cost — each
    // run spawns the real CLI (runGsdTools), unlike the pure-function properties.
    const fc = require('./helpers/fast-check-setup.cjs');
    // Junk fragments whose digit runs the old whole-field scrape pulled in as
    // "dependencies": calendar dates, git shas, ledger ids, counts, round names.
    // (fc v4 has no hexaString — stringMatching is the legal sha generator.)
    const junkFragments = [
      fc.nat({ max: 28 }).map((d) => `2026-09-${String(d).padStart(2, '0')}`),
      fc.stringMatching(/[0-9a-f]{8,10}/),
      fc.nat({ max: 99999 }).map((n) => `WINDOWS #${n}`),
      fc.nat({ max: 999 }).map((n) => `#${n}-#${n + 1}`),
      fc.nat({ max: 9 }).map((n) => `round ${n}-DISPOSITION (${n}/3`),
    ];
    const refFragment = fc.nat({ max: 8 }).map((n) => `Phase ${n + 1}`);
    const listFragment = fc.nat({ max: 7 }).map((n) => `Phases ${n + 1}, ${n + 2}, and ${n + 3}`);
    const selfFragment = fc.constant('Phase 9');

    // The phase under test is 9: any "Phase 9" mention in its own prose must be
    // dropped as a self-reference.
    fc.assert(
      fc.property(
        fc.array(fc.oneof(...junkFragments, refFragment, listFragment, selfFragment), { maxLength: 12 }),
        (fragments) => {
          writeState(tmpDir);
          writeRoadmap(tmpDir, [
            { number: '9', name: 'Property phase', depends_on: fragments.join('; ') + '.' },
            { number: '1', name: 'Ref target', complete: true },
          ]);
          const output = JSON.parse(runGsdTools('init manager', tmpDir).output);
          const row = output.phases.find((p) => p.number === '9');
          const extracted = row.dep_phases.map((d) => String(d));

          // Independent spec mirror: the expected set is every phase token a
          // fragment references ("Phase N" or inside a "Phases …" list),
          // minus the row's own number — junk never contributes.
          const expected = new Set();
          for (const f of fragments) {
            const refMatch = /^phases?\s+(.*)$/i.exec(f);
            if (!refMatch) continue;
            for (const tok of refMatch[1].match(/\d+(?:\.\d+)*/g) || []) {
              if (tok !== '9') expected.add(tok);
            }
          }
          assert.deepEqual(
            [...extracted].sort(),
            [...expected].sort(),
            `extraction must pull exactly the Phase-prefixed references from: ${fragments.join('; ')}`,
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});
