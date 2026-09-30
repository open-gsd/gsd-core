'use strict';

/**
 * Phase Status Module — `src/phase-status.cts` (ADR-5057 §1/§2, epic #5056
 * Phase 1, #5060).
 *
 * The module owns "what state is phase P in?". Its ladder is closed, every
 * other vocabulary is a projection it exports, and it reads completion only
 * through `isPhaseComplete` (ADR-3180 §7.4). The two properties at the bottom
 * are ADR-5057's Phase 1 ratchet:
 *   - phaseStatus(d) === COMPLETE  ⇔  isPhaseComplete(d).value.complete
 *   - parseRoadmapStatusCell(toRoadmapStatusCell(s)) === toWireStatus(s)
 * with a positive control: a `passed` report whose fingerprint no longer
 * matches never projects to COMPLETE.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

const phaseStatusMod = require('../gsd-core/bin/lib/phase-status.cjs');
const { isPhaseComplete } = require('../gsd-core/bin/lib/verification.cjs');
const stateContractMod = require('../gsd-core/bin/lib/state-contract.cjs');

const {
  PHASE_STATUS,
  WIRE_STATUS,
  ROADMAP_STATUS_TOKEN,
  DISK_STATUS,
  PROGRESS_STATUS,
  COMPLETION_STATUS,
  phaseStatusFromFacts,
  phaseStatus,
  foldPhaseStatuses,
  toDisplayLabel,
  toWireStatus,
  toRoadmapStatusCell,
  toDiskStatus,
  toCompletionStatus,
  toProgressStatus,
  matchRoadmapStatusCell,
  parseRoadmapStatusCell,
} = phaseStatusMod;

const LADDER = [
  PHASE_STATUS.NOT_STARTED,
  PHASE_STATUS.PLANNED,
  PHASE_STATUS.IN_PROGRESS,
  PHASE_STATUS.EXECUTED,
  PHASE_STATUS.NEEDS_REVIEW,
  PHASE_STATUS.COMPLETE,
];

const facts = (over) => ({ planCount: 0, summaryCount: 0, complete: false, verificationStatus: null, ...over });

// ─── closed vocabularies ──────────────────────────────────────────────────

describe('closed vocabularies', () => {
  test('the ladder has exactly six frozen rungs', () => {
    assert.ok(Object.isFrozen(PHASE_STATUS));
    assert.deepEqual(Object.keys(PHASE_STATUS).sort(), [
      'COMPLETE', 'EXECUTED', 'IN_PROGRESS', 'NEEDS_REVIEW', 'NOT_STARTED', 'PLANNED',
    ]);
    assert.equal(new Set(Object.values(PHASE_STATUS)).size, 6);
  });

  test('ladder values are distinct from every projection word, so a label can never pass as a status', () => {
    const projected = new Set();
    for (const s of LADDER) {
      projected.add(toDisplayLabel(s, { pendingWord: 'Pending' }));
      projected.add(toDisplayLabel(s, { pendingWord: 'Not Started' }));
      projected.add(toWireStatus(s));
      projected.add(toRoadmapStatusCell(s));
      projected.add(toCompletionStatus(s));
      projected.add(toDiskStatus(s, { hasResearch: false, hasContext: false }));
      projected.add(toProgressStatus(s, { hasResearch: false }));
    }
    for (const s of LADDER) {
      assert.equal(projected.has(s), false, `ladder value ${JSON.stringify(s)} collides with a projection word`);
    }
  });

  test('the wire vocabulary is frozen and three-valued', () => {
    assert.ok(Object.isFrozen(WIRE_STATUS));
    assert.deepEqual({ ...WIRE_STATUS }, { COMPLETE: 'complete', IN_PROGRESS: 'in_progress', PENDING: 'pending' });
  });

  test("state-contract's public PHASE_STATUS is the owner's WIRE_STATUS object, not a copy", () => {
    assert.equal(stateContractMod.PHASE_STATUS, WIRE_STATUS);
  });

  test('the ROADMAP cell vocabulary is frozen and holds the five template words', () => {
    assert.ok(Object.isFrozen(ROADMAP_STATUS_TOKEN));
    assert.deepEqual({ ...ROADMAP_STATUS_TOKEN }, {
      NOT_STARTED: 'Not started',
      PLANNED: 'Planned',
      IN_PROGRESS: 'In Progress',
      COMPLETE: 'Complete',
      DEFERRED: 'Deferred',
    });
  });

  // #5060 review finding (ADR-5057 §1.2): DISK_STATUS/PROGRESS_STATUS/
  // COMPLETION_STATUS are frozen, closed vocabularies imported by every
  // producer AND every consumer — not hand-spelled literals at call sites.
  test('DISK_STATUS is frozen and holds every toDiskStatus word', () => {
    assert.ok(Object.isFrozen(DISK_STATUS));
    assert.deepEqual({ ...DISK_STATUS }, {
      COMPLETE: 'complete',
      EXECUTED: 'executed',
      PARTIAL: 'partial',
      PLANNED: 'planned',
      RESEARCHED: 'researched',
      DISCUSSED: 'discussed',
      EMPTY: 'empty',
      NO_DIRECTORY: 'no_directory',
    });
  });

  test('PROGRESS_STATUS is frozen and holds every toProgressStatus word', () => {
    assert.ok(Object.isFrozen(PROGRESS_STATUS));
    assert.deepEqual({ ...PROGRESS_STATUS }, {
      COMPLETE: 'complete',
      EXECUTED: 'executed',
      IN_PROGRESS: 'in_progress',
      RESEARCHED: 'researched',
      PENDING: 'pending',
      NOT_STARTED: 'not_started',
    });
  });

  test('COMPLETION_STATUS is frozen and holds every toCompletionStatus word', () => {
    assert.ok(Object.isFrozen(COMPLETION_STATUS));
    assert.deepEqual({ ...COMPLETION_STATUS }, {
      COMPLETE: 'complete',
      EXECUTED: 'executed',
      INCOMPLETE: 'incomplete',
    });
  });

  test('toDiskStatus never returns a word outside DISK_STATUS, across every rung and artifact combo', () => {
    const diskVocab = new Set(Object.values(DISK_STATUS));
    for (const s of LADDER) {
      for (const hasResearch of [false, true]) {
        for (const hasContext of [false, true]) {
          assert.ok(
            diskVocab.has(toDiskStatus(s, { hasResearch, hasContext })),
            `toDiskStatus(${s}, {hasResearch:${hasResearch}, hasContext:${hasContext}}) left DISK_STATUS`,
          );
        }
      }
    }
  });

  test('toProgressStatus never returns a word outside PROGRESS_STATUS, across every rung and artifact combo', () => {
    const progressVocab = new Set(Object.values(PROGRESS_STATUS));
    for (const s of LADDER) {
      for (const hasResearch of [false, true]) {
        assert.ok(
          progressVocab.has(toProgressStatus(s, { hasResearch })),
          `toProgressStatus(${s}, {hasResearch:${hasResearch}}) left PROGRESS_STATUS`,
        );
      }
    }
  });

  test('toCompletionStatus never returns a word outside COMPLETION_STATUS, across every rung', () => {
    const completionVocab = new Set(Object.values(COMPLETION_STATUS));
    for (const s of LADDER) {
      assert.ok(
        completionVocab.has(toCompletionStatus(s)),
        `toCompletionStatus(${s}) left COMPLETION_STATUS`,
      );
    }
  });
});

// ─── the ladder (pure) ────────────────────────────────────────────────────

describe('phaseStatusFromFacts — the ladder', () => {
  test('complete wins at zero plans (disk-strict, #3168)', () => {
    assert.equal(phaseStatusFromFacts(facts({ complete: true })), PHASE_STATUS.COMPLETE);
  });

  test('complete wins over partial counts', () => {
    assert.equal(phaseStatusFromFacts(facts({ planCount: 3, summaryCount: 1, complete: true })), PHASE_STATUS.COMPLETE);
  });

  test('no plans and not complete is NOT_STARTED', () => {
    assert.equal(phaseStatusFromFacts(facts({ verificationStatus: 'human_needed' })), PHASE_STATUS.NOT_STARTED);
  });

  test('plans with no summaries is PLANNED', () => {
    assert.equal(phaseStatusFromFacts(facts({ planCount: 1 })), PHASE_STATUS.PLANNED);
  });

  test('some summaries short of plans is IN_PROGRESS (limit-1)', () => {
    assert.equal(phaseStatusFromFacts(facts({ planCount: 2, summaryCount: 1 })), PHASE_STATUS.IN_PROGRESS);
  });

  test('all summaries with human_needed is NEEDS_REVIEW (limit)', () => {
    assert.equal(
      phaseStatusFromFacts(facts({ planCount: 2, summaryCount: 2, verificationStatus: 'human_needed' })),
      PHASE_STATUS.NEEDS_REVIEW,
    );
  });

  test('all summaries with any other non-passing verdict is EXECUTED', () => {
    // #5118: `unknown` left the closed enum (it is a TypeError now — see V38);
    // `phase_dir_not_found` joined it.
    for (const v of ['gaps_found', 'missing', 'phase_dir_not_found', 'stale', 'unparseable', 'passed', null]) {
      assert.equal(
        phaseStatusFromFacts(facts({ planCount: 2, summaryCount: 2, verificationStatus: v })),
        PHASE_STATUS.EXECUTED,
        `verification ${JSON.stringify(v)} with complete=false must be EXECUTED`,
      );
    }
  });

  test('summaries above plans (limit+1) is EXECUTED', () => {
    assert.equal(phaseStatusFromFacts(facts({ planCount: 2, summaryCount: 3 })), PHASE_STATUS.EXECUTED);
  });

  test('rejects counts that are not non-negative integers', () => {
    for (const bad of [-1, 1.5, Number.NaN, Infinity, '2', null, undefined]) {
      assert.throws(() => phaseStatusFromFacts(facts({ planCount: bad })), TypeError, `planCount ${String(bad)}`);
      assert.throws(() => phaseStatusFromFacts(facts({ summaryCount: bad })), TypeError, `summaryCount ${String(bad)}`);
    }
  });

  test('rejects a non-boolean complete', () => {
    for (const bad of ['yes', 1, 0, undefined, null]) {
      assert.throws(() => phaseStatusFromFacts(facts({ complete: bad })), TypeError, `complete ${String(bad)}`);
    }
  });

  test('rejects a missing facts object', () => {
    assert.throws(() => phaseStatusFromFacts(undefined), TypeError);
    assert.throws(() => phaseStatusFromFacts(null), TypeError);
  });
});

// ─── projections ──────────────────────────────────────────────────────────

describe('projections', () => {
  test('display labels, with the pending word a caller choice', () => {
    const expected = {
      [PHASE_STATUS.PLANNED]: 'Planned',
      [PHASE_STATUS.IN_PROGRESS]: 'In Progress',
      [PHASE_STATUS.EXECUTED]: 'Executed',
      [PHASE_STATUS.NEEDS_REVIEW]: 'Needs Review',
      [PHASE_STATUS.COMPLETE]: 'Complete',
    };
    for (const [s, label] of Object.entries(expected)) {
      assert.equal(toDisplayLabel(s, { pendingWord: 'Pending' }), label);
      assert.equal(toDisplayLabel(s, { pendingWord: 'Not Started' }), label);
    }
    assert.equal(toDisplayLabel(PHASE_STATUS.NOT_STARTED, { pendingWord: 'Pending' }), 'Pending');
    assert.equal(toDisplayLabel(PHASE_STATUS.NOT_STARTED, { pendingWord: 'Not Started' }), 'Not Started');
    assert.equal(toDisplayLabel(PHASE_STATUS.NOT_STARTED), 'Not Started', 'default pending word');
    assert.throws(() => toDisplayLabel(PHASE_STATUS.NOT_STARTED, { pendingWord: 'Queued' }), TypeError);
  });

  test('wire status', () => {
    assert.equal(toWireStatus(PHASE_STATUS.NOT_STARTED), 'pending');
    for (const s of [PHASE_STATUS.PLANNED, PHASE_STATUS.IN_PROGRESS, PHASE_STATUS.EXECUTED, PHASE_STATUS.NEEDS_REVIEW]) {
      assert.equal(toWireStatus(s), 'in_progress', s);
    }
    assert.equal(toWireStatus(PHASE_STATUS.COMPLETE), 'complete');
  });

  test('ROADMAP Status cell words are the ones the writers have always written', () => {
    assert.equal(toRoadmapStatusCell(PHASE_STATUS.NOT_STARTED), 'Not started');
    assert.equal(toRoadmapStatusCell(PHASE_STATUS.PLANNED), 'Planned');
    for (const s of [PHASE_STATUS.IN_PROGRESS, PHASE_STATUS.EXECUTED, PHASE_STATUS.NEEDS_REVIEW]) {
      assert.equal(toRoadmapStatusCell(s), 'In Progress', s);
    }
    assert.equal(toRoadmapStatusCell(PHASE_STATUS.COMPLETE), 'Complete');
  });

  test('disk status (roadmap analyze / init manager)', () => {
    const none = { hasResearch: false, hasContext: false };
    assert.equal(toDiskStatus(PHASE_STATUS.COMPLETE, none), 'complete');
    assert.equal(toDiskStatus(PHASE_STATUS.NEEDS_REVIEW, none), 'executed');
    assert.equal(toDiskStatus(PHASE_STATUS.EXECUTED, none), 'executed');
    assert.equal(toDiskStatus(PHASE_STATUS.IN_PROGRESS, none), 'partial');
    assert.equal(toDiskStatus(PHASE_STATUS.PLANNED, { hasResearch: true, hasContext: true }), 'planned');
    assert.equal(toDiskStatus(PHASE_STATUS.NOT_STARTED, { hasResearch: true, hasContext: true }), 'researched');
    assert.equal(toDiskStatus(PHASE_STATUS.NOT_STARTED, { hasResearch: false, hasContext: true }), 'discussed');
    assert.equal(toDiskStatus(PHASE_STATUS.NOT_STARTED, none), 'empty');
  });

  test('completion status (init completion projection)', () => {
    assert.equal(toCompletionStatus(PHASE_STATUS.COMPLETE), 'complete');
    assert.equal(toCompletionStatus(PHASE_STATUS.NEEDS_REVIEW), 'executed');
    assert.equal(toCompletionStatus(PHASE_STATUS.EXECUTED), 'executed');
    for (const s of [PHASE_STATUS.IN_PROGRESS, PHASE_STATUS.PLANNED, PHASE_STATUS.NOT_STARTED]) {
      assert.equal(toCompletionStatus(s), 'incomplete', s);
    }
  });

  test('progress status (init progress)', () => {
    assert.equal(toProgressStatus(PHASE_STATUS.COMPLETE, { hasResearch: true }), 'complete');
    assert.equal(toProgressStatus(PHASE_STATUS.NEEDS_REVIEW, { hasResearch: false }), 'executed');
    assert.equal(toProgressStatus(PHASE_STATUS.EXECUTED, { hasResearch: false }), 'executed');
    assert.equal(toProgressStatus(PHASE_STATUS.IN_PROGRESS, { hasResearch: true }), 'in_progress');
    assert.equal(toProgressStatus(PHASE_STATUS.PLANNED, { hasResearch: true }), 'in_progress');
    assert.equal(toProgressStatus(PHASE_STATUS.NOT_STARTED, { hasResearch: true }), 'researched');
    assert.equal(toProgressStatus(PHASE_STATUS.NOT_STARTED, { hasResearch: false }), 'pending');
  });

  test('every projection refuses a value outside the ladder', () => {
    const projections = [
      (s) => toDisplayLabel(s, { pendingWord: 'Pending' }),
      toWireStatus,
      toRoadmapStatusCell,
      toCompletionStatus,
      (s) => toDiskStatus(s, { hasResearch: false, hasContext: false }),
      (s) => toProgressStatus(s, { hasResearch: false }),
      (s) => foldPhaseStatuses(s, PHASE_STATUS.COMPLETE),
      (s) => foldPhaseStatuses(PHASE_STATUS.COMPLETE, s),
    ];
    for (const bad of ['Complete', 'complete', 'Not Started', 'pending', '', undefined, null, 3, {}]) {
      for (const project of projections) {
        assert.throws(() => project(bad), TypeError, `must refuse ${JSON.stringify(bad)}`);
      }
    }
  });
});

// ─── fold (#2408) ─────────────────────────────────────────────────────────

describe('foldPhaseStatuses (#2408)', () => {
  test('property: the fold returns the further-along rung, and is commutative, idempotent and associative', () => {
    const rung = fc.constantFrom(...LADDER);
    fc.assert(fc.property(rung, rung, rung, (a, b, c) => {
      const ab = foldPhaseStatuses(a, b);
      assert.equal(ab, LADDER[Math.max(LADDER.indexOf(a), LADDER.indexOf(b))]);
      assert.equal(ab, foldPhaseStatuses(b, a));
      assert.equal(foldPhaseStatuses(a, a), a);
      assert.equal(foldPhaseStatuses(foldPhaseStatuses(a, b), c), foldPhaseStatuses(a, foldPhaseStatuses(b, c)));
    }));
  });
});

// ─── ROADMAP Status cell reader ───────────────────────────────────────────

describe('matchRoadmapStatusCell / parseRoadmapStatusCell', () => {
  test('a leading token is read, with the raw matched text returned', () => {
    assert.deepEqual(matchRoadmapStatusCell('Complete'), { token: ROADMAP_STATUS_TOKEN.COMPLETE, text: 'Complete' });
    assert.deepEqual(matchRoadmapStatusCell('  cOmPlEtE  '), { token: ROADMAP_STATUS_TOKEN.COMPLETE, text: 'cOmPlEtE' });
    assert.deepEqual(matchRoadmapStatusCell('Complete — shipped 2026-09-20'), { token: ROADMAP_STATUS_TOKEN.COMPLETE, text: 'Complete' });
    assert.deepEqual(matchRoadmapStatusCell('Complete\r'), { token: ROADMAP_STATUS_TOKEN.COMPLETE, text: 'Complete' });
    assert.deepEqual(matchRoadmapStatusCell('Not started'), { token: ROADMAP_STATUS_TOKEN.NOT_STARTED, text: 'Not started' });
    assert.deepEqual(matchRoadmapStatusCell('Planned (3 plans)'), { token: ROADMAP_STATUS_TOKEN.PLANNED, text: 'Planned' });
    assert.deepEqual(matchRoadmapStatusCell('Deferred — v2'), { token: ROADMAP_STATUS_TOKEN.DEFERRED, text: 'Deferred' });
  });

  test('internal whitespace runs inside a two-word token are tolerated', () => {
    assert.deepEqual(matchRoadmapStatusCell('In  progress — gap 1/2'), { token: ROADMAP_STATUS_TOKEN.IN_PROGRESS, text: 'In  progress' });
    assert.deepEqual(matchRoadmapStatusCell('in\tprogress'), { token: ROADMAP_STATUS_TOKEN.IN_PROGRESS, text: 'in\tprogress' });
    assert.deepEqual(matchRoadmapStatusCell('NOT   STARTED'), { token: ROADMAP_STATUS_TOKEN.NOT_STARTED, text: 'NOT   STARTED' });
  });

  test('a word that merely begins with a token is not the token', () => {
    for (const cell of ['Completed', 'Completeness pending', 'Planning', 'Deferredx', 'In progressive', 'Not startedness']) {
      assert.equal(matchRoadmapStatusCell(cell), null, cell);
      assert.equal(parseRoadmapStatusCell(cell), WIRE_STATUS.PENDING, cell);
    }
  });

  test('a cell with no leading token is never guessed', () => {
    for (const cell of ['✅ Complete', 'Blocked', 'TBD', '-', '—', '', '   ', 'Status: Complete']) {
      assert.equal(matchRoadmapStatusCell(cell), null, JSON.stringify(cell));
      assert.equal(parseRoadmapStatusCell(cell), WIRE_STATUS.PENDING, JSON.stringify(cell));
    }
  });

  test('a non-string cell is null / pending, never a throw', () => {
    for (const cell of [undefined, null, 42, {}, []]) {
      assert.equal(matchRoadmapStatusCell(cell), null);
      assert.equal(parseRoadmapStatusCell(cell), WIRE_STATUS.PENDING);
    }
  });

  test('cell to wire', () => {
    assert.equal(parseRoadmapStatusCell('Complete — shipped'), 'complete');
    assert.equal(parseRoadmapStatusCell('In Progress'), 'in_progress');
    assert.equal(parseRoadmapStatusCell('Planned'), 'in_progress');
    assert.equal(parseRoadmapStatusCell('Not started'), 'pending');
    assert.equal(parseRoadmapStatusCell('Deferred — pushed to v2'), 'pending');
  });

  test('property: a token followed by a non-word suffix reads as that token', () => {
    const tokenArb = fc.constantFrom(...Object.values(ROADMAP_STATUS_TOKEN));
    const suffixArb = fc.tuple(fc.constantFrom(' ', ' — ', ' (', ', ', '.', '\t'), fc.string({ maxLength: 20 }))
      .map(([sep, rest]) => sep + rest);
    fc.assert(fc.property(tokenArb, suffixArb, fc.boolean(), (token, suffix, upper) => {
      const spelled = upper ? token.toUpperCase() : token;
      const m = matchRoadmapStatusCell(spelled + suffix);
      assert.ok(m, `${JSON.stringify(spelled + suffix)} must match`);
      assert.equal(m.token, token);
      assert.equal(m.text, spelled);
    }));
  });

  test('property: a token glued to a word character is not a token', () => {
    const tokenArb = fc.constantFrom(...Object.values(ROADMAP_STATUS_TOKEN));
    const wordCharArb = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_');
    fc.assert(fc.property(tokenArb, wordCharArb, fc.string({ maxLength: 10 }), (token, ch, rest) => {
      assert.equal(matchRoadmapStatusCell(token + ch + rest), null);
    }));
  });

  test('property (ADR-5057 Phase 1 ratchet): the cell a rung is written as reads back as that rung\'s wire value', () => {
    fc.assert(fc.property(fc.constantFrom(...LADDER), (s) => {
      assert.equal(parseRoadmapStatusCell(toRoadmapStatusCell(s)), toWireStatus(s));
    }));
  });
});

// ─── phaseStatus(dir) — real directories ──────────────────────────────────

function writePhase(dir, { plans = 0, summaries = 0, verification = null, strayPlanlessSummary = false }) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= plans; i++) {
    fs.writeFileSync(path.join(dir, `07-0${i}-PLAN.md`), '# Plan\n');
  }
  for (let i = 1; i <= summaries; i++) {
    fs.writeFileSync(path.join(dir, `07-0${i}-SUMMARY.md`), '# Summary\n');
  }
  if (strayPlanlessSummary) {
    fs.writeFileSync(path.join(dir, '07-GAPCLOSURE-SUMMARY.md'), '# Stray\n');
  }
  if (verification !== null) {
    // Written LAST so the legacy (fingerprint-less) mtime staleness check sees
    // it as no older than every SUMMARY. A stale report is forced through a
    // fingerprint whose digest cannot match — deterministic, no clock.
    const stale = verification.endsWith('+stale');
    const status = stale ? verification.slice(0, -'+stale'.length) : verification;
    const fm = stale
      ? ['---', `status: ${status}`, 'covered_files:', '  - 07-01-PLAN.md', 'covered_digest: sha256-v2:0000000000000000', '---']
      : ['---', `status: ${status}`, '---'];
    fs.writeFileSync(path.join(dir, '07-VERIFICATION.md'), [...fm, '# Verification', ''].join('\n'));
  }
}

describe('phaseStatus(phaseDir)', () => {
  let tmpDir;
  let phaseDir;
  beforeEach(() => {
    tmpDir = createTempProject('phase-status-');
    phaseDir = path.join(tmpDir, '.planning', 'phases', '07-thing');
  });
  afterEach(() => cleanup(tmpDir));

  test('passed and fresh, every plan summarized → COMPLETE, counts from the plan scan', () => {
    writePhase(phaseDir, { plans: 2, summaries: 2, verification: 'passed' });
    const r = phaseStatus(phaseDir);
    assert.equal(r.value.status, PHASE_STATUS.COMPLETE);
    assert.equal(r.value.planCount, 2);
    assert.equal(r.value.summaryCount, 2);
    assert.equal(r.value.verification.status, 'passed');
    assert.equal(r.scope, 'complete');
  });

  test('POSITIVE CONTROL: passed but stale is EXECUTED, never COMPLETE', () => {
    writePhase(phaseDir, { plans: 2, summaries: 2, verification: 'passed+stale' });
    const r = phaseStatus(phaseDir);
    assert.equal(r.value.verification.status, 'stale');
    assert.equal(r.value.status, PHASE_STATUS.EXECUTED);
  });

  test('a capitalized `Passed` is not `passed` (the verification owner is case-sensitive)', () => {
    writePhase(phaseDir, { plans: 1, summaries: 1, verification: 'Passed' });
    assert.equal(phaseStatus(phaseDir).value.status, PHASE_STATUS.EXECUTED);
  });

  test('human_needed and fresh → NEEDS_REVIEW; human_needed and stale → EXECUTED', () => {
    writePhase(phaseDir, { plans: 1, summaries: 1, verification: 'human_needed' });
    assert.equal(phaseStatus(phaseDir).value.status, PHASE_STATUS.NEEDS_REVIEW);
    const staleDir = path.join(tmpDir, '.planning', 'phases', '07-stale');
    writePhase(staleDir, { plans: 1, summaries: 1, verification: 'human_needed+stale' });
    assert.equal(phaseStatus(staleDir).value.status, PHASE_STATUS.EXECUTED);
  });

  test('zero plans with a passing report → COMPLETE (disk-strict)', () => {
    writePhase(phaseDir, { plans: 0, verification: 'passed' });
    assert.equal(phaseStatus(phaseDir).value.status, PHASE_STATUS.COMPLETE);
  });

  test('a stray plan-less SUMMARY does not count as a summary', () => {
    writePhase(phaseDir, { plans: 1, summaries: 0, strayPlanlessSummary: true });
    const r = phaseStatus(phaseDir);
    assert.equal(r.value.summaryCount, 0);
    assert.equal(r.value.status, PHASE_STATUS.PLANNED);
  });

  test('a directory that does not exist is NOT_STARTED with an unreadable scope, not a confident answer', () => {
    const r = phaseStatus(path.join(tmpDir, '.planning', 'phases', '99-nope'));
    assert.equal(r.value.status, PHASE_STATUS.NOT_STARTED);
    assert.equal(r.scope, 'unreadable');
  });

  test('property (ADR-5057 Phase 1 ratchet): phaseStatus is COMPLETE exactly when isPhaseComplete says complete', () => {
    const shapeArb = fc.integer({ min: 0, max: 3 }).chain((plans) => fc.record({
      plans: fc.constant(plans),
      summaries: fc.integer({ min: 0, max: plans }),
      verification: fc.constantFrom(null, 'passed', 'passed+stale', 'human_needed', 'human_needed+stale', 'gaps_found', 'Passed'),
      strayPlanlessSummary: fc.boolean(),
    }));
    let n = 0;
    fc.assert(fc.property(shapeArb, (shape) => {
      const dir = path.join(tmpDir, '.planning', 'phases', `07-gen-${n++}`);
      writePhase(dir, shape);
      const status = phaseStatus(dir).value.status;
      const complete = isPhaseComplete(dir).value.complete;
      assert.equal(status === PHASE_STATUS.COMPLETE, complete, JSON.stringify(shape));
      if (shape.verification !== null && shape.verification.endsWith('+stale')) {
        assert.notEqual(status, PHASE_STATUS.COMPLETE, 'positive control: stale never projects to COMPLETE');
      }
    }), { numRuns: 60 });
  });
});

// ─── #5118 (ADR-5057 :223): the ladder reads the closed VerificationStatus ──
//
// Phase 4 closes the verification vocabulary in src/verification.cts, and the
// Phase Status Module imports it in the same PR. `phaseStatusFromFacts`
// asserts `verificationStatus` against that enum when non-null — the same
// fail-where-produced rule as its own `assertPhaseStatus`. Rows V38–V40
// (#5118, ADR-5057 §3).

describe('#5118: phaseStatusFromFacts accepts exactly the closed VerificationStatus enum', () => {
  const MEMBERS = ['passed', 'gaps_found', 'human_needed', 'stale', 'missing', 'unparseable', 'phase_dir_not_found'];

  test('V38: an out-of-enum verificationStatus is a TypeError, never a silent EXECUTED', () => {
    for (const bad of ['verified', 'unknown', 'Passed', 5]) {
      assert.throws(
        () => phaseStatusFromFacts(facts({ planCount: 2, summaryCount: 2, verificationStatus: bad })),
        TypeError,
        `must refuse ${JSON.stringify(bad)}`,
      );
    }
  });

  test('V39: every enum member and null is accepted; only human_needed changes the rung (boundary: exactly the enum)', () => {
    for (const v of [...MEMBERS, null]) {
      const expected = v === 'human_needed' ? PHASE_STATUS.NEEDS_REVIEW : PHASE_STATUS.EXECUTED;
      assert.equal(
        phaseStatusFromFacts(facts({ planCount: 2, summaryCount: 2, verificationStatus: v })),
        expected,
        `verification ${JSON.stringify(v)}`,
      );
    }
  });

  test('V40: phaseStatus on a report holding an out-of-set status degrades to an unreadable scope, never COMPLETE', (t) => {
    const tmpDir = createTempProject('phase-status-5118-');
    t.after(() => cleanup(tmpDir));
    const dir = path.join(tmpDir, '.planning', 'phases', '07-thing');
    writePhase(dir, { plans: 1, summaries: 1, verification: 'verified' });
    let r = null;
    assert.doesNotThrow(() => {
      r = phaseStatus(dir);
    });
    assert.equal(r.scope, 'unreadable');
    assert.notEqual(r.value.status, PHASE_STATUS.COMPLETE);
  });
});
