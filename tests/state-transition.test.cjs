'use strict';

// Phase 1 tests for the STATE.md Transition Module (ADR-1769).
// These are characterization tests: they pin the behavior the new
// `transitionCore` / `beginPhase` API must preserve as the old
// `cmdStateBeginPhase` callback in state.cts is migrated onto it.
//
// Discipline: TDD vertical slices. One behavior → one test → minimal code → repeat.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  transitionCore,
  FIELD_CLASSIFICATION,
  getFieldClassification,
  STATE_MD_SECTIONS,
} = require('../gsd-core/bin/lib/state-transition.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');

const fixedClock = Object.freeze({
  today: () => '2026-06-27',
  nowIso: () => '2026-06-27T12:00:00.000Z',
});

const noProgress = () => null;

describe('ADR-1769 substrate: field-classification table', () => {
  const allowedSources = new Set(['body', 'disk', 'external', 'curated', 'free']);
  const allowedPreservation = new Set([
    'derive',
    'preserve-when-unchanged',
    'preserve-always',
    'preserve-if-placeholder',
    'clear',
  ]);

  test('every classified field has a { source, preservation } row with known enum values', () => {
    for (const [field, cls] of Object.entries(FIELD_CLASSIFICATION)) {
      assert.ok(
        allowedSources.has(cls.source),
        `field ${JSON.stringify(field)} has unknown source ${JSON.stringify(cls.source)}`,
      );
      assert.ok(
        allowedPreservation.has(cls.preservation),
        `field ${JSON.stringify(field)} has unknown preservation ${JSON.stringify(cls.preservation)}`,
      );
    }
  });

  test('current_phase_name is curated / preserve-always (ADR-1769 §4 — kills #1743/#1695 by construction)', () => {
    const cls = getFieldClassification('current_phase_name');
    assert.strictEqual(cls && cls.source, 'curated');
    assert.strictEqual(cls && cls.preservation, 'preserve-always');
  });

  test('progress is curated / preserve-always (ADR-1769 §4 — curated-progress ratchet)', () => {
    const cls = getFieldClassification('progress');
    assert.strictEqual(cls && cls.source, 'curated');
    assert.strictEqual(cls && cls.preservation, 'preserve-always');
  });

  test('table covers every frontmatter key emitted by buildStateFrontmatter (codex Phase 1 review)', () => {
    // Verified against src/state.cts:1633-1653 (buildStateFrontmatter emit block).
    const requiredFields = [
      'gsd_state_version',
      'milestone',
      'milestone_name',
      'current_phase',
      'current_phase_name',
      'current_plan',
      'status',
      'stopped_at',
      'paused_at',
      'last_updated',
      'last_activity',
      'last_activity_desc',
      'progress',
      'progress.total_phases',
      'progress.completed_phases',
      'progress.total_plans',
      'progress.completed_plans',
      'progress.percent',
    ];
    for (const f of requiredFields) {
      assert.ok(getFieldClassification(f) !== null,
        `frontmatter key ${JSON.stringify(f)} must have a classification row`);
    }
  });

  test('getFieldClassification returns null for unknown fields AND inherited prototype methods', () => {
    // Classic prototype-pollution guard: queries for 'toString' / 'valueOf' / '__proto__'
    // must return null, not inherited Object.prototype functions.
    assert.strictEqual(getFieldClassification('toString'), null);
    assert.strictEqual(getFieldClassification('valueOf'), null);
    assert.strictEqual(getFieldClassification('hasOwnProperty'), null);
    assert.strictEqual(getFieldClassification('__proto__'), null);
    assert.strictEqual(getFieldClassification('not-a-real-field'), null);
  });
});

describe('ADR-1769 substrate: STATE_MD_SECTIONS constants (aligned to gsd-core/templates/state.md)', () => {
  test('every section heading starts with "## "', () => {
    for (const [name, heading] of Object.entries(STATE_MD_SECTIONS)) {
      assert.ok(
        heading.startsWith('## '),
        `section ${name} heading ${JSON.stringify(heading)} must start with "## "`,
      );
    }
  });

  test('matches the six canonical top-level sections of the STATE.md template', () => {
    assert.strictEqual(STATE_MD_SECTIONS.projectReference, '## Project Reference');
    assert.strictEqual(STATE_MD_SECTIONS.currentPosition, '## Current Position');
    assert.strictEqual(STATE_MD_SECTIONS.performanceMetrics, '## Performance Metrics');
    assert.strictEqual(STATE_MD_SECTIONS.accumulatedContext, '## Accumulated Context');
    assert.strictEqual(STATE_MD_SECTIONS.deferredItems, '## Deferred Items');
    assert.strictEqual(STATE_MD_SECTIONS.sessionContinuity, '## Session Continuity');
  });
});

describe('ADR-1769 Phase 1: beginPhase transition — tracer bullet', () => {
  test('updates body Status field to "Executing Phase N" on first-time begin', () => {
    const input = [
      '# Project State',
      '',
      '**Status:** Planning',
      '',
      '## Current Position',
      '',
      'Phase: 2 — DONE',
      'Plan: —',
      'Status: Planning',
      '',
    ].join('\n');

    const result = transitionCore(
      input,
      { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 },
      { clock: fixedClock, progressProvider: noProgress },
    );

    assert.ok(result.updated.includes('Status'), `updated should include Status; got ${JSON.stringify(result.updated)}`);
    // The transition must produce a body Status field carrying "Executing Phase 3".
    // Use the same primitive the production code uses, not a source-grep.
    const bodyStatus = stateExtractField(result.content, 'Status');
    assert.ok(
      /Executing Phase\s+3\b/.test(bodyStatus || ''),
      `body Status should match /Executing Phase 3/; got ${JSON.stringify(bodyStatus)}`,
    );
  });
});

// Shared fixture for first-time begin: a clean STATE.md body where no
// "Executing Phase N" status is present yet.
function firstTimeBody() {
  return [
    '# Project State',
    '',
    '**Status:** Planning',
    '**Current Phase:** 02',
    '**Current Phase Name:** Previous Phase',
    '**Current Plan:** 02',
    '**Total Plans in Phase:** 3',
    '**Last Activity:** 2026-06-20',
    '**Last Activity Description:** previous work',
    '**Current focus:** Phase 2 — Previous Phase',
    '',
    '## Current Position',
    '',
    'Phase: 2 (Previous Phase)',
    'Plan: 2 of 3',
    'Status: Planning',
    'Last activity: 2026-06-20 — context gathered',
    '',
  ].join('\n');
}

describe('ADR-1769 Phase 1: beginPhase first-time body field updates', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock, progressProvider: noProgress };

  test('updates Current Phase to N', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Phase'), '3');
    assert.ok(result.updated.includes('Current Phase'));
  });

  test('updates Current Phase Name when phaseName is provided', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Phase Name'), 'Test Phase');
    assert.ok(result.updated.includes('Current Phase Name'));
  });

  test('sets Current Plan to 1 on first-time begin', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '1');
    assert.ok(result.updated.includes('Current Plan'));
  });

  test('updates Total Plans in Phase to planCount when provided', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '5');
    assert.ok(result.updated.includes('Total Plans in Phase'));
  });

  test('updates Last Activity to clock.today()', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
    assert.ok(result.updated.includes('Last Activity'));
  });

  test('updates Last Activity Description to "Phase N execution started"', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'Phase 3 execution started',
    );
    assert.ok(result.updated.includes('Last Activity Description'));
  });

  test('updates **Current focus:** body text line (#1104)', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    // The **Current focus:** line should now carry the new phase label.
    const focusMatch = result.content.match(/\*\*Current focus:\*\*\s*(.*)/i);
    assert.ok(focusMatch, '**Current focus:** line must still be present');
    assert.strictEqual(focusMatch[1].trim(), 'Phase 3 — Test Phase');
    assert.ok(result.updated.includes('Current focus'),
      `updated should include 'Current focus'; got ${JSON.stringify(result.updated)}`);
  });
});

// Fixture for resume: a STATE.md body where Status already contains
// "Executing Phase 3" — the #3127 idempotency guard must detect this and
// skip the first-time-only field writes.
function resumeBody() {
  return [
    '# Project State',
    '',
    '**Status:** Executing Phase 3',
    '**Current Phase:** 03',
    '**Current Phase Name:** Test Phase',
    '**Current Plan:** 02',
    '**Total Plans in Phase:** 5',
    '**Last Activity:** 2026-06-26',
    '**Last Activity Description:** mid-flight context from plan 3-02',
    '',
    '## Current Position',
    '',
    'Phase: 3 (Test Phase) — EXECUTING',
    'Plan: 2 of 5',
    'Status: Executing Phase 3',
    'Last activity: 2026-06-26 — mid-flight context',
    '',
  ].join('\n');
}

describe('ADR-1769 Phase 1: #3127 idempotency guard — resume path', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock, progressProvider: noProgress };

  test('Status is still refreshed on resume (Last Activity Date tracks execute-phase runs)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2026-06-27');
    assert.ok(result.updated.includes('Last Activity'));
  });

  test('Current Plan is NOT overwritten on resume (#3127 — preserves mid-flight plan number)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '02');
    assert.ok(!result.updated.includes('Current Plan'),
      `Current Plan must not be in updated on resume; got ${JSON.stringify(result.updated)}`);
  });

  test('Total Plans in Phase is NOT overwritten on resume', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Total Plans in Phase'), '5');
    assert.ok(!result.updated.includes('Total Plans in Phase'));
  });

  test('Last Activity Description is NOT overwritten on resume (#3127 — preserves mid-flight context)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(
      stateExtractField(result.content, 'Last Activity Description'),
      'mid-flight context from plan 3-02',
    );
    assert.ok(!result.updated.includes('Last Activity Description'));
  });

  test('Current Phase Name is NOT overwritten on resume', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Phase Name'), 'Test Phase');
    assert.ok(!result.updated.includes('Current Phase Name'));
  });
});

describe('ADR-1769 Phase 1: Current Position section mutation (first-time begin)', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock, progressProvider: noProgress };

  test('Current Position Phase line reflects the new phase (EXECUTING)', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    assert.ok(result.updated.includes('Current Position'),
      `updated should include Current Position; got ${JSON.stringify(result.updated)}`);
    // Verify by extracting Phase from the result content (covers both inline and pipe-table).
    // The transition writes "Phase: 3 (Test Phase) — EXECUTING" into ## Current Position.
    // stateExtractField returns the first match across the whole content, but the
    // **Current Phase:** frontmatter-style line is a different field, so 'Phase'
    // extraction finds the Current Position line.
    const posPhase = stateExtractField(result.content, 'Phase');
    assert.ok(
      /3.*Test Phase.*EXECUTING/.test(posPhase || ''),
      `Current Position Phase line should match /3.*Test Phase.*EXECUTING/; got ${JSON.stringify(posPhase)}`,
    );
  });

  test('Current Position Plan line shows "1 of N"', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    const posPlan = stateExtractField(result.content, 'Plan');
    assert.ok(
      /1 of 5/.test(posPlan || ''),
      `Current Position Plan line should match /1 of 5/; got ${JSON.stringify(posPlan)}`,
    );
  });

  test('Current Position Status line reflects Executing Phase N', () => {
    const result = transitionCore(firstTimeBody(), intent, deps);
    // 'Status' extraction returns the first match — which is the top-level
    // **Status:** line. The Current Position Status line is a different field
    // occurrence. Extract from the section to disambiguate.
    const { tokenizeHeadings } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
    const body = result.content;
    const hs = tokenizeHeadings(body);
    const posIdx = hs.findIndex(h => h.level === 2 && /^current\s+position$/i.test(h.text));
    assert.notStrictEqual(posIdx, -1, 'Current Position section must exist');
    // Slice the section body and look for the Status line within it.
    const h = hs[posIdx];
    const lines = body.split('\n');
    const hl = lines[h.line - 1];
    const bodyStart = h.offset + hl.length + 1;
    let bodyEnd = body.length;
    for (let j = posIdx + 1; j < hs.length; j++) {
      if (hs[j].level >= 2) { bodyEnd = hs[j].offset - 1; break; }
    }
    const sectionBody = body.slice(bodyStart, bodyEnd);
    const sectionStatus = stateExtractField(sectionBody, 'Status');
    assert.ok(
      /Executing Phase\s+3/.test(sectionStatus || ''),
      `Current Position Status line should match /Executing Phase 3/; got ${JSON.stringify(sectionStatus)}`,
    );
  });
});

describe('ADR-1769 Phase 1: Current Position section mutation (resume path)', () => {
  const intent = { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 };
  const deps = { clock: fixedClock, progressProvider: noProgress };

  test('Resume updates only the Last activity line in Current Position (preserves Plan, Phase, Status)', () => {
    const result = transitionCore(resumeBody(), intent, deps);
    assert.ok(result.updated.includes('Last activity (resume)') || result.updated.includes('Last Activity'),
      `resume should update Last activity; got ${JSON.stringify(result.updated)}`);
    // Plan line in Current Position should still say "2 of 5" (NOT reset to "1 of 5").
    const posPlan = stateExtractField(result.content, 'Plan');
    assert.ok(
      /2 of 5/.test(posPlan || ''),
      `resume should preserve Plan "2 of 5"; got ${JSON.stringify(posPlan)}`,
    );
  });
});

describe('ADR-1769 Phase 1: property tests (RULESET.TESTS.property-based-testing)', () => {
  const deps = { clock: fixedClock, progressProvider: noProgress };

  test('for any non-negative integer phaseNumber and any STATE.md body with a non-whitespace Status value, beginPhase produces content whose body Status carries "Executing Phase N"', () => {
    // Note: filters out whitespace-only statusSuffix because state-document.cjs's
    // bold stateReplaceField pattern uses greedy \s* that consumes the trailing
    // newline when the value is whitespace-only — a pre-existing bug surfaced
    // by this property test, not introduced by ADR-1769. Filed as a follow-up.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        fc.string({ minLength: 1 }).filter(s => s.trim().length > 0 && !s.includes('\u0000')),
        (phaseNum, statusSuffix) => {
          const input = `# Project State\n\n**Status:** ${statusSuffix}\n`;
          const result = transitionCore(
            input,
            { kind: 'beginPhase', phaseNumber: phaseNum, phaseName: null, planCount: null },
            deps,
          );
          const bodyStatus = stateExtractField(result.content, 'Status') || '';
          return new RegExp(`Executing Phase\\s+${phaseNum}\\b`).test(bodyStatus);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('getFieldClassification own-property lookup always returns null or a valid {source, preservation} row', () => {
    const allowedSources = new Set(['body', 'disk', 'external', 'curated', 'free']);
    const allowedPreservation = new Set([
      'derive',
      'preserve-when-unchanged',
      'preserve-always',
      'preserve-if-placeholder',
      'clear',
    ]);
    fc.assert(
      fc.property(fc.string(), (s) => {
        const cls = getFieldClassification(s);
        if (cls === null) return true;
        return allowedSources.has(cls.source) && allowedPreservation.has(cls.preservation);
      }),
      { numRuns: 200 },
    );
  });
});

describe('ADR-1769 Phase 2: advancePlan transition', () => {
  const deps = { clock: fixedClock, progressProvider: noProgress };

  test('advances Current Plan from N to N+1 (legacy format)', () => {
    const input = [
      '# Project State',
      '',
      '**Current Plan:** 02',
      '**Total Plans in Phase:** 05',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
      '## Current Position',
      '',
      'Plan: 2 of 5',
      'Status: Executing Phase 3',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
    assert.strictEqual(result.data && result.data.advanced, true);
    assert.strictEqual(result.data && result.data.current_plan, 3);
    assert.strictEqual(result.data && result.data.total_plans, 5);
  });

  test('phase-complete branch when currentPlan >= totalPlans', () => {
    const input = [
      '# Project State',
      '',
      '**Current Plan:** 05',
      '**Total Plans in Phase:** 05',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.advanced, false);
    assert.strictEqual(result.data && result.data.reason, 'last_plan');
    assert.strictEqual(result.data && result.data.status, 'ready_for_verification');
  });

  test('error when plan fields are unparseable', () => {
    const input = '# Project State\n\nNo plan fields here.\n';
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    assert.strictEqual(result.data && result.data.error, true);
    assert.deepStrictEqual(result.updated, []);
  });

  test('compound format: "Plan: 2 of 6" preserves compound shape', () => {
    const input = [
      '# Project State',
      '',
      '**Plan:** 2 of 6',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    const plan = stateExtractField(result.content, 'Plan');
    assert.ok(/3 of 6/.test(plan || ''), `Plan should be "3 of 6"; got ${JSON.stringify(plan)}`);
    assert.strictEqual(result.data && result.data.advanced, true);
  });
});

describe('ADR-1769 Phase 2: advancePlan with frontmatter (#1255 pattern — codex review)', () => {
  const deps = { clock: fixedClock, progressProvider: noProgress };

  test('advances plan correctly when STATE.md has YAML frontmatter (body Status not YAML status)', () => {
    const input = [
      '---',
      'status: Executing Phase 3',
      'current_phase: "03"',
      '---',
      '',
      '# Project State',
      '',
      '**Current Plan:** 02',
      '**Total Plans in Phase:** 05',
      '**Status:** Executing Phase 3',
      '**Last Activity:** 2026-06-26',
      '',
      '## Current Position',
      '',
      'Plan: 2 of 5',
      'Status: Executing Phase 3',
      '',
    ].join('\n');
    const result = transitionCore(input, { kind: 'advancePlan' }, deps);
    // Body Current Plan must advance to 3.
    assert.strictEqual(stateExtractField(result.content, 'Current Plan'), '3');
    // Body Status must be updated (not the YAML status key).
    const bodyStatus = stateExtractField(result.content, 'Status');
    assert.ok(
      /Ready to execute/.test(bodyStatus || ''),
      `body Status should be "Ready to execute"; got ${JSON.stringify(bodyStatus)}`,
    );
    assert.strictEqual(result.data && result.data.advanced, true);
  });
});
