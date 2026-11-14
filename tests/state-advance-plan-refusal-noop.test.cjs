'use strict';

/**
 * #6168 — `state advance-plan` must leave STATE.md byte-identical whenever it
 * refuses or declines.
 *
 * `advancePlanCore` returned `reassemble(body)` on the `plan_position_unreadable`
 * and `ambiguous_plan_position` refusals. `reassemble` rebuilds the frontmatter
 * (re-quotes scalars, adds synced fields), so the returned document differed
 * from the input; the read-modify-write no-op guard (`modified === content`)
 * never fired and the refusal was written to disk. A refusal must be a no-op
 * whatever shape the frontmatter has.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { transitionCore } = require('../gsd-core/bin/lib/state-transition.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const deps = {
  clock: Object.freeze({
    today: () => '2026-06-27',
    localToday: () => '2026-06-27',
    nowIso: () => '2026-06-27T12:00:00.000Z',
  }),
};

// Non-canonical frontmatter: an unquoted gsd_state_version (the rebuild quotes
// it) and none of the synced fields (current_phase, last_updated, progress, ...)
// that the rebuild adds.
const NON_CANONICAL_FM = [
  '---',
  'gsd_state_version: 1.0',
  'milestone: v1.0',
  'status: executing',
  '---',
  '',
];

const REFUSALS = {
  ambiguous_position_phase: [
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1 (wave one)',
    'Phase: 1 (wave two)',
    'Plan: 2 of 5',
    'Status: Executing',
    '',
  ],
  ambiguous_plan_position: [
    '# Project State',
    '',
    '**Current Plan:** 7',
    '**Status:** Executing',
    '',
    '## Current Position',
    '',
    'Plan: 2 of 5',
    '',
  ],
  plan_position_unreadable: [
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1 (Implementation)',
    'Plan: eight',
    'Status: Executing',
    '',
  ],
};

describe('#6168 transitionCore advancePlan returns the input document on every refusal', () => {
  for (const [reason, bodyLines] of Object.entries(REFUSALS)) {
    for (const [shape, fm] of [['non-canonical', NON_CANONICAL_FM], ['no frontmatter', []]]) {
      test(`${reason} (${shape} frontmatter): content strictly equals the input`, () => {
        const input = [...fm, ...bodyLines].join('\n');
        const result = transitionCore(input, { kind: 'advancePlan' }, deps);
        assert.strictEqual(result.data && result.data.error, true);
        assert.strictEqual(
          result.data && result.data.reason,
          reason === 'plan_position_unreadable' ? undefined : reason,
        );
        assert.deepStrictEqual(result.updated, []);
        assert.strictEqual(result.content, input,
          `${reason}: a refusal must hand back the document it was given`);
      });
    }
  }
});

describe('#6168 state advance-plan CLI leaves STATE.md byte-identical on refusal', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  const writeAndRun = (content) => {
    tmpDir = createTempProject();
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, content);
    const before = fs.readFileSync(statePath);
    const result = runGsdTools('state advance-plan', tmpDir);
    const after = fs.readFileSync(statePath);
    return { result, before, after };
  };

  // The canonical form is whatever the tool itself writes: advance a readable
  // document once, then break the position line.
  const canonicalise = () => {
    const dir = createTempProject();
    try {
      const statePath = path.join(dir, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, ['# Project State', '', '## Current Position', '',
        'Phase: 1 (Implementation)', 'Plan: 1 of 5', 'Status: Executing', ''].join('\n'));
      const r = runGsdTools('state advance-plan', dir);
      assert.ok(r.success, r.error);
      return fs.readFileSync(statePath, 'utf8');
    } finally { cleanup(dir); }
  };

  for (const [reason, bodyLines] of Object.entries(REFUSALS)) {
    test(`${reason}: non-canonical frontmatter, error unchanged and file bytes identical`, () => {
      const { result, before, after } = writeAndRun([...NON_CANONICAL_FM, ...bodyLines].join('\n'));
      const out = JSON.parse(result.output);
      assert.ok(typeof out.error === 'string' || out.error === true, `expected an error payload: ${result.output}`);
      if (reason !== 'plan_position_unreadable') assert.strictEqual(out.reason, reason);
      assert.ok(before.equals(after), `${reason}: STATE.md was modified by a refusal`);
    });

    test(`${reason}: already-canonical file stays byte-identical`, () => {
      const canonical = canonicalise();
      const broken = canonical
        .replace(/^Plan: .*$/m, bodyLines.find((l) => /^Plan: /.test(l)))
        .replace(/^(Phase: .*)$/m, reason === 'ambiguous_position_phase' ? '$1\nPhase: 1 (second)' : '$1')
        .replace(/^Status: /m, reason === 'ambiguous_plan_position' ? 'Current Plan: 7\nStatus: ' : 'Status: ');
      const { result, before, after } = writeAndRun(broken);
      const out = JSON.parse(result.output);
      assert.ok(typeof out.error === 'string' || out.error === true, `expected an error payload: ${result.output}`);
      assert.ok(before.equals(after), `${reason}: canonical STATE.md was modified by a refusal`);
    });
  }

  test('plans_outstanding decline leaves STATE.md byte-identical', () => {
    tmpDir = createTempProject();
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, [...NON_CANONICAL_FM, '# Project State', '', '## Current Position', '',
      'Phase: 1 (Implementation)', 'Plan: 2 of 2', 'Status: Executing', ''].join('\n'));
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-impl');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# plan 1\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# plan 2\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# summary 1\n');
    const before = fs.readFileSync(statePath);
    const result = runGsdTools('state advance-plan', tmpDir);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.reason, 'plans_outstanding', result.output);
    assert.ok(before.equals(fs.readFileSync(statePath)), 'plans_outstanding must not write');
  });

  test('last_plan decline and a normal advance still write', () => {
    for (const [plan, expectAdvanced] of [['2 of 2', false], ['1 of 5', true]]) {
      tmpDir = createTempProject();
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, [...NON_CANONICAL_FM, '# Project State', '', '## Current Position', '',
        'Phase: 1 (Implementation)', `Plan: ${plan}`, 'Status: Executing', ''].join('\n'));
      const before = fs.readFileSync(statePath);
      const result = runGsdTools('state advance-plan', tmpDir);
      const out = JSON.parse(result.output);
      assert.strictEqual(out.advanced, expectAdvanced, result.output);
      assert.ok(!before.equals(fs.readFileSync(statePath)), `plan ${plan} must still write`);
      cleanup(tmpDir); tmpDir = null;
    }
  });
});
