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

  test('boundary: zero, one and two conflicts yield arrays of exactly that length', () => {
    const cases = [
      [[{ ticked: true, shape: DISK.VERIFIED }, { ticked: false, shape: DISK.NONE }], 0],
      [[{ ticked: true, shape: DISK.VERIFIED }, { ticked: true, shape: DISK.SUMMARIZED }], 1],
      [[{ ticked: true, shape: DISK.BACKFILLED }, { ticked: true, shape: DISK.SUMMARIZED }], 2],
    ];
    for (const [phases, expected] of cases) {
      fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
      writeProject(tmpDir, phases);
      const out = analyze(tmpDir);
      assert.ok(Array.isArray(out.checkbox_conflict));
      assert.strictEqual(out.checkbox_conflict.length, expected);
    }
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
          const expected = out.phases
            .filter((p) => p.roadmap_complete !== (p.disk_status === 'complete'))
            .map((p) => p.number);
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
