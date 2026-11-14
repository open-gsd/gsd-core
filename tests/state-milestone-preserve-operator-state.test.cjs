'use strict';

/**
 * #6174 — `state milestone-switch` and `milestone complete` must not silently
 * discard operator state.
 *
 * - milestone-switch rebuilt the frontmatter from a fixed key list, so a custom
 *   key such as `team_owner` was lost. It now starts from the keys
 *   FIELD_CLASSIFICATION does not know and overwrites the reset fields.
 * - Both commands replaced the whole `## Current Position` body with the four
 *   template lines, deleting operator lines (`Blocked on:`, `Carry-over:`).
 *   Every non-template line now moves, once and in order, under
 *   `## Accumulated Context` (created when absent) and is listed in the result.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { transitionCore } = require('../gsd-core/bin/lib/state-transition.cjs');
const { sliceSection } = (() => {
  // Local section slicer for assertions: text between `## <name>` and the next `## ` heading.
  const sliceSection = (doc, name) => {
    const lines = doc.split('\n');
    const start = lines.findIndex((l) => l.replace(/\r$/, '') === `## ${name}`);
    if (start === -1) return null;
    let end = lines.length;
    let fence = false;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
      if (!fence && /^## /.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start + 1, end);
  };
  return { sliceSection };
})();
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const deps = {
  clock: Object.freeze({
    today: () => '2026-06-27',
    localToday: () => '2026-06-27',
    nowIso: () => '2026-06-27T12:00:00.000Z',
  }),
};
const SWITCH = { kind: 'milestoneSwitch', version: 'v2.0', name: 'Second' };
const COMPLETE = { kind: 'milestoneComplete', version: 'v1.0', nextMilestoneCommand: '/gsd-new-milestone' };
const INTENTS = { milestoneSwitch: SWITCH, milestoneComplete: COMPLETE };

const TEMPLATE_LINES = ['Phase: 3 (Execution)', 'Plan: 2 of 4', 'Status: Executing', 'Last activity: 2026-06-01 — worked'];

function state({ fm = ['gsd_state_version: 1.0', 'milestone: v1.0', 'team_owner: ops'], position = TEMPLATE_LINES, accumulated = ['### Decisions', '', '- keep it simple'], eol = '\n' } = {}) {
  const parts = [];
  if (fm) parts.push('---', ...fm, '---', '');
  parts.push('# Project State', '');
  if (position) parts.push('## Current Position', '', ...position, '');
  if (accumulated) parts.push('## Accumulated Context', '', ...accumulated, '');
  parts.push('## Session', '', 'Last session: 2026-06-01', '');
  return parts.join(eol);
}

const EXTRAS = ['Blocked on: vendor sign-off', 'Carry-over: plan 3-02'];
const POSITION_WITH_EXTRAS = [TEMPLATE_LINES[0], EXTRAS[0], TEMPLATE_LINES[1], TEMPLATE_LINES[2], EXTRAS[1], TEMPLATE_LINES[3]];

const positionTemplateCount = (doc) => (sliceSection(doc, 'Current Position') || [])
  .filter((l) => l.trim() !== '').length;

describe('#6174 milestoneSwitch preserves unknown frontmatter keys', () => {
  test('a custom key survives with its value and the reset fields hold the reset values', () => {
    const out = transitionCore(state(), SWITCH, deps).content;
    assert.match(out, /^team_owner: ops$/m);
    assert.match(out, /^milestone: v2\.0$/m);
    assert.match(out, /^milestone_name: Second$/m);
    assert.match(out, /^status: planning$/m);
    assert.match(out, /^last_updated: ['"]?2026-06-27T12:00:00\.000Z['"]?$/m);
    assert.match(out, /^last_activity: ['"]?2026-06-27['"]?$/m);
    assert.match(out, /^progress:\n(?: {2}.*\n)*? {2}total_phases: 0$/m);
    assert.doesNotMatch(out, /milestone: v1\.0/);
  });
});

describe('#6174 non-template Current Position lines move under Accumulated Context', () => {
  for (const [kind, intent] of Object.entries(INTENTS)) {
    describe(kind, () => {
      test('0 extra lines: no data key, no new section, Accumulated Context untouched', () => {
        const input = state();
        const result = transitionCore(input, intent, deps);
        assert.strictEqual(result.data, undefined);
        assert.deepStrictEqual(sliceSection(result.content, 'Accumulated Context'), sliceSection(input, 'Accumulated Context'));
        assert.strictEqual(positionTemplateCount(result.content), 4);
      });

      test('2 extra lines (interleaved with template lines): moved once, in order, and reported', () => {
        const result = transitionCore(state({ position: POSITION_WITH_EXTRAS }), intent, deps);
        assert.deepStrictEqual(result.data.moved_current_position_lines, EXTRAS);
        assert.strictEqual(positionTemplateCount(result.content), 4);
        const ac = sliceSection(result.content, 'Accumulated Context');
        assert.deepStrictEqual(ac.filter((l) => EXTRAS.includes(l)), EXTRAS);
        // existing Accumulated Context content is untouched, directly after the moved lines
        assert.ok(ac.includes('### Decisions') && ac.includes('- keep it simple'));
        assert.ok(ac.indexOf(EXTRAS[1]) < ac.indexOf('### Decisions'));
        for (const line of EXTRAS) assert.strictEqual(result.content.split('\n').filter((l) => l === line).length, 1);
      });

      test('1 extra line', () => {
        const result = transitionCore(state({ position: [...TEMPLATE_LINES, 'Blocked on: legal'] }), intent, deps);
        assert.deepStrictEqual(result.data.moved_current_position_lines, ['Blocked on: legal']);
        assert.strictEqual(positionTemplateCount(result.content), 4);
      });

      test('Accumulated Context absent: the section is created holding the moved lines', () => {
        const result = transitionCore(state({ position: POSITION_WITH_EXTRAS, accumulated: null }), intent, deps);
        assert.deepStrictEqual((sliceSection(result.content, 'Accumulated Context') || []).filter((l) => l.trim()), EXTRAS);
      });

      test('Current Position absent: nothing to move, no data key', () => {
        const result = transitionCore(state({ position: null }), intent, deps);
        assert.strictEqual(result.data, undefined);
        assert.strictEqual(positionTemplateCount(result.content), 4);
      });

      test('CRLF input: lines are moved once, without a stray carriage return in the result data', () => {
        const result = transitionCore(state({ position: POSITION_WITH_EXTRAS, eol: '\r\n' }), intent, deps);
        assert.deepStrictEqual(result.data.moved_current_position_lines, EXTRAS);
        for (const line of EXTRAS) {
          assert.strictEqual(result.content.split(/\r?\n/).filter((l) => l === line).length, 1);
        }
      });

      test('a fenced `##` inside Current Position does not end the section: the fenced block moves whole', () => {
        const fenced = ['```', '## not a heading', 'Phase: inside a fence', '```'];
        const result = transitionCore(state({ position: [TEMPLATE_LINES[0], ...fenced, ...TEMPLATE_LINES.slice(1), 'Blocked on: x'] }), intent, deps);
        assert.deepStrictEqual(result.data.moved_current_position_lines, [...fenced, 'Blocked on: x']);
        assert.strictEqual(positionTemplateCount(result.content), 4);
        assert.strictEqual(result.content.split('\n').filter((l) => l === '## not a heading').length, 1);
        assert.ok(result.content.includes('## Session'), 'the section after Current Position survives');
      });
    });
  }
});

describe('#6174 property: no non-template line is lost or duplicated', () => {
  const extraLine = fc.integer({ min: 0, max: 1e6 }).chain((n) => fc.constantFrom(
    `Blocked on: item ${n}`, `Carry-over: ${n}`, `- note ${n}`, `Progress: [####] ${n}`, `free text ${n}`,
  ));
  for (const [kind, intent] of Object.entries(INTENTS)) {
    test(`${kind}`, () => {
      fc.assert(fc.property(
        fc.uniqueArray(extraLine, { maxLength: 8 }),
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 8 }),
        fc.boolean(),
        (extras, slots, withAcc) => {
          const position = [...TEMPLATE_LINES];
          extras.forEach((line, i) => position.splice(Math.min(slots[i] ?? 0, position.length), 0, line));
          const result = transitionCore(state({ position, accumulated: withAcc ? ['- ctx'] : null }), intent, deps);
          const outLines = result.content.split('\n');
          for (const line of extras) assert.strictEqual(outLines.filter((l) => l === line).length, 1, `${line} lost or duplicated`);
          const moved = result.data ? result.data.moved_current_position_lines : [];
          assert.deepStrictEqual(moved, position.filter((l) => extras.includes(l)));
          assert.strictEqual(positionTemplateCount(result.content), 4);
          const ac = sliceSection(result.content, 'Accumulated Context') || [];
          assert.deepStrictEqual(ac.filter((l) => extras.includes(l)), moved);
        },
      ), { numRuns: 100 });
    });
  }
});

describe('#6174 parity: milestone-switch and milestone-complete treat these lines identically', () => {
  test('same input gives the same moved lines and the same Accumulated Context section', () => {
    const input = state({ position: POSITION_WITH_EXTRAS });
    const a = transitionCore(input, SWITCH, deps);
    const b = transitionCore(input, COMPLETE, deps);
    assert.deepStrictEqual(a.data, b.data);
    assert.deepStrictEqual(sliceSection(a.content, 'Accumulated Context'), sliceSection(b.content, 'Accumulated Context'));
  });
});

describe('#6174 CLI results', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('state milestone-switch lists the moved lines, keeps team_owner, and omits the key when nothing moved', () => {
    tmpDir = createTempProject();
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, state({ position: POSITION_WITH_EXTRAS }));
    const r = runGsdTools('state milestone-switch --milestone v2.0 --name Second', tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(out.moved_current_position_lines, EXTRAS);
    assert.strictEqual(out.switched, true);
    const written = fs.readFileSync(statePath, 'utf8');
    assert.match(written, /team_owner: ops/);
    assert.strictEqual(written.split(/\r?\n/).filter((l) => l === EXTRAS[0]).length, 1);

    fs.writeFileSync(statePath, state());
    const clean = JSON.parse(runGsdTools('state milestone-switch --milestone v3.0 --name Third', tmpDir).output);
    assert.ok(!('moved_current_position_lines' in clean));
  });

  test('milestone complete lists the moved lines in its result and moves them in STATE.md', () => {
    tmpDir = createTempProject();
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, state({ position: POSITION_WITH_EXTRAS }));
    const r = runGsdTools('milestone complete v1.0 --name One --confirm', tmpDir);
    assert.ok(r.success, r.error);
    assert.deepStrictEqual(JSON.parse(r.output).moved_current_position_lines, EXTRAS);
    const written = fs.readFileSync(statePath, 'utf8');
    assert.match(written, /team_owner: ops/);
    for (const line of EXTRAS) assert.strictEqual(written.split(/\r?\n/).filter((l) => l === line).length, 1);
    assert.deepStrictEqual(
      (sliceSection(written, 'Accumulated Context') || []).filter((l) => EXTRAS.includes(l)), EXTRAS);

    fs.writeFileSync(statePath, state());
    const clean = JSON.parse(runGsdTools('milestone complete v1.0 --name One --confirm', tmpDir).output);
    assert.ok(!('moved_current_position_lines' in clean));
  });
});
