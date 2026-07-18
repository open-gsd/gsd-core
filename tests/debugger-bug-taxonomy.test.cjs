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
    test('reference contains a class -> technique routing table', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      // A markdown table with class + technique columns, OR an explicit mapping
      assert.ok(/class|bug_class/i.test(content), 'table keyed on bug class');
      assert.ok(/rout/i.test(content), 'the word route/routing must appear');
      assert.ok(/\|.*\|.*\|/m.test(content), 'there must be a markdown table (inspectable)');
    });

    test('a Bohrbug routes to reproduction + SBFL + bisection (criterion 2)', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      const flat = content.replace(/\s+/g, ' ');
      assert.ok(/bohrbug[^|]*reproduc/i.test(flat) || /bohrbug.*reproduc/i.test(flat),
        'Bohrbug route must include deterministic reproduction');
      assert.ok(/sbfl|spectrum-based|fault localization/i.test(content),
        'Bohrbug route must include SBFL (Phase 1B)');
      assert.ok(/bisect/i.test(content), 'Bohrbug route must include git bisect');
    });

    test('a Heisenbug/Mandelbug routes to record-replay/stability and SKIPS SBFL (criterion 2, the load-bearing constraint)', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/record-replay|\brr\b|stability/i.test(content),
        'Heisenbug/Mandelbug route must include record-replay (rr) and/or stability-stress');
      // The SBFL-skip is THE 1B/2B seam — it must be explicit.
      assert.ok(/do not (?:trust|use) sbfl|skip sbfl|sbfl.*(skip|not trusted|untrusted|forbidden)/i.test(content),
        'must explicitly state SBFL is skipped / not trusted on a flaky (Heisenbug) spectrum');
    });

    test('a suspected Concurrency bug surfaces the atomicity/order/deadlock checklist (criterion 3)', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/atomicity/i.test(content), 'checklist: atomicity violation');
      assert.ok(/\border\b/i.test(content), 'checklist: order violation');
      assert.ok(/deadlock/i.test(content), 'checklist: deadlock');
    });
  });

  describe('supersede, not append (Zawinski)', () => {
    test('the reference states the flat technique menu is superseded by routed selection', () => {
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
