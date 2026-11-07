/**
 * Tests for SUMMARY-frontmatter-status-aware plan completion (#3345).
 *
 * Before #3345, both completion readers paired PLAN↔SUMMARY by FILENAME
 * EXISTENCE only: `scanPhasePlans`'s `summaryCount`/`completed`
 * (src/plan-scan.cts, via core-utils `countMatchedSummaries`) and
 * `phase-plan-index`'s `has_summary`/`incomplete` (src/phase.cts, via
 * core-utils `findUnsummarizedPlans`) never opened a SUMMARY file, so a
 * SUMMARY declaring `status: blocked` counted as a completed plan in STATE.md
 * progress counters AND was omitted from phase-plan-index's `incomplete` list.
 *
 * This suite pins the #3345 contract:
 *   - a SUMMARY whose frontmatter `status:` is `blocked` is NOT a completion
 *     record (count side: not counted; read side: has_summary false, lands in
 *     `incomplete`);
 *   - filename existence stays the fallback when the SUMMARY carries no
 *     `status` key (untouched projects are byte-for-behaviour unchanged);
 *   - `status: halted` STAYS counted — #2830's designed-stop model (a halt
 *     still writes a completion record; dependents get `blocked_by`
 *     propagation) is deliberately preserved;
 *   - PARITY GUARD (Generative Fix Divergence convention): the count side and
 *     the read side must filter their summary lists through the ONE shared
 *     predicate (`plan-dependency-graph.cjs`'s `isSummaryFileBlocked`), so the
 *     two can never re-diverge on this rule;
 *   - fail-open: an unreadable SUMMARY degrades to the pre-#3345
 *     filename-existence behaviour, never throws.
 *
 * Uses helpers.cjs createTempProject/cleanup per CONTRIBUTING.md and the
 * process-seam-backed runGsdTools for the CLI-level assertions.
 */

'use strict';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { join } = path;

function tempDir(prefix) {
  return fs.mkdtempSync(join(os.tmpdir(), prefix));
}

const planScan = require('../gsd-core/bin/lib/plan-scan.cjs');
const planDependencyGraph = require('../gsd-core/bin/lib/plan-dependency-graph.cjs');
const coreUtils = require('../gsd-core/bin/lib/core-utils.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function planBody() {
  return '# Plan\n';
}

function summaryWithStatus(status) {
  return status === undefined
    ? '# Summary\n'
    : `---\nstatus: ${status}\n---\n\n# Summary\n`;
}

function writePhase(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(join(dir, name), content);
  }
}

// ─── isBlockedStatus unit (the one place "blocked" is decided) ─────────────

describe('#3345 isBlockedStatus — truthtable', () => {
  test('matches exactly the blocked spelling, case/whitespace/comment tolerant', () => {
    const { isBlockedStatus } = planDependencyGraph;
    assert.equal(typeof isBlockedStatus, 'function', 'isBlockedStatus must be exported');
    assert.equal(isBlockedStatus('blocked'), true);
    assert.equal(isBlockedStatus('Blocked'), true);
    assert.equal(isBlockedStatus('  BLOCKED  '), true);
    // Unquoted trailing YAML comment (same #2830 review defect-2 rule as isHaltedStatus).
    assert.equal(isBlockedStatus('blocked # waiting on upstream'), true);
    assert.equal(isBlockedStatus('halted'), false, 'halted is NOT blocked (designed stop)');
    assert.equal(isBlockedStatus('complete'), false);
    assert.equal(isBlockedStatus('superseded'), false);
    assert.equal(isBlockedStatus('blocked#nospace'), false, 'no-whitespace # is not a YAML comment');
    assert.equal(isBlockedStatus(undefined), false);
    assert.equal(isBlockedStatus(42), false);
    assert.equal(isBlockedStatus(null), false);
  });
});

// ─── scanPhasePlans: the count side ────────────────────────────────────────

describe('#3345 scanPhasePlans — blocked SUMMARY is not a completion record', () => {
  test('status: blocked SUMMARY -> summaryCount 0, completed false', () => {
    const dir = tempDir('gsd-3345-blocked-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('blocked'),
      });
      const scan = planScan(dir);
      assert.equal(scan.planCount, 1);
      assert.equal(scan.summaryCount, 0, 'blocked SUMMARY must not count as a completion record');
      assert.equal(scan.completed, false, 'a blocked plan must not read as phase-complete');
      // The on-disk list is untouched — callers that list summaries still see the file.
      assert.deepEqual(scan.summaryFiles, ['01-01-SUMMARY.md']);
    } finally {
      cleanup(dir);
    }
  });

  test('no status key -> filename-existence fallback, counted exactly as before', () => {
    const dir = tempDir('gsd-3345-nostatus-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus(undefined),
      });
      const scan = planScan(dir);
      assert.equal(scan.summaryCount, 1);
      assert.equal(scan.completed, true);
    } finally {
      cleanup(dir);
    }
  });

  test('status: complete SUMMARY -> counted', () => {
    const dir = tempDir('gsd-3345-complete-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('complete'),
      });
      const scan = planScan(dir);
      assert.equal(scan.summaryCount, 1);
      assert.equal(scan.completed, true);
    } finally {
      cleanup(dir);
    }
  });

  test('status: halted SUMMARY stays counted (#2830 designed-stop pin)', () => {
    const dir = tempDir('gsd-3345-halted-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('halted'),
      });
      const scan = planScan(dir);
      assert.equal(scan.summaryCount, 1, 'a designed stop still writes a completion record');
      assert.equal(scan.completed, true);
    } finally {
      cleanup(dir);
    }
  });

  test('mixed phase: 1 blocked + 1 complete of 2 plans -> summaryCount 1, completed false', () => {
    const dir = tempDir('gsd-3345-mixed-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('blocked'),
        '01-02-PLAN.md': planBody(),
        '01-02-SUMMARY.md': summaryWithStatus(undefined),
      });
      const scan = planScan(dir);
      assert.equal(scan.planCount, 2);
      assert.equal(scan.summaryCount, 1);
      assert.equal(scan.completed, false);
    } finally {
      cleanup(dir);
    }
  });

  test('case/whitespace/comment variants of blocked are recognized', () => {
    const dir = tempDir('gsd-3345-casing-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('Blocked # waiting on upstream'),
      });
      const scan = planScan(dir);
      assert.equal(scan.summaryCount, 0);
      assert.equal(scan.completed, false);
    } finally {
      cleanup(dir);
    }
  });

  test('unreadable SUMMARY degrades fail-open to the filename fallback', (t) => {
    const dir = tempDir('gsd-3345-unreadable-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('blocked'),
      });
      const mocked = mock.method(fs, 'openSync', () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      });
      t.after(() => mocked.mock.restore());
      const scan = planScan(dir);
      assert.equal(scan.summaryCount, 1, 'unreadable SUMMARY counts by filename, never throws');
      assert.equal(scan.completed, true);
    } finally {
      cleanup(dir);
    }
  });
});

// ─── PARITY GUARD: count side and read side share ONE predicate ────────────

describe('#3345 parity — scanPhasePlans counts and findUnsummarizedPlans agree through the shared predicate', () => {
  const PARITY_SCENARIOS = [
    { id: 'blocked', files: { '01-01-PLAN.md': planBody(), '01-01-SUMMARY.md': summaryWithStatus('blocked') } },
    { id: 'no-status', files: { '01-01-PLAN.md': planBody(), '01-01-SUMMARY.md': summaryWithStatus(undefined) } },
    { id: 'halted', files: { '01-01-PLAN.md': planBody(), '01-01-SUMMARY.md': summaryWithStatus('halted') } },
    {
      id: 'mixed',
      files: {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('blocked'),
        '01-02-PLAN.md': planBody(),
        '01-02-SUMMARY.md': summaryWithStatus(undefined),
      },
    },
  ];

  for (const scenario of PARITY_SCENARIOS) {
    test(`scenario ${scenario.id}: unsummarized-through-predicate mirrors summaryCount`, () => {
      const dir = tempDir(`gsd-3345-parity-${scenario.id}-`);
      try {
        writePhase(dir, scenario.files);
        const scan = planScan(dir);
        const { isSummaryFileBlocked } = planDependencyGraph;
        assert.equal(typeof isSummaryFileBlocked, 'function', 'isSummaryFileBlocked must be exported');
        const countable = scan.summaryFiles.filter((f) => !isSummaryFileBlocked(join(dir, f)));
        const unsummarized = coreUtils.findUnsummarizedPlans(scan.planFiles, countable);
        assert.equal(
          scan.planCount - scan.summaryCount,
          unsummarized.length,
          'the count side (scanPhasePlans) and the read side (findUnsummarizedPlans over the SAME predicate-filtered list) must agree',
        );
      } finally {
        cleanup(dir);
      }
    });
  }
});

// ─── CLI: the read path (phase-plan-index) ─────────────────────────────────

describe('#3345 phase-plan-index — blocked plan lands in incomplete', () => {
  function writeCliPhase(projectDir, summaryContent) {
    const phaseDir = join(projectDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const planFm = [
      '---',
      'phase: 01-test',
      'plan: "01"',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: []',
      'autonomous: true',
      '---',
      '# plan',
      '',
    ].join('\n');
    fs.writeFileSync(join(phaseDir, '01-01-PLAN.md'), planFm);
    fs.writeFileSync(join(phaseDir, '01-01-SUMMARY.md'), summaryContent);
    return phaseDir;
  }

  test('blocked SUMMARY -> has_summary false and the plan appears in incomplete', () => {
    const project = createTempProject('gsd-3345-idx-blocked-');
    try {
      writeCliPhase(project, summaryWithStatus('blocked'));
      const r = runGsdTools(['phase-plan-index', '01-test', '--json'], project);
      assert.equal(r.exitCode, 0, r.output);
      const idx = JSON.parse(r.output);
      const plan = idx.plans.find((p) => p.id === '01-01');
      assert.ok(plan, 'plan 01-01 must be indexed');
      assert.equal(plan.has_summary, false, 'a blocked SUMMARY is not a completion record');
      assert.ok(idx.incomplete.includes('01-01'), 'the blocked plan must land in incomplete');
    } finally {
      cleanup(project);
    }
  });

  test('plain SUMMARY (no status) -> has_summary true, incomplete empty (unchanged)', () => {
    const project = createTempProject('gsd-3345-idx-plain-');
    try {
      writeCliPhase(project, summaryWithStatus(undefined));
      const r = runGsdTools(['phase-plan-index', '01-test', '--json'], project);
      assert.equal(r.exitCode, 0, r.output);
      const idx = JSON.parse(r.output);
      const plan = idx.plans.find((p) => p.id === '01-01');
      assert.equal(plan.has_summary, true);
      assert.deepEqual(idx.incomplete, []);
    } finally {
      cleanup(project);
    }
  });

  test('halted SUMMARY stays has_summary true with halted true (#2830 pin, unchanged)', () => {
    const project = createTempProject('gsd-3345-idx-halted-');
    try {
      writeCliPhase(project, summaryWithStatus('halted'));
      const r = runGsdTools(['phase-plan-index', '01-test', '--json'], project);
      assert.equal(r.exitCode, 0, r.output);
      const idx = JSON.parse(r.output);
      const plan = idx.plans.find((p) => p.id === '01-01');
      assert.equal(plan.has_summary, true, 'a designed stop keeps its completion record');
      assert.equal(plan.halted, true);
      assert.deepEqual(idx.incomplete, []);
    } finally {
      cleanup(project);
    }
  });
});

// ─── #5789: a non-regular SUMMARY must never hang the status predicates ────
//
// The FIFO and device-file rows (which spawn child processes and need a POSIX
// filesystem) live in tests/phase.platform.test.cjs; the rows here are
// platform-neutral and call the predicates in-process.

const SUMMARY_CAP_5789 = 64 * 1024;

function writeCliPhase5789(projectDir) {
  const phaseDir = join(projectDir, '.planning', 'phases', '01-test');
  fs.mkdirSync(phaseDir, { recursive: true });
  const planFm = [
    '---',
    'phase: 01-test',
    'plan: "01"',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: []',
    'autonomous: true',
    '---',
    '# plan',
    '',
  ].join('\n');
  fs.writeFileSync(join(phaseDir, '01-01-PLAN.md'), planFm);
  return phaseDir;
}

describe('#5789 regular SUMMARY behaviour is unchanged', () => {
  function withSummary(name, content, fn) {
    const dir = tempDir(`gsd-5789-${name}-`);
    try {
      const file = join(dir, '01-01-SUMMARY.md');
      fs.writeFileSync(file, content);
      fn(file, dir);
    } finally {
      cleanup(dir);
    }
  }
  const { isSummaryFileHalted, isSummaryFileBlocked } = planDependencyGraph;

  test('#5789 row 8: status halted is halted', () => {
    withSummary('r8', summaryWithStatus('halted'), (f) => {
      assert.equal(isSummaryFileHalted(f), true);
      assert.equal(isSummaryFileBlocked(f), false);
    });
  });

  test('#5789 row 9: status halted with trailing YAML comment is halted', () => {
    withSummary('r9', summaryWithStatus('halted # designed stop'), (f) => {
      assert.equal(isSummaryFileHalted(f), true);
    });
  });

  test('#5789 row 10: status blocked is blocked and not halted', () => {
    withSummary('r10', summaryWithStatus('blocked'), (f) => {
      assert.equal(isSummaryFileBlocked(f), true);
      assert.equal(isSummaryFileHalted(f), false);
    });
  });

  test('#5789 row 11: oversized file with halted frontmatter at byte 0 is read as a prefix', () => {
    withSummary('r11', `${summaryWithStatus('halted')}${'x'.repeat(SUMMARY_CAP_5789 * 3)}\n`, (f) => {
      assert.equal(isSummaryFileHalted(f), true);
    });
  });

  test('#5789 row 13: a directory named like a SUMMARY is neither halted nor blocked', () => {
    const dir = tempDir('gsd-5789-r13-');
    try {
      const sub = join(dir, '01-01-SUMMARY.md');
      fs.mkdirSync(sub);
      assert.equal(isSummaryFileHalted(sub), false);
      assert.equal(isSummaryFileBlocked(sub), false);
    } finally {
      cleanup(dir);
    }
  });

  test('#5789 absent SUMMARY is neither halted nor blocked', () => {
    const dir = tempDir('gsd-5789-absent-');
    try {
      const missing = join(dir, '01-01-SUMMARY.md');
      assert.equal(isSummaryFileHalted(missing), false);
      assert.equal(isSummaryFileBlocked(missing), false);
    } finally {
      cleanup(dir);
    }
  });

  // Cap boundary (limit-1, limit, limit+1): the closing fence ends at byte
  // cap-1, cap, cap+1. A prefix read cannot see a terminator past the cap.
  for (const [delta, expected] of [[-1, true], [0, true], [1, false]]) {
    test(`#5789 cap boundary: closing fence ends at cap${delta >= 0 ? '+' : ''}${delta} -> halted ${expected}`, () => {
      const head = '---\nstatus: halted\np: ';
      const tail = '\n---';
      const padLen = SUMMARY_CAP_5789 + delta - head.length - tail.length;
      const content = `${head}${'x'.repeat(padLen)}${tail}\n\n# body\n`;
      assert.equal(Buffer.byteLength(head + 'x'.repeat(padLen) + tail), SUMMARY_CAP_5789 + delta);
      withSummary(`cap${delta}`, content, (f) => {
        assert.equal(isSummaryFileHalted(f), expected);
        assert.equal(isSummaryFileBlocked(f), false);
      });
    });
  }

  test('#5789 row 14: halt propagation to a dependent is unchanged (phase-plan-index blocked_by)', () => {
    const project = createTempProject('gsd-5789-r14-');
    try {
      const phaseDir = writeCliPhase5789(project);
      fs.writeFileSync(join(phaseDir, '01-01-SUMMARY.md'), summaryWithStatus('halted'));
      fs.writeFileSync(
        join(phaseDir, '01-02-PLAN.md'),
        '---\nphase: 01-test\nplan: "02"\ntype: execute\nwave: 2\ndepends_on: ["01-01"]\nfiles_modified: []\nautonomous: true\n---\n# plan\n',
      );
      const r = runGsdTools(['phase-plan-index', '01-test', '--json'], project);
      assert.equal(r.exitCode, 0, r.output);
      const idx = JSON.parse(r.output);
      const dependent = idx.plans.find((p) => p.id === '01-02');
      assert.ok(dependent, 'plan 01-02 must be indexed');
      assert.deepEqual(dependent.blocked_by, ['01-01']);
    } finally {
      cleanup(project);
    }
  });
});

describe('#5789 parity — both predicates treat every input class the same way', () => {
  const INPUT_CLASSES = [
    // `halted`/`blocked` are the expected results. The read classes use
    // contents that make the two predicates DIFFER when the file is read
    // (halted true / blocked false and the reverse); the unreadable classes
    // expect false/false for both, so a predicate that read an input the
    // other treats as unreadable would diverge from the table.
    { id: 'regular-halted', make: (dir) => { const f = join(dir, 's.md'); fs.writeFileSync(f, summaryWithStatus('halted')); return f; }, halted: true, blocked: false },
    { id: 'regular-blocked', make: (dir) => { const f = join(dir, 's.md'); fs.writeFileSync(f, summaryWithStatus('blocked')); return f; }, halted: false, blocked: true },
    { id: 'empty', make: (dir) => { const f = join(dir, 's.md'); fs.writeFileSync(f, ''); return f; }, halted: false, blocked: false },
    { id: 'directory', make: (dir) => { const f = join(dir, 's.md'); fs.mkdirSync(f); return f; }, halted: false, blocked: false },
    { id: 'missing', make: (dir) => join(dir, 'nope.md'), halted: false, blocked: false },
    // The device-file and fifo classes are in tests/phase.platform.test.cjs.
  ];
  const { isSummaryFileHalted, isSummaryFileBlocked } = planDependencyGraph;
  for (const cls of INPUT_CLASSES) {
    test(`#5789 parity: ${cls.id} — halted and blocked agree on whether the file is read`, () => {
      const dir = tempDir(`gsd-5789-par-${cls.id}-`);
      try {
        const f = cls.make(dir);
        const halted = isSummaryFileHalted(f);
        const blocked = isSummaryFileBlocked(f);
        assert.equal(halted, cls.halted, `#5789 parity: ${cls.id} isSummaryFileHalted`);
        assert.equal(blocked, cls.blocked, `#5789 parity: ${cls.id} isSummaryFileBlocked`);
      } finally {
        cleanup(dir);
      }
    });
  }
});
