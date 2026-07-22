// allow-test-rule: source-text-is-the-product (see #1961)
// Agent .md + reference .md + template .md files — their text IS what the
// runtime loads. Testing text content tests the deployed bug-taxonomy routing
// contract. The pure-JS routing-table specification below pins the key
// routing decisions (Bohrbug->SBFL; Heisenbug->!SBFL; Concurrency->checklist).
// Per CONTRIBUTING.md exception matrix. Covers epic #1957 Phase 2B (#1961).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const AGENT = path.join(ROOT, 'agents/gsd-debugger.md');
const REFERENCE = path.join(ROOT, 'gsd-core/references/debugger-bug-taxonomy.md');
const DEBUG_TEMPLATE = path.join(ROOT, 'gsd-core/templates/DEBUG.md');

// The documented routing table, as a specification. The Tier-1 source-text
// contract tests below carry the real enforcement that the reference's table
// matches this; this object pins the key routing decisions a reviewer cares
// about (the SBFL-on-flaky-skip is the load-bearing one — it's the 1B/2B seam).
const ROUTING = {
  bohrbug: {
    recommended: ['deterministic reproduction', 'SBFL', 'git bisect', 'binary search'],
    forbidden: [],
  },
  heisenbug: {
    recommended: ['record-replay', 'stability-stress', 'statistical sampling'],
    forbidden: ['SBFL'], // a flaky spectrum poisons failed(s) — SBFL must be skipped
  },
  concurrency: {
    recommended: ['atomicity', 'order', 'deadlock'],
    forbidden: [],
  },
};

describe('bug-taxonomy classification + strategy routing (#1961, epic #1957 Phase 2B)', () => {
  describe('reference extract exists and is wired in', () => {
    test('gsd-core/references/debugger-bug-taxonomy.md exists', () => {
      assert.ok(fs.existsSync(REFERENCE), 'debugger-bug-taxonomy.md reference must exist');
    });

    test('gsd-debugger.md @-includes the bug-taxonomy reference', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      assert.ok(
        content.includes('@~/.claude/gsd-core/references/debugger-bug-taxonomy.md'),
        'gsd-debugger.md must @-include the bug-taxonomy reference (from Phase 1.75 or the technique-selection table)'
      );
    });
  });

  describe('the taxonomy is documented (criterion: every session records a bug_class)', () => {
    test('reference defines the three classes', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/bohrbug/i.test(content), 'class: Bohrbug');
      assert.ok(/heisenbug|mandelbug/i.test(content), 'class: Heisenbug/Mandelbug');
      assert.ok(/concurrency/i.test(content), 'class: Concurrency');
    });

    test('DEBUG.md template Current Focus records bug_class', () => {
      const content = fs.readFileSync(DEBUG_TEMPLATE, 'utf8');
      assert.ok(/bug_class/.test(content), 'DEBUG.md Current Focus must carry a bug_class field');
    });
  });

  describe('routing is an explicit, inspectable table (criterion 4)', () => {
    // Row-scoped: parse the markdown table and assert per-row, so a substring
    // appearing in the wrong cell (e.g. SBFL only in the Heisenbug revoke
    // column) cannot satisfy the Bohrbug route assertion.

    function tableRows() {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      const rows = [];
      for (const line of content.split(/\r?\n/)) {
        if (/^\|/.test(line) && !/^\|[\s|-]+\|?$/.test(line) && (line.match(/\|/g) || []).length >= 3) {
          rows.push(line.toLowerCase());
        }
      }
      return rows;
    }

    function rowFor(cls) {
      return tableRows().find((r) => r.includes(cls.toLowerCase())) || null;
    }

    test('there is a markdown table with class + route columns', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/rout/i.test(content), 'the word route/routing must appear');
      assert.ok(/\|.*\|.*\|/m.test(content), 'there must be a markdown table (inspectable)');
      assert.ok(tableRows().length >= 3, 'routing table must have at least 3 class rows');
    });

    test('a Bohrbug row routes to reproduction + SBFL + bisection (criterion 2, row-scoped)', () => {
      const row = rowFor('bohrbug');
      assert.ok(row, 'there must be a Bohrbug row in the routing table');
      assert.ok(/reproduc/.test(row), 'Bohrbug row must include reproduction');
      assert.ok(/sbfl/.test(row), 'Bohrbug row must include SBFL (Phase 1.25, not the epic shorthand Phase 1B)');
      assert.ok(/bisect/.test(row), 'Bohrbug row must include git bisect');
    });

    test('a Heisenbug row routes to record-replay/stability and revokes SBFL (row-scoped, load-bearing 1B/2B seam)', () => {
      const row = rowFor('heisenbug');
      assert.ok(row, 'there must be a Heisenbug/Mandelbug row in the routing table');
      assert.ok(/record-replay|\brr\b|stability/.test(row),
        'Heisenbug row must include record-replay (rr) and/or stability-stress');
      assert.ok(/sbfl/.test(row), 'Heisenbug row must reference SBFL (in the revoke column)');
      assert.ok(/revoke|revocat/.test(row),
        'Heisenbug row must state SBFL is REVOKED if already run (Phase 1.25 precedes classification)');
    });

    test('a Concurrency row surfaces the atomicity/order/deadlock checklist (criterion 3, row-scoped)', () => {
      const row = rowFor('concurrency');
      assert.ok(row, 'there must be a Concurrency row in the routing table');
      assert.ok(/atomicity/.test(row), 'Concurrency row must include atomicity');
      assert.ok(/\border\b/.test(row), 'Concurrency row must include order');
      assert.ok(/deadlock/.test(row), 'Concurrency row must include deadlock');
    });
  });

  describe('supersede, not append — no technique is orphaned (criterion 4)', () => {
    test('the previously-situational techniques now have a General-lane route', () => {
      // These 6 were orphaned when the flat situation table was reframed; the
      // General lane re-homes them. Guards against the "supersede" claim
      // silently dropping them.
      const ref = fs.readFileSync(REFERENCE, 'utf8').toLowerCase();
      const previouslyOrphaned = [
        'rubber duck', 'delta debugging', 'working backwards',
        'differential', 'comment out everything', 'follow the indirection',
      ];
      for (const t of previouslyOrphaned) {
        assert.ok(
          ref.includes(t),
          `technique "${t}" must appear in the bug-taxonomy reference (General lane) — was orphaned by the reframe`
        );
      }
    });

    test('the reference states the flat menu is superseded by class-routed selection', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/replace|supersede|routed? selection|not.*append/i.test(content),
        'must state the flat menu is replaced/superseded by class-routed selection (not merely appended)');
    });
  });

  describe('routing-table specification (pins the documented decisions)', () => {
    // Honest framing: this object is a SPEC of the reference's routing table,
    // not production code. The Tier-1 source-text tests above enforce that the
    // reference's table actually matches these decisions.

    test('SBFL is recommended for Bohrbug', () => {
      assert.ok(ROUTING.bohrbug.recommended.includes('SBFL'));
      assert.ok(!ROUTING.bohrbug.forbidden.includes('SBFL'));
    });

    test('SBFL is FORBIDDEN for Heisenbug (flaky spectrum — the load-bearing 1B/2B constraint)', () => {
      assert.ok(ROUTING.heisenbug.forbidden.includes('SBFL'),
        'SBFL must not be used on a Heisenbug spectrum (poisons failed(s))');
      assert.ok(!ROUTING.heisenbug.recommended.includes('SBFL'));
    });

    test('Concurrency route includes all three of atomicity/order/deadlock', () => {
      for (const c of ['atomicity', 'order', 'deadlock']) {
        assert.ok(ROUTING.concurrency.recommended.includes(c),
          `concurrency route must include ${c}`);
      }
    });

    test('no class both recommends AND forbids the same technique (internal consistency)', () => {
      for (const cls of Object.keys(ROUTING)) {
        for (const tech of ROUTING[cls].recommended) {
          assert.ok(!ROUTING[cls].forbidden.includes(tech),
            `${cls} both recommends and forbids ${tech} (contradiction)`);
        }
      }
    });
  });
});
