'use strict';

/**
 * Unit tests for the smart-entry situation classifier.
 *
 * Spec: docs/superpowers/specs/2026-06-27-gsd-smart-entry-design.md
 *
 * Covers: all 11 situations, priority ordering (paused beats blocked), JSON
 * shape invariants (exactly one recommended, commands are /gsd:* slash forms),
 * and the --json / human output modes.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const smartEntry = require('../gsd-core/bin/lib/smart-entry.cjs');
const { classify, classifyProject, detectSignals, SITUATIONS } = smartEntry;
const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/**
 * Create a temp dir with a `.planning/` and optional STATE.md / ROADMAP.md.
 * @returns {string} tmpDir path
 */
function makeProject({ state, roadmap = false, git = false, verifyFail = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-se-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  if (state !== undefined) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), state);
  }
  if (roadmap) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
  }
  if (git) {
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: tmpDir, stdio: 'pipe' });
  }
  if (verifyFail) {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-feat');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, 'SUMMARY.md'),
      '# Summary\n\nSTATUS: blocked\n',
    );
  }
  return tmpDir;
}

/** Minimal STATE.md frontmatter body. */
function state(opts) {
  const fm = { ...opts };
  // status goes in frontmatter as `status`; we also mirror as a body table for
  // robustness against either format the real STATE.md uses.
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push('---', '', '# State', '');
  if (fm.status) lines.push(`**Status:** ${fm.status}`);
  return lines.join('\n') + '\n';
}

const CLEANUP = [];
function track(dir) {
  CLEANUP.push(dir);
  return dir;
}
function removeAll() {
  for (const dir of CLEANUP) {
    cleanup(dir);
  }
  CLEANUP.length = 0;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('smart-entry: situation coverage', () => {
  afterEach(removeAll);

  const CASES = [
    ['no-project', () => {
      // Truly empty dir — no .planning at all.
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-se-none-'));
      return track(d);
    }],
    ['paused', () => track(makeProject({ state: state({ status: 'planning', paused_at: '2026-06-01T00:00:00Z' }), roadmap: true }))],
    ['blocked', () => track(makeProject({ state: state({ status: 'executing', total_phases: 5, current_phase: 2 }) + '\n## Blockers\n\n- Need API key\n', roadmap: true }))],
    ['verify-failed', () => track(makeProject({ state: state({ status: 'verify-failed', total_phases: 5, current_phase: 2 }), roadmap: true, verifyFail: true }))],
    ['needs-first-phase', () => track(makeProject({ state: state({ status: 'planning', total_phases: 0, current_phase: 0 }) }))],
    ['planning', () => track(makeProject({ state: state({ status: 'planning', total_phases: 5, current_phase: 2 }), roadmap: true }))],
    ['executing', () => track(makeProject({ state: state({ status: 'executing', total_phases: 5, current_phase: 2, progress: 60 }), roadmap: true }))],
    ['verify-pending', () => track(makeProject({ state: state({ status: 'needs-review', total_phases: 5, current_phase: 2 }), roadmap: true }))],
    ['complete', () => track(makeProject({ state: state({ status: 'complete', total_phases: 5, current_phase: 5 }), roadmap: true }))],
    ['unknown', () => track(makeProject({ state: state({ status: '', total_phases: 5, current_phase: 2 }), roadmap: true }))],
  ];

  for (const [expected, factory] of CASES) {
    test(`classifies "${expected}"`, () => {
      const dir = factory();
      const result = classifyProject(dir);
      assert.equal(result.situation, expected);
    });
  }

  test('SITUATIONS constant lists all 11 (incl unknown) and is frozen', () => {
    assert.equal(SITUATIONS.length, 11);
    assert.ok(SITUATIONS.includes('unknown'));
    assert.ok(Object.isFrozen(SITUATIONS));
  });
});

describe('smart-entry: idle-stranded (git-dependent)', () => {
  afterEach(removeAll);

  test('clean tree + unpushed commits → idle-stranded, recommended ship', () => {
    // idle-stranded is the fallback AFTER the status predicates: it fires for an
    // ambiguous status (matches none of planning/executing/verify/complete) with
    // unpushed committed work. Use an empty status to land here deterministically.
    const dir = track(makeProject({
      state: state({ status: '', total_phases: 5, current_phase: 2 }),
      roadmap: true,
      git: true,
    }));
    // Commit the .planning files so the working tree is clean (untracked files
    // would make git_dirty true and mask the stranded signal).
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
    const base = detectSignals(dir);
    assert.equal(base.git_dirty, false);
    assert.equal(base.git_unpushed, false);

    // Force the stranded signal and assert the situation + recommendation.
    const forced = { ...base, git_unpushed: true };
    assert.equal(classify(forced), 'idle-stranded');
  });

  test('idle-stranded action set recommends ship', () => {
    const dir = track(makeProject({
      state: state({ status: '', total_phases: 5, current_phase: 2 }),
      roadmap: true,
    }));
    const base = detectSignals(dir);
    const forced = { ...base, git_unpushed: true };
    const situation = classify(forced);
    assert.equal(situation, 'idle-stranded');
    const actions = smartEntry.actionsFor(situation, forced);
    assert.equal(actions[0].id, 'ship');
    assert.equal(actions[0].recommended, true);
    assert.equal(actions[0].command, '/gsd:ship');
  });
});

describe('smart-entry: priority ordering', () => {
  afterEach(removeAll);

  test('verify-failed inspects current phase verify artifact', () => {
    const dir = track(makeProject({
      state: state({ status: 'executing', total_phases: 10, current_phase: 100 }),
      roadmap: true,
    }));
    const phaseNinetyNine = path.join(dir, '.planning', 'phases', '99-old-phase');
    const phaseOneHundred = path.join(dir, '.planning', 'phases', '100-current-phase');
    fs.mkdirSync(phaseNinetyNine, { recursive: true });
    fs.mkdirSync(phaseOneHundred, { recursive: true });
    fs.writeFileSync(path.join(phaseNinetyNine, '99-VERIFICATION.md'), 'STATUS: passed\n');
    fs.writeFileSync(path.join(phaseOneHundred, '100-VERIFICATION.md'), 'STATUS: failed\n');

    const result = classifyProject(dir);

    assert.equal(result.situation, 'verify-failed');
    assert.equal(result.signals.verify_failed, true);
  });

  test('verify-failed ignores failure in a higher phase when state is on an earlier phase', () => {
    const dir = track(makeProject({
      state: state({ status: 'executing', total_phases: 10, current_phase: 2 }),
      roadmap: true,
    }));
    const phaseTwo = path.join(dir, '.planning', 'phases', '02-active-phase');
    const phaseOneHundred = path.join(dir, '.planning', 'phases', '100-leftover-phase');
    fs.mkdirSync(phaseTwo, { recursive: true });
    fs.mkdirSync(phaseOneHundred, { recursive: true });
    fs.writeFileSync(path.join(phaseTwo, '02-VERIFICATION.md'), 'STATUS: passed\n');
    fs.writeFileSync(path.join(phaseOneHundred, '100-VERIFICATION.md'), 'STATUS: failed\n');

    const result = classifyProject(dir);

    assert.equal(result.situation, 'executing');
    assert.equal(result.signals.verify_failed, false);
  });

  test('verify-failed includes decimal phase directories for the current phase', () => {
    const dir = track(makeProject({
      state: state({ status: 'executing', total_phases: 10, current_phase: '7.1' }),
      roadmap: true,
    }));
    const phaseSeven = path.join(dir, '.planning', 'phases', '07-base-phase');
    const phaseSevenOne = path.join(dir, '.planning', 'phases', '07.1-inserted-phase');
    fs.mkdirSync(phaseSeven, { recursive: true });
    fs.mkdirSync(phaseSevenOne, { recursive: true });
    fs.writeFileSync(path.join(phaseSeven, '07-VERIFICATION.md'), 'STATUS: passed\n');
    fs.writeFileSync(path.join(phaseSevenOne, '07.1-VERIFICATION.md'), 'STATUS: failed\n');

    const result = classifyProject(dir);

    assert.equal(result.situation, 'verify-failed');
    assert.equal(result.signals.verify_failed, true);
  });

  test('paused beats blocked (earlier row wins)', () => {
    const dir = track(makeProject({
      // paused_at set AND blockers present AND a phase loop: must resolve paused.
      state: state({ status: 'executing', total_phases: 5, current_phase: 2, paused_at: '2026-06-01T00:00:00Z' })
        + '\n## Blockers\n\n- blocker one\n',
      roadmap: true,
    }));
    const result = classifyProject(dir);
    assert.equal(result.situation, 'paused');
  });

  test('blocked beats planning (earlier row wins)', () => {
    const dir = track(makeProject({
      state: state({ status: 'planning', total_phases: 5, current_phase: 2 })
        + '\n## Blockers\n\n- blocker one\n',
      roadmap: true,
    }));
    const result = classifyProject(dir);
    assert.equal(result.situation, 'blocked');
  });

  test('no-project beats everything (no .planning)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-se-empty-'));
    track(tmpDir);
    const result = classifyProject(tmpDir);
    assert.equal(result.situation, 'no-project');
  });
});

describe('smart-entry: real STATE.md schema (nested progress YAML + body Phase field)', () => {
  afterEach(removeAll);

  // Mirrors this repo's actual .planning/STATE.md: status + nested progress{}
  // in frontmatter, phase number in the body as `Phase: N`. Codex review found
  // the classifier originally misread this as needs-first-phase (#P1).
  function realState({ status, phase, totalPhases, percent }) {
    const fm = [
      '---',
      'gsd_state_version: 1.0',
      `status: ${status}`,
      'last_activity: 2026-06-13',
      'progress:',
      `  total_phases: ${totalPhases}`,
      `  percent: ${percent}`,
      '---',
      '',
      '# Project State',
      '',
      `Phase: ${phase}`,
      '',
      `**Status:** ${status}`,
      '',
    ].join('\n');
    return fm;
  }

  test('reads current_phase from body `Phase:` + total_phases/percent from nested progress{}', () => {
    const dir = track(makeProject({
      state: realState({ status: 'verifying', phase: 3, totalPhases: 5, percent: 40 }),
      roadmap: true,
    }));
    const signals = detectSignals(dir);
    assert.equal(signals.current_phase, 3, 'current_phase from body Phase: field');
    assert.equal(signals.total_phases, 5, 'total_phases from nested progress.total_phases');
    assert.equal(signals.progress, 40, 'percent from nested progress.percent');
    assert.equal(signals.status, 'verifying');
  });

  test('classifies verify-pending (not needs-first-phase) for an active real-schema project', () => {
    const dir = track(makeProject({
      state: realState({ status: 'verifying', phase: 3, totalPhases: 5, percent: 40 }),
      roadmap: true,
    }));
    const result = classifyProject(dir);
    assert.equal(result.situation, 'verify-pending');
    // Forward motion delegates to the gated engine; verify-work stays available.
    assert.equal(result.recommended, 'progress-next');
    assert.match(result.summary, /Phase 3 of 5/);
  });

  test('executing status with nested progress schema classifies executing', () => {
    const dir = track(makeProject({
      state: realState({ status: 'executing', phase: 2, totalPhases: 5, percent: 60 }),
      roadmap: true,
    }));
    const result = classifyProject(dir);
    assert.equal(result.situation, 'executing');
    // Forward motion delegates to /gsd:progress --next, not a raw execute-phase.
    assert.equal(result.recommended, 'progress-next');
  });
});

describe('smart-entry: in-project advancement delegates to the gated engine', () => {
  afterEach(removeAll);

  // Reconciliation guard (#1787): /gsd:next must not re-implement forward routing.
  // For every in-project forward-motion situation the recommended action is
  // `/gsd:progress --next` (workflows/next.md), so Route 0's resume-incomplete
  // -phase invariant + Gates 1-3 are never bypassed. Re-deriving advancement here
  // is what got the old flat /gsd-next removed (#3054). The specific command
  // (execute-phase / plan-phase / verify-work) stays as an explicit secondary.
  for (const situation of ['planning', 'executing', 'verify-pending']) {
    test(`${situation}: recommended action is /gsd:progress --next`, () => {
      const signals = {
        current_phase: 2, total_phases: 5, status: situation, progress: 40,
        has_planning: true, has_roadmap: true, git_dirty: false, git_unpushed: false,
        paused: false, blockers: [], has_git: true, verify_failed: false, stale_activity: false,
      };
      const actions = smartEntry.actionsFor(situation, signals);
      const recommended = actions.filter((a) => a.recommended);
      assert.equal(recommended.length, 1, 'exactly one recommended action');
      assert.equal(recommended[0].command, '/gsd:progress --next');
    });
  }

  // Remediation / lifecycle situations are OFF the linear advance path — they
  // keep direct specific recommendations (their distinct value over --next).
  const DIRECT = {
    'no-project': '/gsd:new-project',
    paused: '/gsd:resume-work',
    blocked: '/gsd:debug',
    'verify-failed': '/gsd:verify-work',
    'idle-stranded': '/gsd:ship',
    complete: '/gsd:new-milestone',
  };
  for (const [situation, command] of Object.entries(DIRECT)) {
    test(`${situation}: keeps its direct recommendation (${command})`, () => {
      const signals = {
        current_phase: 2, total_phases: 5, status: situation, progress: 40,
        has_planning: true, has_roadmap: true, git_dirty: false, git_unpushed: false,
        paused: false, blockers: [], has_git: true, verify_failed: false, stale_activity: false,
      };
      const actions = smartEntry.actionsFor(situation, signals);
      const recommended = actions.find((a) => a.recommended);
      assert.equal(recommended.command, command);
    });
  }
});

describe('smart-entry: per-situation action invariants (all 11)', () => {
  // Lock the action-set contract for EVERY situation, not just the 6 sampled by
  // the JSON-shape test: exactly one recommended, 1-4 actions, unique ids, and
  // /gsd:* command forms. Guards the reconciliation (and future edits) against
  // silently breaking these for a less-common situation.
  const sampleSignals = {
    current_phase: 2, total_phases: 5, status: 'executing', progress: 60,
    has_planning: true, has_roadmap: true, git_dirty: false, git_unpushed: false,
    paused: false, blockers: [], has_git: true, verify_failed: false, stale_activity: false,
  };
  for (const situation of SITUATIONS) {
    test(`${situation}: exactly one recommended, 1-4 unique-id /gsd:* actions`, () => {
      const actions = smartEntry.actionsFor(situation, sampleSignals);
      assert.ok(actions.length >= 1 && actions.length <= 4, `${situation}: 1-4 actions (got ${actions.length})`);
      assert.equal(actions.filter((a) => a.recommended).length, 1, `${situation}: exactly one recommended`);
      const ids = actions.map((a) => a.id);
      assert.equal(new Set(ids).size, ids.length, `${situation}: action ids are unique`);
      for (const a of actions) {
        assert.ok(a.command.startsWith('/gsd:'), `${situation}/${a.id}: command is a /gsd: slash form`);
      }
    });
  }
});

describe('smart-entry: JSON shape invariants', () => {
  afterEach(removeAll);

  test('every situation yields exactly one recommended action and /gsd:* commands', () => {
    const dirs = [
      track(makeProject()),                                            // no-project
      track(makeProject({ state: state({ status: 'planning', paused_at: '2026-06-01T00:00:00Z' }), roadmap: true })), // paused
      track(makeProject({ state: state({ status: 'executing', total_phases: 5, current_phase: 2 }) + '\n## Blockers\n- b\n', roadmap: true })), // blocked
      track(makeProject({ state: state({ status: 'executing', total_phases: 5, current_phase: 2, progress: 60 }), roadmap: true })), // executing
      track(makeProject({ state: state({ status: 'complete', total_phases: 5, current_phase: 5 }), roadmap: true })), // complete
      track(makeProject({ state: state({ status: '', total_phases: 5, current_phase: 2 }), roadmap: true })),         // unknown
    ];
    for (const dir of dirs) {
      const result = classifyProject(dir);
      const recommended = result.actions.filter((a) => a.recommended);
      assert.equal(recommended.length, 1, `${result.situation}: exactly one recommended`);
      assert.equal(recommended[0].id, result.recommended, `${result.situation}: recommended id matches`);
      for (const a of result.actions) {
        assert.ok(a.command.startsWith('/gsd:'), `${result.situation}/${a.id}: command is a slash form`);
      }
      assert.ok(result.summary.length > 0, `${result.situation}: summary non-empty`);
      assert.ok(result.actions.length >= 1 && result.actions.length <= 4, `${result.situation}: 1-4 actions`);
    }
  });
});

describe('smart-entry: CLI dispatch (gsd-tools smart-entry)', () => {
  afterEach(removeAll);

  test('--json in an empty dir returns no-project machine JSON', () => {
    // A bare tmpdir with no .planning is a true no-project.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-se-bare-'));
    track(bare);
    const out = execFileSync(process.execPath, [TOOLS, 'smart-entry', '--json', '--cwd', bare], {
      encoding: 'utf-8',
    });
    const j = JSON.parse(out);
    assert.equal(j.situation, 'no-project');
    assert.equal(j.recommended, 'new-project');
    assert.equal(j.actions[0].command, '/gsd:new-project');
  });

  test('default (human) mode prints a plain summary line, not JSON', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-se-human-'));
    track(bare);
    const out = execFileSync(process.execPath, [TOOLS, 'smart-entry', '--cwd', bare], {
      encoding: 'utf-8',
    });
    assert.ok(!out.startsWith('{'), 'human mode is not JSON');
    assert.match(out, /No project yet/);
    assert.match(out, /Recommended:/);
  });
});
