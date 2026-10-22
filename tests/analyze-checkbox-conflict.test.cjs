/**
 * roadmap analyze: `checkbox_conflict[]` surfaces phases whose ROADMAP
 * checkbox disagrees with the disk-derived status (#4757).
 *
 * `current_phase` / `next_phase` / `completed_phases` stay disk-authoritative
 * (ADR-3180 §7.4, #2957); the disagreement is reported, not silently resolved.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// Disk shapes: what lives in the phase directory.
const DISK = {
  NONE: 'none', // no directory -> no_directory
  BACKFILLED: 'backfilled', // phase-level SUMMARY, zero PLAN -> empty
  SUMMARIZED: 'summarized', // plan + summary, no VERIFICATION -> executed
  VERIFIED: 'verified', // plan + summary + passing VERIFICATION -> complete
};

function writePhaseDir(tmpDir, n, slug, shape) {
  if (shape === DISK.NONE) return;
  const pad = String(n).padStart(2, '0');
  const dir = path.join(tmpDir, '.planning', 'phases', `${pad}-${slug}`);
  fs.mkdirSync(dir, { recursive: true });
  if (shape === DISK.BACKFILLED) {
    fs.writeFileSync(path.join(dir, `${pad}-SUMMARY.md`), `---\nphase: ${pad}-${slug}\n---\n\n# Summary\n`);
    return;
  }
  fs.writeFileSync(path.join(dir, `${pad}-01-PLAN.md`), '---\nplan: 01\n---\n\n# Plan\n');
  fs.writeFileSync(path.join(dir, `${pad}-01-SUMMARY.md`), '---\nplan: 01\n---\n\n# Summary\n');
  if (shape === DISK.VERIFIED) {
    fs.writeFileSync(path.join(dir, `${pad}-VERIFICATION.md`), '---\nstatus: passed\n---\n\n# Verification\n');
  }
}

/** phases: Array<{ ticked: boolean, shape: string }> numbered 1..n. */
function writeProject(tmpDir, phases) {
  const checklist = phases.map((p, i) =>
    `- [${p.ticked ? 'x' : ' '}] **Phase ${i + 1}: P${i + 1}** - item`);
  const details = phases.map((p, i) =>
    `### Phase ${i + 1}: P${i + 1}\n\n**Goal**: goal ${i + 1}\n**Depends on**: nothing\n`);
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap\n\n## Milestone: v1.0\n\n${checklist.join('\n')}\n\n${details.join('\n')}`,
  );
  phases.forEach((p, i) => writePhaseDir(tmpDir, i + 1, `p${i + 1}`, p.shape));
}

function analyze(tmpDir) {
  const result = runGsdTools('roadmap analyze', tmpDir);
  assert.ok(result.success, `Command failed: ${result.error}`);
  return JSON.parse(result.output);
}

describe('roadmap analyze checkbox_conflict (#4757)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('issue repro: a ticked backfilled phase and a ticked unverified phase are surfaced, selectors stay disk-authoritative', () => {
    writeProject(tmpDir, [
      { ticked: true, shape: DISK.BACKFILLED },
      { ticked: true, shape: DISK.SUMMARIZED },
      { ticked: false, shape: DISK.NONE },
    ]);
    const out = analyze(tmpDir);

    assert.deepStrictEqual(out.checkbox_conflict, [
      { number: '1', roadmap_complete: true, disk_status: 'empty', plan_count: 0, summary_count: 0 },
      { number: '2', roadmap_complete: true, disk_status: 'executed', plan_count: 1, summary_count: 1 },
    ]);
    // ADR-3180 §7.4 / #2957: the checkbox has no authority over the selectors.
    assert.strictEqual(out.current_phase, '2');
    assert.strictEqual(out.next_phase, '1');
    assert.strictEqual(out.completed_phases, 0);
  });

  test('an agreeing ticked-and-complete phase is not a conflict', () => {
    writeProject(tmpDir, [{ ticked: true, shape: DISK.VERIFIED }]);
    const out = analyze(tmpDir);
    assert.strictEqual(out.phases[0].disk_status, 'complete');
    assert.deepStrictEqual(out.checkbox_conflict, []);
  });

  test('agreeing unticked phases (no directory, backfilled, summarized) are not conflicts', () => {
    writeProject(tmpDir, [
      { ticked: false, shape: DISK.NONE },
      { ticked: false, shape: DISK.BACKFILLED },
      { ticked: false, shape: DISK.SUMMARIZED },
    ]);
    assert.deepStrictEqual(analyze(tmpDir).checkbox_conflict, []);
  });

  test('an unticked phase that is complete on disk is a conflict in the other direction', () => {
    writeProject(tmpDir, [{ ticked: false, shape: DISK.VERIFIED }]);
    const out = analyze(tmpDir);
    assert.deepStrictEqual(out.checkbox_conflict, [
      { number: '1', roadmap_complete: false, disk_status: 'complete', plan_count: 1, summary_count: 1 },
    ]);
    assert.strictEqual(out.completed_phases, 1);
  });

  // #5221: roadmap_record — phase number (zero-padding folded per segment) -> whether every ROADMAP
  // record of it (checklist entry, phase-table Status cell) reads complete. A phase with no record is absent.
  const record = (roadmap, config) => {
    if (config) fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    return analyze(tmpDir).roadmap_record;
  };
  const TABLE = '| Phase | Plans Complete | Status | Completed |\n|---|---|---|---|\n';

  test('#5221: roadmap_record reads checklist entries regardless of disk', () => {
    writeProject(tmpDir, [
      { ticked: false, shape: DISK.NONE },
      { ticked: false, shape: DISK.VERIFIED },
      { ticked: true, shape: DISK.NONE },
    ]);
    assert.deepStrictEqual(analyze(tmpDir).roadmap_record, { 1: false, 2: false, 3: true });
  });

  test('#5221: roadmap_record reads a table-only row by its Status cell; a heading-only phase is absent', () => {
    const out = record('# Roadmap\n\n## Milestone: v1.0\n\n### Phase 1: A\n\n**Goal**: g\n\n### Phase 4: D\n\n**Goal**: g\n\n## Progress\n\n'
      + TABLE + '| 01. A | 1/1 | Complete | 2026-01-01 |\n| 2 | 0/1 | Pending | - |\n| 3.02 | 0/1 | In Progress | - |\n');
    assert.deepStrictEqual(out, { 1: true, 2: false, '3.2': false });
  });

  test('#5221: a checklist entry and a table row must both read complete', () => {
    const out = record('# Roadmap\n\n## Milestone: v1.0\n\n- [x] **Phase 1: A**\n- [x] **Phase 2: B**\n\n## Progress\n\n'
      + TABLE + '| 1 | 1/1 | Complete | 2026-01-01 |\n| 2 | 0/1 | Pending | - |\n');
    assert.deepStrictEqual(out, { 1: true, 2: false });
  });

  test('#5221: a phase table that does not parse (ragged row) makes roadmap_record null, never a partial record', () => {
    const out = record('# Roadmap\n\n## Milestone: v1.0\n\n- [x] **Phase 1: A**\n\n## Progress\n\n'
      + TABLE + '| 1 | 0/1 | Planned |\n');
    assert.strictEqual(out, null);
  });

  test('#5221: a phase table whose Phase/Status headers are not recognised makes roadmap_record null, not checklist-only', () => {
    const out = record('# Roadmap\n\n## Milestone: v1.0\n\n- [x] **Phase 1: A**\n\n## Progress\n\n'
      + '| phase | Plans Complete | state | Completed |\n|---|---|---|---|\n| 1 | 0/1 | Not started | - |\n');
    assert.strictEqual(out, null);
    // A lowercase table without Plans Complete (e.g. traceability) is not a phase table: no false block.
    assert.deepStrictEqual(record('# Roadmap\n\n## Milestone: v1.0\n\n- [x] **Phase 1: A**\n\n'
      + '| Requirement | phase | status |\n|---|---|---|\n| R1 | 1 | Pending |\n'), { 1: true });
  });

  test('#5221: two brackets sharing token 01 — one unticked keeps 01 incomplete (fails closed)', () => {
    const roadmap = (a, b) => `# Roadmap\n\n## [GSD.02] v2.0\n\n- [${a}] **[GSD.02] 01: One**\n- [${b}] **[GSD.03] 01: Other**\n\n### [GSD.02] 01: One\n**Goal:** a\n\n### [GSD.03] 01: Other\n**Goal:** b\n`;
    assert.deepStrictEqual(record(roadmap('x', ' '), { phase_id_convention: 'bracket' }), { 1: false });
    assert.deepStrictEqual(record(roadmap(' ', 'x'), { phase_id_convention: 'bracket' }), { 1: false });
    assert.deepStrictEqual(record(roadmap('x', 'x'), { phase_id_convention: 'bracket' }), { 1: true });
  });

  test('boundary: zero, one and two conflicts yield arrays of exactly that length', () => {
    const cases = [
      [[{ ticked: true, shape: DISK.VERIFIED }, { ticked: false, shape: DISK.NONE }], 0],
      [[{ ticked: true, shape: DISK.VERIFIED }, { ticked: true, shape: DISK.SUMMARIZED }], 1],
      [[{ ticked: true, shape: DISK.BACKFILLED }, { ticked: true, shape: DISK.SUMMARIZED }], 2],
    ];
    for (const [phases, expected] of cases) {
      const caseDir = createTempProject();
      try {
        writeProject(caseDir, phases);
        const out = analyze(caseDir);
        assert.ok(Array.isArray(out.checkbox_conflict));
        assert.strictEqual(out.checkbox_conflict.length, expected);
      } finally {
        cleanup(caseDir);
      }
    }
  });

  function writeVerified() {
    writePhaseDir(tmpDir, 1, 'alpha', DISK.VERIFIED);
  }

  test('a progress-table-only phase has no checkbox and is never a conflict, even when complete on disk', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Progress\n\n| Phase | Name | Plans | Status |\n|-------|------|-------|--------|\n| 1 | Alpha | 1/1 | Complete |\n',
    );
    writeVerified();
    const out = analyze(tmpDir);
    assert.strictEqual(out.phases[0].disk_status, 'complete');
    assert.deepStrictEqual(out.checkbox_conflict, []);
  });

  test('a heading with no checklist entry has no checkbox and is never a conflict, even when complete on disk', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Alpha\n\n**Goal**: g\n',
    );
    writeVerified();
    const out = analyze(tmpDir);
    assert.strictEqual(out.phases[0].disk_status, 'complete');
    assert.deepStrictEqual(out.checkbox_conflict, []);
  });

  test('checklist-only (synthesized) phases are compared: ticked backfilled conflicts, unticked no-directory does not', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n- [x] **Phase 1: Alpha** - a\n- [ ] **Phase 2: Beta** - b\n',
    );
    writePhaseDir(tmpDir, 1, 'alpha', DISK.BACKFILLED);
    const out = analyze(tmpDir);
    assert.deepStrictEqual(out.checkbox_conflict, [
      { number: '1', roadmap_complete: true, disk_status: 'empty', plan_count: 0, summary_count: 0 },
    ]);
  });

  test('a ticked sentinel phase (999.x) is absent from phases and from checkbox_conflict', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n- [x] **Phase 1: Alpha** - a\n- [x] **Phase 999.1: Icebox** - b\n\n### Phase 1: Alpha\n\n**Goal**: g\n\n### Phase 999.1: Icebox\n\n**Goal**: g\n',
    );
    writePhaseDir(tmpDir, 1, 'alpha', DISK.BACKFILLED);
    const out = analyze(tmpDir);
    assert.deepStrictEqual(out.checkbox_conflict.map((c) => c.number), ['1']);
  });

  test('a roadmap with no phases reports an empty array, not null/undefined', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    const out = analyze(tmpDir);
    assert.deepStrictEqual(out.checkbox_conflict, []);
  });
});

describe('roadmap analyze checkbox_conflict property (#4757)', () => {
  test('conflict set equals exactly the phases where roadmap_complete disagrees with disk_status === complete', () => {
    const phaseArb = fc.record({
      ticked: fc.boolean(),
      shape: fc.constantFrom(DISK.NONE, DISK.BACKFILLED, DISK.SUMMARIZED, DISK.VERIFIED),
    });
    fc.assert(
      fc.property(fc.array(phaseArb, { minLength: 1, maxLength: 4 }), (phases) => {
        const tmpDir = createTempProject();
        try {
          writeProject(tmpDir, phases);
          const out = analyze(tmpDir);
          // Derived from the GENERATED inputs, not from the output under test.
          const expected = phases
            .map((p, i) => (p.ticked !== (p.shape === DISK.VERIFIED) ? String(i + 1) : null))
            .filter((n) => n !== null);
          assert.deepStrictEqual(out.checkbox_conflict.map((c) => c.number), expected);
          // The checkbox is reported verbatim from the phase record.
          phases.forEach((p, i) => {
            assert.strictEqual(out.phases[i].roadmap_complete, p.ticked);
          });
        } finally {
          cleanup(tmpDir);
        }
      }),
      { numRuns: 15 },
    );
  });
});
